import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import MarkdownIt from "markdown-it";
import { config } from "./config.ts";
import { canOpenPr, defaultRepo, discardFix, fixDiff, openPr, reviseFix, startFix } from "./fix.ts";
import { followUp } from "./investigate.ts";
import { transcript } from "./opencode.ts";
import { addCost, counts, get, list, recordFeedback, update, type Item, type Status } from "./store.ts";
import { AREAS, KINDS, PLATFORMS } from "./triage.ts";
import { workspace } from "./workspace.ts";

// The dashboard. Server-rendered HTML, no client JavaScript. It has no login of
// its own: Caddy puts basic auth in front of it, and inside the compose network
// nothing else talks to it.

const VIEWS: Record<string, { label: string; statuses: Status[] }> = {
  inbox: { label: "Needs you", statuses: ["needs_review", "reported", "failed"] },
  working: { label: "In progress", statuses: ["new", "investigate", "investigating"] },
  triaged: { label: "Triaged", statuses: ["triaged"] },
  done: { label: "Done", statuses: ["done"] },
  dismissed: { label: "Dismissed", statuses: ["dismissed"] },
};

// Reports are written by a model that has read untrusted text, so they render
// with raw HTML off and images disabled: an image URL in a report would be
// fetched the moment the page opens, which is how a prompt injection would
// carry data out. Links stay, since nothing follows a link until it is clicked.
const markdown = new MarkdownIt({ html: false, linkify: true }).disable("image");
const defaultLink = markdown.renderer.rules.link_open ?? ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));
markdown.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  tokens[i].attrSet("rel", "noopener noreferrer nofollow");
  tokens[i].attrSet("target", "_blank");
  return defaultLink(tokens, i, opts, env, self);
};

export const renderReport = (report: string) => markdown.render(report);

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string, refresh = false): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">${refresh ? '\n<meta http-equiv="refresh" content="5">' : ""}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root {
  --bg: #fafaf9; --surface: #ffffff; --text: #1c1917; --muted: #78716c;
  --border: #e7e5e4; --accent: #2563eb; --warn: #b45309; --bad: #b91c1c; --ok: #15803d;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0a09; --surface: #1c1917; --text: #f5f5f4; --muted: #a8a29e;
    --border: #292524; --accent: #60a5fa; --warn: #f59e0b; --bad: #f87171; --ok: #4ade80;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
