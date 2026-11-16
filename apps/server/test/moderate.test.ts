import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GRAIN, install, MODERATOR, network, report } from "./network.ts";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "agent-moderate-"));
process.env.GRAIN_URL = GRAIN;
process.env.GRAIN_MOD_IDENTIFIER = MODERATOR;
process.env.GRAIN_MOD_APP_PASSWORD = "app-password";
install();
const store = await import("../src/store.ts");
const { act, actionable, labelNames } = await import("../src/moderate.ts");

const DID = "did:plc:abc";
const GALLERY = `at://${DID}/social.grain.gallery/3g`;

function item(ref: string, subject_uri: string) {
  store.enqueue({ source: "classifier", source_ref: ref, author: "spam", text: "t", url: "u", received_at: "2026-11-16T00:00:00Z", subject_did: DID, subject_uri });
  return byRef(ref)!;
}

const byRef = (ref: string) => [...Array(50).keys()].map((i) => store.get(i + 1)).find((i) => i?.source_ref === ref);
const lxm = (auth: string | null) => JSON.parse(Buffer.from(auth!.split(".")[1], "base64url").toString()).lxm;
const status = (id: number) => network.reports.find((r) => r.id === id)!.status;

test("a takedown takes the item's own account down, then resolves every open report on the subject", async () => {
  network.calls = [];
  report({ id: 1, subject: DID, subjectDid: DID, label: "spam", reportedBy: "did:plc:x" });
  report({ id: 2, subject: DID, subjectDid: DID, label: "harassment", reportedBy: "did:plc:y" });
  report({ id: 3, subject: GALLERY, subjectDid: DID, label: "spam", reportedBy: "did:plc:x" });
  const it = item("1", DID);
  await act(it, { action: "takedown", reason: "a spam account" });

  assert.deepEqual(network.calls[0].body, {
    subject: { $type: "com.atproto.admin.defs#repoRef", did: DID },
    takedown: { applied: true },
  });
  // Each call carries a service token for its own method.
  for (const call of network.calls) assert.equal(lxm(call.auth), call.nsid);
  assert.deepEqual([status(1), status(2), status(3)], ["resolved", "resolved", "open"]);
  const after = store.get(it.id)!;
  assert.equal(after.status, "done");
  assert.equal(JSON.parse(after.moderation_done).action, "takedown");
});

test("a label on a gallery resolves the reports that asked for it and dismisses the rest", async () => {
  network.calls = [];
  report({ id: 4, subject: GALLERY, subjectDid: DID, label: "nudity", reportedBy: "did:plc:y" });
  await act(item("2", GALLERY), { action: "label", label: "spam" });
  // Report 3 asked for spam, so resolving it gives the label out; no second label.
  assert.equal(network.calls.some((c) => c.nsid === "social.grain.admin.applyLabel"), false);
  assert.deepEqual([status(3), status(4)], ["resolved", "dismissed"]);
});

test("a label no report asked for is given out, and the reports dismissed", async () => {
  network.calls = [];
  report({ id: 5, subject: GALLERY, subjectDid: DID, label: "spam", reportedBy: "did:plc:y" });
  await act(item("3", GALLERY), { action: "label", label: "nudity" });
  assert.deepEqual(network.calls[0], {
    nsid: "social.grain.admin.applyLabel",
    body: { uri: GALLERY, val: "nudity" },
    auth: network.calls[0].auth,
  });
  assert.equal(status(5), "dismissed");
});

test("service tokens are minted once a method while they last", async () => {
  network.minted = [];
  await labelNames();
  await labelNames();
  assert.deepEqual(network.minted, ["social.grain.admin.listLabelDefinitions"]);
  assert.deepEqual(await labelNames(), ["nudity", "spam"]);
});

test("only a report with a subject, not yet acted on, can be acted on", () => {
  assert.match(actionable(byRef("1")!)!, /already been acted on/);
  store.enqueue({ source: "bluesky", source_ref: "p", author: "a", text: "t", url: "u", received_at: "2026-11-16T00:00:00Z" });
  assert.match(actionable(byRef("p")!)!, /not a report/);
  assert.equal(actionable(item("4", DID)), null);
});

test("a refusal from grain leaves the item as it was", async () => {
  network.refuse = 403;
  try {
    const it = item("5", DID);
    await assert.rejects(act(it, { action: "dismiss" }), /grain 403: Forbidden/);
    assert.equal(store.get(it.id)!.moderation_done, "");
  } finally {
    network.refuse = 0;
  }
});
