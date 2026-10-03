import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "agent-moderate-"));
process.env.GRAIN_ADMIN_URL = "http://appview.test";
process.env.GRAIN_ADMIN_TOKEN = "secret-token";
const store = await import("../src/store.ts");
const { act, actionable } = await import("../src/moderate.ts");

const DID = "did:plc:abc";
const GALLERY = `at://${DID}/social.grain.gallery/3g`;

function report(ref: string, subject_uri: string) {
  store.enqueue({ source: "classifier", source_ref: ref, author: "spam", text: "t", url: "u", received_at: "2026-10-02T00:00:00Z", subject_did: DID, subject_uri });
  return byRef(ref)!;
}

const byRef = (ref: string) => [...Array(50).keys()].map((i) => store.get(i + 1)).find((i) => i?.source_ref === ref);

function capture() {
  const calls: { url: string; body: any; auth: string | null }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

test("a takedown goes to the appview for the item's own account, with the token", async () => {
  const calls = capture();
  const item = report("1", DID);
  await act(item, { action: "takedown", reason: "a spam account" });

  assert.deepEqual(calls, [
    { url: "http://appview.test/admin/review/act", body: { did: DID, action: "takedown" }, auth: "Bearer secret-token" },
  ]);
  const after = store.get(item.id)!;
  assert.equal(after.status, "done");
  assert.equal(JSON.parse(after.moderation_done).action, "takedown");
});

test("a label on a gallery names the gallery, not the account", async () => {
  const calls = capture();
  const item = report("2", GALLERY);
  await act(item, { action: "label", label: "spam" });
  assert.deepEqual(calls[0].body, { did: DID, uri: GALLERY, action: "label", label: "spam" });
});

test("only a report with a subject, not yet acted on, can be acted on", () => {
  assert.match(actionable(store.get(1)!)!, /already been acted on/);
  store.enqueue({ source: "bluesky", source_ref: "p", author: "a", text: "t", url: "u", received_at: "2026-10-02T00:00:00Z" });
  const post = byRef("p")!;
  assert.match(actionable(post)!, /not a report/);
  const fresh = report("3", DID);
  assert.equal(actionable(fresh), null);
});

test("an appview refusal leaves the item as it was", async () => {
  globalThis.fetch = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
  const item = report("4", DID);
  await assert.rejects(act(item, { action: "dismiss" }), /appview 403/);
  assert.equal(store.get(item.id)!.moderation_done, "");
});
