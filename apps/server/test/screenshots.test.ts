import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), "agent-shots-"));
const { screenshotPages } = await import("../src/screenshots.ts");

test("reads the pages the fix agent listed", () => {
  const pages = screenshotPages(`Done.

## PR title
fix: x

## Screenshots
- / mobile android
- \`/profile/alice.test\` desktop
- /galleries?sort=new on an iPhone

## Notes
- /not/this one`);
  assert.deepEqual(
    pages.map((p) => [p.path, p.viewport, p.device]),
    [
      ["/", "mobile", "android"],
      ["/profile/alice.test", "desktop", "default"],
      ["/galleries?sort=new", "mobile", "ios"],
    ],
  );
});

test("no section, no pages; never more than four", () => {
  assert.equal(screenshotPages("## PR title\nx").length, 0);
  assert.equal(screenshotPages("## Screenshots\n" + Array(9).fill("- / mobile").join("\n")).length, 4);
});