a { color: var(--accent); }
h1 { font-size: 20px; margin: 0 0 16px; }
nav { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 16px; }
nav a { padding: 6px 12px; border-radius: 6px; text-decoration: none; color: var(--muted); }
nav a.on { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; }
.row { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; flex-wrap: wrap; }
.meta { color: var(--muted); font-size: 13px; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; }
.pill { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
.pill.bug, .pill.failed { color: var(--bad); border-color: currentColor; }
.pill.reported, .pill.investigating { color: var(--accent); border-color: currentColor; }
.pill.needs_review { color: var(--warn); border-color: currentColor; }
.markdown { overflow-wrap: anywhere; }
.markdown h1, .markdown h2, .markdown h3 { font-size: 15px; margin: 20px 0 6px; }
.markdown > :first-child { margin-top: 0; }
.markdown p, .markdown ul, .markdown ol { margin: 0 0 10px; }
.markdown ul, .markdown ol { padding-left: 22px; }
.markdown code { font: 13px ui-monospace, monospace; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
.markdown pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; overflow-x: auto; }
.markdown pre code { border: 0; padding: 0; background: none; }
.markdown table { display: block; overflow-x: auto; margin-bottom: 10px; }
.markdown th, .markdown td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
.markdown blockquote { margin: 0 0 10px; padding-left: 12px; border-left: 3px solid var(--border); color: var(--muted); }
.turn { border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; }
.turn .who { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.tools { font-size: 13px; color: var(--muted); margin: 4px 0 8px; }
.tools summary { cursor: pointer; }
.tools li { font-family: ui-monospace, monospace; font-size: 12px; overflow-wrap: anywhere; }
textarea, input[type=text] { font: inherit; width: 100%; padding: 8px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--text); }
textarea { min-height: 72px; resize: vertical; }
form.stack { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
form.stack .actions { margin-top: 0; }
.diff { font: 12px/1.45 ui-monospace, monospace; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 0; overflow-x: auto; white-space: pre; }
.diff span { display: block; padding: 0 12px; }
.diff .add { background: color-mix(in srgb, var(--ok) 14%, transparent); }
.diff .del { background: color-mix(in srgb, var(--bad) 14%, transparent); }
.diff .hunk { color: var(--accent); }
.diff .file { font-weight: 600; }
h2.section { font-size: 16px; margin: 0 0 8px; }
.report { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.55 ui-monospace, monospace; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; overflow-x: auto; }
table { border-collapse: collapse; font-size: 14px; }
td { padding: 2px 12px 2px 0; }
form { display: inline; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
button, select { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
img { max-width: 160px; max-height: 160px; border-radius: 6px; margin: 8px 8px 0 0; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function card(item: Item): string {
  const t = item.triage;
  return `<div class="card">
  <div class="row">
    <a href="/item/${item.id}"><strong>#${item.id}</strong> ${esc(item.source === "bluesky" ? `@${item.author}` : "In-app report")}</a>
    <span>
      ${t ? `<span class="pill ${esc(t.kind)}">${esc(t.kind)}</span> <span class="pill">${esc(t.area)}</span>${t.platform !== "unknown" ? ` <span class="pill">${esc(t.platform)}</span>` : ""}` : ""}
      <span class="pill ${esc(item.status)}">${esc(item.status.replace("_", " "))}</span>
    </span>
  </div>
  <p class="text">${esc(item.text.slice(0, 280))}${item.text.length > 280 ? "…" : ""}</p>
  <div class="meta">${esc(new Date(item.received_at).toLocaleString("en-US", { timeZone: "UTC" }))} UTC${item.route_reason ? ` · ${esc(item.route_reason)}` : ""}</div>
</div>`;
}

function dashboard(view: string): string {
  const v = VIEWS[view] ?? VIEWS.inbox;
  const n = counts();
  const tabs = Object.entries(VIEWS)
    .map(([key, { label, statuses }]) => {
      const total = statuses.reduce((sum, s) => sum + (n[s] ?? 0), 0);
      return `<a href="/?view=${key}" class="${v === VIEWS[key] ? "on" : ""}">${label} (${total})</a>`;
    })
    .join("");
  const items = list(v.statuses);
  return page(
    "grain support",
    `<h1>grain support</h1><nav>${tabs}</nav>${items.length ? items.map(card).join("") : `<p class="meta">Nothing here.</p>`}`,
  );
}

function options(choices: Record<string, string>, selected: string | undefined): string {
  return Object.keys(choices)
    .map((k) => `<option value="${k}"${k === selected ? " selected" : ""}>${k.replace("_", " ")}</option>`)
    .join("");
}

// Follow-up questions run in the background; these say which items have one
// running and what went wrong with the last one.
const chatting = new Set<number>();
const chatErrors = new Map<number, string>();

function toolLine(part: { tool?: string; state?: { input?: Record<string, unknown>; status?: string } }): string {
  const input = part.state?.input ?? {};
  const arg = input.filePath ?? input.pattern ?? input.sql ?? input.table ?? input.path ?? "";
  const failed = part.state?.status === "error" ? " (refused or failed)" : "";
  return `<li>${esc(part.tool)} ${esc(String(arg).slice(0, 300))}${failed}</li>`;
}

/** The conversation after the first exchange, which is the investigation and its report. */
async function conversation(item: Item): Promise<string> {
  if (!item.session_id) return "";
  const messages = await transcript(item.session_id, workspace).catch(() => []);
  const firstReply = messages.findIndex((m) => m.info.role === "assistant");
  // Skip the investigation prompt and every assistant message that answered it.
  const secondUser = messages.findIndex((m, i) => i > firstReply && m.info.role === "user");
  if (secondUser < 0) return "";
  return messages
    .slice(secondUser)
    .map(({ info, parts }) => {
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => ("text" in p ? p.text : ""))
        .join("\n")
        .trim();
      const tools = parts.filter((p) => p.type === "tool");
      if (info.role === "user") {
        return `<div class="turn"><div class="who">You</div><p class="text" style="margin:0">${esc(text)}</p></div>`;
      }
      return `<div class="turn"><div class="who">Agent</div>
        ${tools.length ? `<details class="tools"><summary>${tools.length} tool call${tools.length === 1 ? "" : "s"}</summary><ul>${tools.map((t) => toolLine(t as never)).join("")}</ul></details>` : ""}
        ${text ? `<div class="markdown">${renderReport(text)}</div>` : ""}</div>`;
    })
    .join("");
}

function renderDiff(diff: string): string {
  const lines = diff.split("\n").map((line) => {
    const cls = line.startsWith("diff --git")
      ? "file"
      : line.startsWith("@@")
        ? "hunk"
        : line.startsWith("+") && !line.startsWith("+++")
          ? "add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "del"
            : "";
    return `<span${cls ? ` class="${cls}"` : ""}>${esc(line) || " "}</span>`;
  });
  return `<div class="diff">${lines.join("")}</div>`;
}

function repoOptions(selected: string): string {
  return config.repos
    .map((r) => `<option value="${esc(r.name)}"${r.name === selected ? " selected" : ""}>${esc(r.name)}</option>`)
    .join("");
}

async function fixPanel(item: Item): Promise<string> {
  if (!item.report) return "";
  const start = (label: string) => `<form method="post" action="/item/${item.id}/fix" class="stack">
      <label class="meta" for="repo">Repository</label>
      <select name="repo" id="repo">${repoOptions(item.fix_repo || defaultRepo(item))}</select>
      <label class="meta" for="instructions">Instructions for the fix agent (optional)</label>
      <textarea name="instructions" id="instructions" placeholder="For example: go with the second candidate cause, and keep the API unchanged"></textarea>
      <div class="actions"><button class="primary">${label}</button></div>
    </form>`;

  if (!item.fix_status) {
    return `<div class="card"><h2 class="section">Fix</h2>
      <p class="meta" style="margin:0">The fix agent edits one repository on a branch of its own. It cannot run commands or see production data. Nothing is pushed until you approve the diff.</p>
      ${start("Work on a fix")}</div>`;
  }
  if (item.fix_status === "working") {
    return `<div class="card"><h2 class="section">Fix</h2><p class="meta">The fix agent is working in ${esc(item.fix_repo)} on <code>${esc(item.fix_branch)}</code>. This page refreshes on its own.</p></div>`;
  }

  const discard = `<form method="post" action="/item/${item.id}/discard_fix"><button>Discard fix</button></form>`;
  if (item.fix_status === "failed") {
    return `<div class="card"><h2 class="section" style="color:var(--bad)">Fix failed</h2>
      <div class="report">${esc(item.fix_error)}</div>${start("Try again")}<div class="actions">${discard}</div></div>`;
  }

  const { stat, diff } = await fixDiff(item);
  const pr = canOpenPr(item.fix_repo)
    ? `<form method="post" action="/item/${item.id}/pr" class="stack">
        <label class="meta" for="title">Pull request title</label>
        <input type="text" name="title" id="title" value="${esc(item.fix_title)}" required>
        <label class="meta" for="body">Description</label>
        <textarea name="body" id="body" style="min-height:160px">${esc(item.fix_body)}</textarea>
        <div class="actions"><button class="primary"${diff ? "" : " disabled"}>${item.fix_pr_url ? "Push update to the pull request" : "Open draft pull request"}</button>${discard}</div>
      </form>`
    : `<div class="actions"><a href="/item/${item.id}/fix.patch"><button type="button" class="primary">Download patch</button></a>${discard}</div>
       <p class="meta">${esc(item.fix_repo)} is not on GitHub, so this fix leaves as a patch: <code>git apply</code> it in a checkout.</p>`;

  return `<div class="card"><div class="row"><h2 class="section">Fix in ${esc(item.fix_repo)}</h2>
      <span class="meta"><code>${esc(item.fix_branch)}</code></span></div>
    ${item.fix_pr_url ? `<p>Draft pull request: <a href="${esc(item.fix_pr_url)}">${esc(item.fix_pr_url)}</a></p>` : ""}
    ${item.fix_summary ? `<details><summary class="meta">What the agent said</summary><div class="markdown">${renderReport(item.fix_summary)}</div></details>` : ""}
    <h3 style="font-size:14px;margin:16px 0 6px">Changes</h3>
    ${diff ? `<pre class="meta" style="margin:0 0 8px;white-space:pre-wrap">${esc(stat.trim())}</pre>${renderDiff(diff)}` : `<p class="meta">The agent made no changes.</p>`}
    <form method="post" action="/item/${item.id}/revise" class="stack">
      <label class="meta" for="request">Ask for changes</label>
      <textarea name="request" id="request" placeholder="For example: also handle the empty gallery case"></textarea>
      <div class="actions"><button>Send to the fix agent</button></div>
    </form>
    ${pr}
  </div>`;
}

async function detail(item: Item): Promise<string> {
  const t = item.triage;
  const triage = t
    ? `<table>
        <tr><td class="meta">About grain</td><td>${(t.relevant * 100).toFixed(0)}%</td></tr>
        <tr><td class="meta">Kind</td><td>${esc(t.kind)} (${(t.kindConfidence * 100).toFixed(0)}% confident)</td></tr>
        <tr><td class="meta">Area</td><td>${esc(t.area)}</td></tr>
        <tr><td class="meta">Platform</td><td>${esc(t.platform)}</td></tr>
        <tr><td class="meta">Severity</td><td>${t.severity.toFixed(1)} of 3</td></tr>
        <tr><td class="meta">Expects a reply</td><td>${(t.needsReply * 100).toFixed(0)}%</td></tr>
      </table>
      <form method="post" action="/item/${item.id}/correct" class="actions">
        <select name="kind">${options(KINDS, t.kind)}</select>
        <select name="area">${options(AREAS, t.area)}</select>
        <select name="platform">${options(PLATFORMS, t.platform)}</select>
        <button>Correct triage</button>
      </form>`
    : `<p class="meta">Not triaged yet.</p>`;

  const action = (name: string, label: string, primary = false) =>
    `<form method="post" action="/item/${item.id}/${name}"><button${primary ? ' class="primary"' : ""}>${label}</button></form>`;

  const busy = item.status === "investigating" || chatting.has(item.id) || item.fix_status === "working";
  const chatError = chatErrors.get(item.id);
  const followUpForm = item.report
    ? `<form method="post" action="/item/${item.id}/chat" class="stack">
        <label class="meta" for="message">Ask a follow-up</label>
        <textarea name="message" id="message" placeholder="For example: does this also affect iOS? How many users hit it this week?"${chatting.has(item.id) ? " disabled" : ""}></textarea>
        <div class="actions"><button${chatting.has(item.id) ? " disabled" : ""}>${chatting.has(item.id) ? "The agent is answering" : "Ask"}</button></div>
      </form>`
    : "";

  return page(
    `#${item.id} grain support`,
    `<p><a href="/">Back to the queue</a></p>
<div class="card">
  <div class="row">
    <strong>#${item.id} ${esc(item.source === "bluesky" ? `@${item.author}` : `Report by ${item.author}`)}</strong>
    <span class="pill ${esc(item.status)}">${esc(item.status.replace("_", " "))}</span>
  </div>
  <p class="text">${esc(item.text)}</p>
  ${item.images.map((src) => `<a href="${esc(src)}"><img src="${esc(src)}" alt="Attached image"></a>`).join("")}
  <div class="meta"><a href="${esc(item.url)}">${esc(item.url)}</a></div>
  <div class="actions">
    ${item.status !== "investigating" ? action("investigate", item.report ? "Investigate again" : "Investigate", !item.report) : ""}
    ${item.status !== "done" ? action("done", "Mark done") : ""}
    ${item.status !== "dismissed" ? action("dismiss", "Dismiss") : ""}
  </div>
</div>
<div class="card"><h2 class="section">Triage</h2>${triage}
  ${item.route_reason ? `<p class="meta">Routed: ${esc(item.route_reason)}</p>` : ""}</div>
${item.error ? `<div class="card"><h2 class="section" style="color:var(--bad)">Error</h2><div class="report">${esc(item.error)}</div></div>` : ""}
${
  item.report || item.status === "investigating"
    ? `<div class="card"><div class="row"><h2 class="section">Investigation</h2>
        <span class="meta">${item.cost ? `$${item.cost.toFixed(4)} so far` : ""}</span></div>
        ${item.report ? `<div class="markdown">${renderReport(item.report)}</div>` : `<p class="meta">Running. This page refreshes on its own.</p>`}
        ${await conversation(item)}
        ${chatting.has(item.id) ? `<p class="meta">The agent is working on your question.</p>` : ""}
        ${chatError ? `<p style="color:var(--bad)">${esc(chatError)}</p>` : ""}
        ${followUpForm}</div>`
    : ""
}
${await fixPanel(item)}`,
    busy,
  );
}

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 200_000) break;
  }
  return new URLSearchParams(body);
}

// Basic auth is something the browser sends with any request to this origin,
// including a form posted from another site. Refuse cross-site writes.
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return false;
  return true;
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" });
  res.end(html);
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(303, { location: to });
  res.end();
}

