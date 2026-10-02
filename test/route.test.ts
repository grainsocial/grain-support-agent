import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/triage.ts";

const base = { relevant: 0.95, kind: "bug", kindConfidence: 0.9, severity: 1.2, area: "upload", platform: "ios", needsReply: 0.8 };

test("a confident bug is investigated", () => {
  assert.equal(route(base, "bluesky").status, "investigate");
});

test("posts about other kinds of grain are dismissed", () => {
  assert.equal(route({ ...base, relevant: 0.05 }, "bluesky").status, "dismissed");
});

test("user reports always reach a person", () => {
  assert.equal(route({ ...base, relevant: 0.05 }, "report").status, "needs_review");
  assert.equal(route({ ...base, kind: "spam", kindConfidence: 0.99 }, "report").status, "needs_review");
});

test("moderation goes to a person, never the agent", () => {
  assert.equal(route({ ...base, kind: "moderation" }, "bluesky").status, "needs_review");
});

test("an unsure call goes to review", () => {
  assert.equal(route({ ...base, kindConfidence: 0.3 }, "bluesky").status, "needs_review");
  assert.equal(route({ ...base, relevant: 0.4 }, "bluesky").status, "needs_review");
});

test("praise and questions are triaged without investigation", () => {
  assert.equal(route({ ...base, kind: "praise", severity: 0 }, "bluesky").status, "triaged");
  assert.equal(route({ ...base, kind: "question", severity: 0.4 }, "bluesky").status, "triaged");
});

test("a severe complaint is investigated", () => {
  assert.equal(route({ ...base, kind: "complaint", severity: 2.4 }, "bluesky").status, "investigate");
});
