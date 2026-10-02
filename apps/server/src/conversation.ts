import { onFixSettled, fixRepos } from "./fix.ts";
import { investigationPrompt } from "./investigate.ts";
import { newSession, prompt as ask, resume } from "./opencode.ts";
import { addCost, get, update, type Item } from "./store.ts";
import { during, type TurnSource } from "./turns.ts";
import { refreshWorkspace, workspace } from "./workspace.ts";

// The conversation on an item: one opencode session with the `investigate`
// agent, which you talk to and which acts through the support tools. Its first
// turn is the investigation. After that, your messages and events (a fix
// finishing) arrive as further turns, one at a time per item.

/** Marks a message the service sent rather than a person. The dashboard shows these as events. */
export const EVENT = "[event] ";

const queues = new Map<number, Promise<unknown>>();

/** Runs `job` after whatever is already running for this item. */
export function serial<T>(itemId: number, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(itemId) ?? Promise.resolve()).catch(() => {}).then(job);
  queues.set(itemId, run);
  run.finally(() => {
    if (queues.get(itemId) === run) queues.delete(itemId);
  });
  return run;
}

async function turn(itemId: number, source: TurnSource, message: string): Promise<void> {
  const item = get(itemId)!;
  update(itemId, { chat_pending: message, chat_error: "" });
  try {
    let sessionId = item.session_id;
    let text = message;
    const checkouts = await refreshWorkspace();
    const first = !sessionId;
    if (first) {
      // Talking to an item nobody investigated yet: the investigation comes
      // first, with the message folded in. Marked as investigating so the
      // queue does not start a second one.
      sessionId = await newSession(workspace, `#${item.id} ${item.triage?.kind ?? item.source}`);
      update(itemId, { session_id: sessionId, status: "investigating", investigated_at: new Date().toISOString() });
      text = `${investigationPrompt(item, checkouts)}\n\nThe maintainer adds:\n\n${message}`;
    }
    const reply = await during(itemId, source, () => ask(sessionId, workspace, "investigate", text));
    addCost(itemId, reply.cost);
    update(itemId, { chat_pending: "", ...(first ? { status: "reported" as const, report: reply.text, fix_targets: "" } : {}) });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const wasInvestigating = get(itemId)?.status === "investigating";
    update(itemId, { chat_pending: "", chat_error: error, ...(wasInvestigating ? { status: "failed" as const, error } : {}) });
  }
}

/** A message from the maintainer. */
export function say(item: Item, message: string): Promise<void> {
  // The agent's tools take the item number; sessions from before it was in
  // the investigation prompt learn it here. The dashboard strips the tag.
  const tagged = `${message}\n\n(support item #${item.id})`;
  // Recorded now, before the queue gets to it, so the page shows it at once.
  update(item.id, { chat_pending: tagged });
  return serial(item.id, () => turn(item.id, "person", tagged));
}

/** Tells the agent something happened, and lets it react. */
function notify(itemId: number, visible: string, instructions: string): Promise<void> {
  return serial(itemId, () => turn(itemId, "event", `${EVENT}${visible}\n\n${instructions}`));
}

/** Picks up a turn a restart cut off. */
export function resumeTurn(item: Item): Promise<void> {
  const source: TurnSource = item.chat_pending.startsWith(EVENT) ? "event" : "person";
  return serial(item.id, async () => {
    try {
      const { cost } = await during(item.id, source, () => resume(item.session_id, workspace, "investigate"));
      addCost(item.id, cost);
      update(item.id, { chat_pending: "" });
    } catch (err) {
      update(item.id, { chat_pending: "", chat_error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// When a fix finishes, the agent hears about it and tells the maintainer.
onFixSettled((item) => {
  if (!item.session_id) return;
  const where = fixRepos(item).join(", ");
  if (item.fix_status === "failed") {
    notify(item.id, `The fix in ${where} failed: ${item.fix_error}`, "Tell the maintainer briefly what went wrong and what they could try.");
  } else {
    notify(
      item.id,
      `The fix agent finished in ${where}.`,
      "Read it with get_fix. Tell the maintainer in a few sentences what it changed and whether it does what was asked; point out anything that looks wrong or risky. If it looks right, propose_pr with a title and description. Do not start or revise the fix yourself.",
    );
  }
});
