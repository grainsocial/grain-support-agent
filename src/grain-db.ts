import { DatabaseSync } from "node:sqlite";

// Read-only access to the appview's live database.
//
// The connection is opened read-only, so SQLite itself refuses writes. The
// checks below are about what may be *read*: some underscore tables hold
// credentials (OAuth signing keys and sessions, push tokens) or private user
// state, and a query from the investigation agent must never return them.
// Table names cannot be computed at runtime in SQLite, so a name that does not
// appear in the statement text cannot be read by it.

const PRIVATE_TABLES = [
  "_oauth_keys",
  "_oauth_sessions",
  "_push_tokens",
  "_preferences",
  "_mutes",
  "_space_invites",
];

// Writes are already impossible on a read-only connection. These are the
// things that reach past this one database or change the connection itself.
const FORBIDDEN_WORDS = ["attach", "detach", "pragma", "load_extension", "fts3_tokenizer"];

export const MAX_ROWS = 200;
const MAX_CELL = 2000;

/** Returns why a statement is refused, or undefined when it may run. */
export function refuse(sql: string): string | undefined {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) return "empty statement";
  if (trimmed.includes(";")) return "one statement at a time";
  // Quoting and bracketing do not change which table a name refers to, so
  // compare with them stripped: "_oauth_keys", [_oauth_keys] and `_oauth_keys`
  // are all the same table.
  const bare = trimmed.toLowerCase().replace(/["`[\]]/g, "");
  if (!/^(select|with|explain)\b/.test(bare)) return "only SELECT, WITH and EXPLAIN are allowed";
  for (const word of FORBIDDEN_WORDS) {
    if (new RegExp(`\\b${word}\\b`).test(bare)) return `"${word}" is not allowed`;
  }
  for (const table of PRIVATE_TABLES) {
    if (bare.includes(table)) return `${table} holds private data and cannot be read`;
  }
  return undefined;
}

let db: DatabaseSync | undefined;

export function open(path: string): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(path, { readOnly: true });
    // The appview holds the write lock while indexing; wait rather than fail.
    db.exec("PRAGMA busy_timeout = 10000; PRAGMA query_only = 1;");
  }
  return db;
}

function clip(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_CELL) {
    return `${value.slice(0, MAX_CELL)}… (${value.length} chars)`;
  }
  if (value instanceof Uint8Array) return `<${value.length} bytes>`;
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function query(path: string, sql: string): { rows: Record<string, unknown>[]; truncated: boolean } {
  const why = refuse(sql);
  if (why) throw new Error(why);
  const rows: Record<string, unknown>[] = [];
  let truncated = false;
  for (const row of open(path).prepare(sql).iterate()) {
    if (rows.length >= MAX_ROWS) {
      truncated = true;
      break;
    }
    rows.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, clip(v)])));
  }
  return { rows, truncated };
}
