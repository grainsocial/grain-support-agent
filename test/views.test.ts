import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "agent-views-"));
const store = await import("../src/store.ts");

const statuses = ["new", "needs_review", "triaged", "investigate", "investigating", "reported", "failed", "done", "dismissed"] as const;
const fixes = ["", "working", "ready", "failed", "pr_open"] as const;
let n = 0;
const where = new Map<number, string[]>();
for (const status of statuses) {
  for (const fix_status of fixes) {
    for (const chat_pending of ["", "a question"]) {
      n++;
      store.enqueue({ source: "bluesky", source_ref: String(n), author: "a", text: "t", url: "u", received_at: "2026-10-02T00:00:00Z", status });
      store.update(n, { fix_status, chat_pending });
    }
  }
}
for (const view of Object.keys(store.VIEWS) as (keyof typeof store.VIEWS)[]) {
  for (const item of store.list(view, 1000)) where.set(item.id, [...(where.get(item.id) ?? []), view]);
}

test("every item is in exactly one tab", () => {
  for (let id = 1; id <= n; id++) assert.equal(where.get(id)?.length, 1, `item ${id}: ${where.get(id)}`);
});

const tab = (status: string, fix_status: string, chat_pending = "") => {
  const item = [...Array(n).keys()].map((i) => store.get(i + 1)!).find(
    (i) => i.status === status && i.fix_status === fix_status && i.chat_pending === chat_pending,
  )!;
  return where.get(item.id)![0];
};

test("an item being fixed or asked about is in progress", () => {
  assert.equal(tab("reported", "working"), "working");
  assert.equal(tab("reported", "", "a question"), "working");
  assert.equal(tab("reported", "pr_open", "a question"), "working");
});

test("a fix waiting for review needs you, an open PR has its own tab", () => {
  assert.equal(tab("reported", "ready"), "inbox");
  assert.equal(tab("reported", "failed"), "inbox");
  assert.equal(tab("reported", "pr_open"), "pr");
});

test("closing an item wins over anything still attached to it", () => {
  assert.equal(tab("done", "working"), "done");
  assert.equal(tab("dismissed", "pr_open", "a question"), "dismissed");
});
