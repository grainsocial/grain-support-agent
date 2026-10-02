import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agent-reports-"));
process.env.STATE_DIR = dir;
process.env.GRAIN_DB_PATH = join(dir, "grain.db");

const DID = "did:plc:abc";
const PHOTO = `at://${DID}/social.grain.photo/3photo`;
const GALLERY = `at://${DID}/social.grain.gallery/3gallery`;

const grain = new DatabaseSync(process.env.GRAIN_DB_PATH);
grain.exec(`
  CREATE TABLE _reports (id INTEGER PRIMARY KEY, subject_uri TEXT, subject_did TEXT, label TEXT, reason TEXT,
    reported_by TEXT, status TEXT, created_at TEXT);
  CREATE TABLE "social.grain.photo" (uri TEXT, photo TEXT);
  CREATE TABLE "social.grain.gallery.item" (uri TEXT, gallery TEXT, item TEXT);
`);
grain.prepare(`INSERT INTO "social.grain.photo" VALUES (?, ?)`).run(PHOTO, JSON.stringify({ ref: { $link: "bafyphoto" } }));
grain.prepare(`INSERT INTO "social.grain.gallery.item" VALUES ('x', ?, ?)`).run(GALLERY, PHOTO);

const { pollReports, grainUrl } = await import("../src/reports.ts");
const store = await import("../src/store.ts");

const report = (id: number, subject: string, label: string, reason: string, by: string) =>
  grain
    .prepare(`INSERT INTO _reports VALUES (?, ?, ?, ?, ?, ?, 'open', '2026-10-02T00:00:00Z')`)
    .run(id, subject, DID, label, reason, by);

test("a classifier's report is its own kind of item, linked to the page that shows it", () => {
  pollReports(); // the first poll only sets the cursor
  report(1, PHOTO, "nudity", "nsfw: nudity 0.87", "system:nsfw");
  report(2, GALLERY, "spam", "looks like an ad", DID);
  assert.equal(pollReports(), 2);

  // Still "new", which no tab shows: read them back by id.
  const items = [1, 2].map((id) => store.get(id)!);
  const byClassifier = items.find((i) => i.source_ref === "1")!;
  assert.equal(byClassifier.source, "classifier");
  assert.equal(byClassifier.author, "nsfw");
  assert.equal(byClassifier.url, `https://grain.social/profile/${DID}/gallery/3gallery`);
  assert.match(byClassifier.text, /The nsfw classifier filed a nudity report/);
  assert.match(byClassifier.text, /Signal: nudity 0\.87/);
  // A link, not an attachment: opening the item must not put the image on screen.
  assert.match(byClassifier.text, /Image: https:\/\/cdn\.bsky\.app\/img\/feed_thumbnail\/plain\/did:plc:abc\/bafyphoto@jpeg/);
  assert.deepEqual(byClassifier.images, []);

  const byPerson = items.find((i) => i.source_ref === "2")!;
  assert.equal(byPerson.source, "report");
  assert.equal(byPerson.author, DID);
});

test("grain URLs: an account, a gallery, and a photo through its gallery or its owner", () => {
  const none = () => null;
  assert.equal(grainUrl(DID, none), `https://grain.social/profile/${DID}`);
  assert.equal(grainUrl(GALLERY, none), `https://grain.social/profile/${DID}/gallery/3gallery`);
  assert.equal(grainUrl(PHOTO, () => GALLERY), `https://grain.social/profile/${DID}/gallery/3gallery`);
  assert.equal(grainUrl(PHOTO, none), `https://grain.social/profile/${DID}`);
});