export function startWeb(port: number, onInvestigate: () => void): void {
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/_health") return send(res, 200, "ok");
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, dashboard(url.searchParams.get("view") ?? "inbox"));

      const match = url.pathname.match(/^\/item\/(\d+)(?:\/([\w.]+))?$/);
      const item = match ? get(Number(match[1])) : undefined;
      if (!match || !item) return send(res, 404, page("Not found", "<p>Not found.</p>"));

      if (req.method === "GET" && !match[2]) return send(res, 200, await detail(item));
      if (req.method === "GET" && match[2] === "fix.patch" && item.fix_repo) {
        const { diff } = await fixDiff(item);
        res.writeHead(200, {
          "content-type": "text/x-diff; charset=utf-8",
          "content-disposition": `attachment; filename="${item.fix_repo}-${item.id}.patch"`,
        });
        return res.end(diff);
      }
      if (req.method !== "POST" || !sameOrigin(req)) return send(res, 403, page("Refused", "<p>Refused.</p>"));

      switch (match[2]) {
        case "investigate":
          update(item.id, { status: "investigate", error: "" });
          onInvestigate();
          break;
        case "done":
          update(item.id, { status: "done" });
          break;
        case "dismiss":
          update(item.id, { status: "dismissed", route_reason: "dismissed by hand" });
          break;
        case "correct": {
          const fields = await form(req);
          if (!item.triage) break;
          const triage = { ...item.triage };
          for (const [field, allowed] of [["kind", KINDS], ["area", AREAS], ["platform", PLATFORMS]] as const) {
            const value = fields.get(field);
            if (value && value in allowed && value !== triage[field]) {
              recordFeedback(item.id, field, triage[field], value);
              triage[field] = value;
            }
          }
          update(item.id, { triage });
          break;
        }
        case "chat": {
          const message = (await form(req)).get("message")?.trim();
          if (!message || chatting.has(item.id)) break;
          chatting.add(item.id);
          chatErrors.delete(item.id);
          followUp(item, message)
            .then(({ cost }) => addCost(item.id, cost))
            .catch((err) => chatErrors.set(item.id, err instanceof Error ? err.message : String(err)))
            .finally(() => chatting.delete(item.id));
          break;
        }
        case "fix": {
          if (item.fix_status === "working" || !item.report) break;
          const fields = await form(req);
          startFix(item, fields.get("repo") ?? defaultRepo(item), fields.get("instructions") ?? "").catch(console.error);
          break;
        }
        case "revise": {
          const request = (await form(req)).get("request")?.trim();
          if (!request || item.fix_status === "working") break;
          reviseFix(item, request).catch(console.error);
          break;
        }
        case "pr": {
          const fields = await form(req);
          try {
            await openPr(item, fields.get("title") ?? "", fields.get("body") ?? "");
          } catch (err) {
            update(item.id, { fix_error: err instanceof Error ? err.message : String(err) });
            return send(res, 502, page("Pull request failed", `<p>${esc(err instanceof Error ? err.message : err)}</p><p><a href="/item/${item.id}">Back</a></p>`));
          }
          break;
        }
        case "discard_fix":
          if (item.fix_status !== "working") await discardFix(item);
          break;
        default:
          return send(res, 404, page("Not found", "<p>Not found.</p>"));
      }
      redirect(res, `/item/${item.id}`);
    } catch (err) {
      console.error(err);
      send(res, 500, page("Error", `<p>${esc(err instanceof Error ? err.message : err)}</p>`));
    }
  }).listen(port, () => console.log(`dashboard on :${port}`));
}
