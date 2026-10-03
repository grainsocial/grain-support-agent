import type { Moderation } from "@workspace/types";
import { config } from "./config.ts";
import { update, type Item } from "./store.ts";

// Acting on a report through the appview's /admin API, as the maintainer asked
// in the item's conversation. Every action is on the item's own subject, never
// on one the agent names: text it read cannot point it at someone else.
//
// Dismiss and label happen when asked. A takedown waits for the maintainer to
// confirm it in the dashboard, because it is the action a prompt injection in
// a report would most want to steer toward.

export const configured = () => Boolean(config.grainAdmin.token);

async function admin(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${config.grainAdmin.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${config.grainAdmin.token}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`appview ${res.status}: ${body.slice(0, 200)}`);
  return body ? JSON.parse(body) : null;
}

/**
 * Labels the appview defines, plus spam: grain has no definition for it, but
 * it is the label a resolved spam report carries.
 */
export async function labelNames(): Promise<string[]> {
  const { definitions } = (await admin("/admin/labels/definitions")) as { definitions: { identifier: string }[] };
  return [...new Set([...definitions.map((d) => d.identifier).filter((id) => !id.startsWith("!")), "spam"])];
}

/** Whether an item is a report with a subject the appview can act on. */
export function actionable(item: Item): string | null {
  if (item.source === "bluesky") return "this is a Bluesky post, not a report; there is nothing on grain to act on";
  if (!item.subject_uri || !item.subject_did) return "this report has no subject recorded";
  if (item.moderation_done) return "this report has already been acted on";
  return null;
}

/**
 * Act on the item's subject. The appview closes every open report on it, the
 * classifier's and any a person filed, and the item is done.
 */
export async function act(item: Item, m: Moderation): Promise<void> {
  const isRecord = item.subject_uri.startsWith("at://");
  await admin("/admin/review/act", {
    method: "POST",
    body: JSON.stringify({
      did: item.subject_did,
      uri: isRecord ? item.subject_uri : undefined,
      action: m.action,
      label: m.label,
    }),
  });
  update(item.id, {
    status: "done",
    moderation_pending: "",
    moderation_done: JSON.stringify({ ...m, at: new Date().toISOString() }),
  });
}

export function parse(json: string): Moderation | null {
  return json ? (JSON.parse(json) as Moderation) : null;
}
