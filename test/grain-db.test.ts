import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, refuse } from "../src/grain-db.ts";

test("allows plain reads", () => {
  assert.equal(refuse("SELECT COUNT(*) FROM [social.grain.photo]"), undefined);
  assert.equal(refuse("with x as (select 1) select * from x;"), undefined);
  assert.equal(refuse("SELECT replace(text, 'a', 'b') FROM t WHERE op = 'update'"), undefined);
  // Pragma table-valued functions are exposed only for side-effect-free pragmas.
  assert.equal(refuse("SELECT * FROM pragma_table_info('_reports')"), undefined);
});

test("refuses private tables however they are quoted", () => {
  for (const sql of [
    "SELECT * FROM _oauth_keys",
    'SELECT * FROM "_oauth_sessions"',
    "SELECT * FROM [_push_tokens]",
    "SELECT * FROM `_preferences`",
    "SELECT * FROM x WHERE did IN (SELECT did FROM _OAUTH_SESSIONS)",
  ]) {
    assert.ok(refuse(sql), sql);
  }
});

test("refuses anything but a single read", () => {
  for (const sql of [
    "",
    "DELETE FROM _reports",
    "PRAGMA table_info(x)",
    "SELECT 1; DROP TABLE x",
    "ATTACH '/etc/passwd' AS p",
    "VACUUM INTO '/tmp/copy.db'",
  ]) {
    assert.ok(refuse(sql), sql);
  }
});

test("query caps rows and cannot write", () => {
  const path = join(mkdtempSync(join(tmpdir(), "grain-db-")), "grain.db");
  const w = new DatabaseSync(path);
  w.exec("CREATE TABLE t (n INTEGER); WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n < 500) INSERT INTO t SELECT n FROM c;");
  w.close();
  const { rows, truncated } = query(path, "SELECT n FROM t");
  assert.equal(rows.length, 200);
  assert.equal(truncated, true);
  assert.throws(() => query(path, "WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x"));
});
