import type { Moderation } from "@workspace/types";
import { applyLabel, listLabelDefinitions, moderatorConfigured, openReports, resolveReport, takeDown } from "./grain.ts";
import { update, type Item } from "./store.ts";

// Acting on a report through grain-serve's moderation methods, as the
// maintainer asked in the item's conversation. Every action is on the item's
// own subject, never on one the agent names: text it read cannot point it at
// someone else.
//
// Dismiss and label happen when asked. A takedown waits for the maintainer to
// confirm it in the dashboard, because it is the action a prompt injection in
// a report would most want to steer toward.

export const configured = moderatorConfigured;

/** The labels grain defines, but for those that only an admin's own action gives out. */
export async function labelNames(): Promise<string[]> {
  const { definitions } = await listLabelDefinitions();
  return definitions.map((d) => d.identifier).filter((id) => !id.startsWith("!"));
}

/** Whether an item is a report with a subject grain-serve can act on. */
export function actionable(item: Item): string | null {
  if (item.source === "bluesky") return "this is a Bluesky post, not a report; there is nothing on grain to act on";
  if (!item.subject_uri || !item.subject_did) return "this report has no subject recorded";
  if (item.moderation_done) return "this report has already been acted on";
  return null;
}

/**
 * Act on the item's subject, then close every open report on it, the
 * classifier's and any a person filed, and the item is done.
 *
 * - takedown takes the subject's account down, and resolves the reports;
 * - label gives out the label: a report that asked for it is resolved, which
 *   gives it out, and the rest are dismissed;
 * - dismiss dismisses them.
 */
export async function act(item: Item, m: Moderation): Promise<void> {
  const subject = item.subject_uri;
  const open = (await openReports()).filter((r) => r.subject === subject);
  if (m.action === "takedown") await takeDown(item.subject_did);
  if (m.action === "label") {
    if (!m.label) throw new Error("a label action names its label");
    if (!open.some((r) => r.label === m.label)) await applyLabel(subject, m.label);
  }
  for (const r of open) {
    const upheld = m.action === "takedown" || (m.action === "label" && r.label === m.label);
    await resolveReport(r.id, upheld ? "resolve" : "dismiss");
  }
  update(item.id, {
    status: "done",
    moderation_pending: "",
    moderation_done: JSON.stringify({ ...m, at: new Date().toISOString() }),
  });
}

export function parse(json: string): Moderation | null {
  return json ? (JSON.parse(json) as Moderation) : null;
}
