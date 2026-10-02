import type { Message, Part } from "@opencode-ai/sdk";
import type { Step } from "@workspace/types";

// Turning an agent's messages into what the dashboard shows: each step it
// took, in words, and what it wrote. Used for every turn in a conversation,
// and for the one still running.

export interface TurnView {
  steps: Step[];
  text: string;
  cost: number;
  startedAt: number;
  ended: boolean;
}

type ToolPart = Extract<Part, { type: "tool" }>;

function shortPath(path: unknown, root: string): string {
  const p = String(path ?? "");
  return p.startsWith(root) ? p.slice(root.length).replace(/^\/+/, "") || "." : p;
}

function describe(part: ToolPart, root: string): { label: string; detail: string } {
  const input = (part.state as { input?: Record<string, unknown> }).input ?? {};
  switch (part.tool) {
    case "read":
      return { label: "Reading", detail: shortPath(input.filePath, root) };
    case "grep":
      return { label: "Searching for", detail: String(input.pattern ?? "") };
    case "glob":
      return { label: "Listing", detail: String(input.pattern ?? "") };
    case "list":
      return { label: "Listing", detail: shortPath(input.path, root) };
    case "edit":
      return { label: "Editing", detail: shortPath(input.filePath, root) };
    case "write":
      return { label: "Writing", detail: shortPath(input.filePath, root) };
    case "apply_patch":
    case "patch":
      return { label: "Applying a patch", detail: "" };
    case "todowrite":
      return { label: "Updating its plan", detail: "" };
    case "grain-db_sql_query":
      return { label: "Querying the database", detail: String(input.sql ?? "") };
    case "grain-db_list_tables":
      return { label: "Listing database tables", detail: "" };
    case "grain-db_describe_table":
      return { label: "Describing table", detail: String(input.table ?? "") };
    case "support_start_fix":
      return { label: "Starting a fix", detail: Array.isArray(input.repos) && input.repos.length ? input.repos.join(", ") : "" };
    case "support_revise_fix":
      return { label: "Asking the fix agent for changes", detail: "" };
    case "support_get_fix":
      return { label: "Reading the fix", detail: "" };
    case "support_propose_pr":
      return { label: "Proposing a pull request", detail: String(input.title ?? "") };
    default:
      return { label: part.tool, detail: "" };
  }
}

/** The assistant messages answering one message, as steps and text. */
export function viewTurn(replies: { info: Message; parts: Part[] }[], root: string, startedAt: number): TurnView {
  const steps: Step[] = [];
  const texts: string[] = [];
  let cost = 0;
  let ended = false;
  for (const { info, parts } of replies) {
    if (info.role !== "assistant") continue;
    cost += info.cost ?? 0;
    ended = Boolean(info.error) || Boolean(info.time.completed && info.finish && info.finish !== "tool-calls");
    for (const part of parts) {
      if (part.type === "tool") {
        const status = part.state.status;
        steps.push({
          tool: part.tool,
          ...describe(part, root),
          state: status === "completed" ? "done" : status === "error" ? "failed" : "running",
        });
      } else if (part.type === "text" && part.text.trim()) {
        texts.push(part.text.trim());
      }
    }
  }
  return { steps, text: texts.join("\n\n"), cost, startedAt, ended };
}

/** A one-line summary of a finished turn's steps, like "read 14 files, ran 2 queries". */
export function summarize(steps: Step[]): string {
  const count = (pred: (s: Step) => boolean) => steps.filter(pred).length;
  const parts: [number, string, string][] = [
    [count((s) => s.tool === "read"), "read 1 file", "read %d files"],
    [count((s) => s.tool === "grep" || s.tool === "glob" || s.tool === "list"), "searched once", "searched %d times"],
    [count((s) => s.tool.startsWith("grain-db_")), "ran 1 query", "ran %d queries"],
    [count((s) => s.tool === "edit" || s.tool === "write" || s.tool === "apply_patch" || s.tool === "patch"), "made 1 edit", "made %d edits"],
    [count((s) => s.tool === "support_start_fix"), "started a fix", "started %d fixes"],
    [count((s) => s.tool === "support_revise_fix"), "asked for changes to the fix", "asked for changes %d times"],
    [count((s) => s.tool === "support_get_fix"), "read the fix", "read the fix %d times"],
    [count((s) => s.tool === "support_propose_pr"), "proposed a pull request", "proposed a pull request %d times"],
  ];
  const known = parts.reduce((sum, [n]) => sum + n, 0);
  const other = steps.length - known;
  return [
    ...parts.filter(([n]) => n > 0).map(([n, one, many]) => (n === 1 ? one : many.replace("%d", String(n)))),
    ...(other > 0 ? [other === 1 ? "1 other step" : `${other} other steps`] : []),
  ].join(", ");
}
