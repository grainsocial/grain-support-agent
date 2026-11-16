import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPrivate, PRIVATE_TABLES, query, refuse } from "../src/grain-db.ts";

// An index with a public table, an FTS table, and every private one, in WAL
// mode as grain-serve keeps it.
const path = join(mkdtempSync(join(tmpdir(), "grain-db-")), "index.db");
const w = new DatabaseSync(path);
w.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE photo (uri TEXT PRIMARY KEY, did TEXT);
  WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 500)
    INSERT INTO photo SELECT 'at://did:plc:a/social.grain.photo/' || n, 'did:plc:a' FROM c;
  CREATE VIRTUAL TABLE profile_search USING fts5(handle);
  INSERT INTO profile_search VALUES ('someone.bsky.social');
`);
for (const table of PRIVATE_TABLES) w.exec(`CREATE TABLE ${table} (secret TEXT); INSERT INTO ${table} VALUES ('hunter2');`);
w.close();

test("statements must be a single read", () => {
  assert.equal(refuse("SELECT COUNT(*) FROM photo"), undefined);
  assert.equal(refuse("with x as (select 1) select * from x;"), undefined);
  for (const sql of ["", "DELETE FROM photo", "PRAGMA table_info(photo)", "SELECT 1; DROP TABLE x", "ATTACH '/etc/passwd' AS p", "VACUUM INTO '/tmp/copy.db'"]) {
    assert.ok(refuse(sql), sql);
  }
});

test("public tables read, through FTS and the table-valued pragmas too", () => {
  assert.equal(query(path, "SELECT count(*) AS n FROM photo").rows[0].n, 500);
  assert.equal(query(path, "SELECT handle FROM profile_search WHERE profile_search MATCH 'someone'").rows.length, 1);
  assert.ok(query(path, "SELECT name FROM pragma_table_info('photo')").rows.length);
});

test("no statement reads a private table, however it names it", () => {
  for (const table of PRIVATE_TABLES) {
    for (const sql of [
      `SELECT * FROM ${table}`,
      `SELECT count(*) FROM "${table}"`,
      `SELECT * FROM [${table.toUpperCase()}]`,
      `SELECT * FROM main.\`${table}\``,
      `SELECT * FROM photo WHERE did IN (SELECT secret FROM ${table})`,
      `WITH x AS (SELECT * FROM ${table}) SELECT * FROM x`,
      `SELECT * FROM photo p JOIN ${table} t ON 1`,
      `EXPLAIN SELECT secret FROM ${table}`,
      `SELECT name FROM pragma_table_info('${table}')`,
    ]) {
      assert.throws(() => query(path, sql), /cannot be read/, sql);
    }
  }
  // Nor the raw pages the file holds them in.
  assert.throws(() => query(path, "SELECT * FROM dbstat"));
});

test("private tables are known by name, in any case", () => {
  assert.ok(isPrivate("oauth_key"));
  assert.ok(isPrivate("Web_Session"));
  assert.equal(isPrivate("photo"), false);
  assert.equal(isPrivate("profile"), false);
});

test("query caps rows and cannot write", () => {
  const { rows, truncated } = query(path, "SELECT uri FROM photo");
  assert.equal(rows.length, 200);
  assert.equal(truncated, true);
  assert.throws(() => query(path, "WITH x AS (SELECT 1) INSERT INTO photo (uri) SELECT * FROM x"));
});
