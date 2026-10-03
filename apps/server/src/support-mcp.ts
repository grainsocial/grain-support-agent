import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { config } from "./config.ts";
import { fixDiffs, fixRepos, reviseFix, startFix } from "./fix.ts";
import { act, actionable, configured as moderationConfigured, labelNames } from "./moderate.ts";
import { get, update, type Item } from "./store.ts";
import { clefConfigured, fixTargets, preselect } from "./triage.ts";
import { activeTurn } from "./turns.ts";

// The tools that let the agent you talk to act on its item: start a fix, ask
// for changes to it, read its diff, put a pull request up for approval, and
// act on a report's subject.
// Served over HTTP on localhost to the opencode server, which runs them for
// the `investigate` agent only.
//
// A tool call does not say which session made it, so each takes the item
// number and is refused unless that item's agent is mid-turn right now. And
// starting or changing a fix is refused unless a person started the turn: the
// agent cannot set fixes going on its own after reading a post, or keep
// revising its own work in a loop.

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const refuse = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

function itemFor(id: number, needsPerson: boolean): Item | string {
  const item = get(id);
  if (!item) return `there is no item #${id}`;
  const turn = activeTurn(id);
  if (!turn) return `item #${id} is not the one you are working on`;
  if (needsPerson && turn !== "person") {
    return "only the maintainer can ask for this; tell them what you would do and let them decide";
  }
  return item;
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "support", version: "1.0.0" });
  const knownRepos = config.repos.map((r) => r.name);

  server.registerTool(
    "start_fix",
    {
      description: `Hand the problem to the fix agent, which edits the code in a branch of its own. Call this only when the maintainer asks for a fix. It returns at once; you will get an [event] message when the fix is done. The fix agent sees your instructions and your report, not this conversation, so put everything it needs to know in the instructions. Repositories: ${knownRepos.join(", ")}. Leave repos empty to use the ones the report points at.`,
      inputSchema: {
        item: z.number().int(),
        instructions: z.string().describe("What to change and any constraints the maintainer gave."),
        repos: z.array(z.string()).optional(),
      },
    },
    async ({ item: id, instructions, repos }) => {
      const item = itemFor(id, true);
      if (typeof item === "string") return refuse(item);
      if (item.fix_status === "working") return refuse("a fix is already running; use revise_fix once it finishes");
      // A new fix replaces the old one, its branch and its pull request link.
      // Only on purpose: the maintainer discards the old fix first.
      if (item.fix_status === "ready" || item.fix_status === "pr_open") {
        return refuse(
          "there is already a fix for this item; use revise_fix to change it. To start over, the maintainer has to discard it first.",
        );
      }
      let chosen = (repos ?? []).filter((r) => knownRepos.includes(r));
      if (!chosen.length) {
        let targets: Record<string, number> = item.fix_targets ? JSON.parse(item.fix_targets) : {};
        if (!Object.keys(targets).length && item.report && clefConfigured()) {
          targets = await fixTargets(item.report, knownRepos).catch(() => ({}));
          if (Object.keys(targets).length) update(item.id, { fix_targets: JSON.stringify(targets) });
        }
        chosen = Object.keys(targets).length ? preselect(targets) : ["grain"];
      }
      startFix(item, chosen, instructions).catch(console.error);
      return text(`The fix agent is working in ${chosen.join(", ")}. You will get an [event] message when it is done.`);
    },
  );

  server.registerTool(
    "revise_fix",
    {
      description: "Ask the fix agent to change the fix it made. Call this only when the maintainer asks for changes. Returns at once; you will get an [event] message when it is done.",
      inputSchema: { item: z.number().int(), request: z.string() },
    },
    async ({ item: id, request }) => {
      const item = itemFor(id, true);
      if (typeof item === "string") return refuse(item);
      if (!item.fix_session_id) return refuse("there is no fix yet; use start_fix");
      if (item.fix_status === "working") return refuse("the fix agent is still working");
      reviseFix(item, request).catch(console.error);
      return text("The fix agent is making the change. You will get an [event] message when it is done.");
    },
  );

  server.registerTool(
    "get_fix",
    {
      description: "The current fix: its state, what the fix agent said, and the diff in each repository it changed.",
      inputSchema: { item: z.number().int() },
    },
    async ({ item: id }) => {
      const item = itemFor(id, false);
      if (typeof item === "string") return refuse(item);
      if (!item.fix_status) return text("There is no fix for this item.");
      const diffs = await fixDiffs(item);
      const body = diffs.map((d) => `### ${d.repo}\n${d.stat}\n${d.diff.slice(0, 40_000)}`).join("\n\n");
      return text(
        `State: ${item.fix_status}${item.fix_error ? ` (${item.fix_error})` : ""}\nRepositories: ${fixRepos(item).join(", ")}\n\nThe fix agent said:\n${item.fix_summary}\n\n${body || "No changes."}`,
      );
    },
  );

  server.registerTool(
    "propose_pr",
    {
      description: "Put the fix up for the maintainer's approval as a draft pull request, with a title and description. This does not open anything: the maintainer sees the diff and the text and decides. Do not include handles, DIDs, record URIs or query results in the description.",
      inputSchema: { item: z.number().int(), title: z.string(), description: z.string() },
    },
    async ({ item: id, title, description }) => {
      const item = itemFor(id, false);
      if (typeof item === "string") return refuse(item);
      if (item.fix_status !== "ready" && item.fix_status !== "pr_open") return refuse("there is no finished fix to propose");
      update(item.id, { fix_title: title, fix_body: description });
      return text("The maintainer can now see the pull request for approval.");
    },
  );

  server.registerTool(
    "moderate",
    {
      description:
        "Act on this report's subject, on the maintainer's word only: dismiss the report, label the subject, or take the account down. It acts on the subject this item is about and nothing else. dismiss and label happen at once; takedown puts a confirm button in front of the maintainer and happens only when they press it. Every open report on the subject is closed either way.",
      inputSchema: {
        item: z.number().int(),
        action: z.enum(["dismiss", "label", "takedown"]),
        label: z.string().optional().describe("For label: which label. Leave it out otherwise."),
        reason: z.string().describe("One sentence on why, in your words, for the maintainer."),
      },
    },
    async ({ item: id, action, label, reason }) => {
      const item = itemFor(id, true);
      if (typeof item === "string") return refuse(item);
      if (!moderationConfigured()) return refuse("acting on reports is not configured here; the maintainer has to use grain's /admin");
      const why = actionable(item);
      if (why) return refuse(why);

      if (action === "label") {
        const names = await labelNames().catch(() => null);
        if (!names) return refuse("could not read the appview's labels; try again shortly");
        if (!label || !names.includes(label)) return refuse(`label must be one of: ${names.join(", ")}`);
      } else if (label) {
        label = undefined;
      }

      if (action === "takedown") {
        update(item.id, { moderation_pending: JSON.stringify({ action, reason }) });
        return text("The maintainer now sees a button to confirm the takedown. Nothing has happened yet; tell them so.");
      }
      try {
        await act(item, { action, label, reason });
      } catch (err) {
        return refuse(`the appview refused: ${err instanceof Error ? err.message : String(err)}`);
      }
      return text(
        action === "dismiss"
          ? "Dismissed. Every open report on the subject is closed and the item is done."
          : `Labelled ${label}. Every open report on the subject is closed and the item is done.`,
      );
    },
  );

  return server;
}

export function startSupportMcp(): void {
  createServer(async (req, res) => {
    if (req.url !== "/mcp") {
      res.writeHead(404);
      return res.end();
    }
    // Stateless: a fresh server and transport per request.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }).listen(config.supportMcpPort, "127.0.0.1");
}
