import type { Part } from "@opencode-ai/sdk";
import { transcript } from "./opencode.ts";

// What an agent is doing right now, read from its opencode session: every step
// of the current turn, the text it has written so far, how long it has been
// going and what it has cost. The dashboard polls this while something runs.

export interface Step {
  label: string;
  detail: string;
  state: "running" | "done" | "failed";
}

export interface Activity {
  steps: Step[];
  text: string;
  startedAt: number;
  cost: number;
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
    default:
      return { label: part.tool, detail: "" };
  }
}

/** The latest turn of a session: everything since the last message a person (or the dashboard) sent. */
export async function activity(sessionId: string, directory: string): Promise<Activity | undefined> {
  const messages = await transcript(sessionId, directory).catch(() => []);
  let lastUser = -1;
  messages.forEach((m, i) => {
    if (m.info.role === "user") lastUser = i;
  });
  if (lastUser < 0) return undefined;

  const turn = messages.slice(lastUser + 1);
  const steps: Step[] = [];
  let text = "";
  let cost = 0;
  for (const { info, parts } of turn) {
    if (info.role === "assistant") cost += info.cost ?? 0;
    for (const part of parts) {
      if (part.type === "tool") {
        const status = part.state.status;
        steps.push({
          ...describe(part, directory),
          state: status === "completed" ? "done" : status === "error" ? "failed" : "running",
        });
      } else if (part.type === "text") {
        text = part.text;
      }
    }
  }
  return { steps, text, startedAt: messages[lastUser].info.time.created, cost };
}
