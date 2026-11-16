import { constants, DatabaseSync } from "node:sqlite";

// Read-only access to grain-serve's index, for the investigation agent.
//
// The connection is opened read-only and query-only, so SQLite itself refuses
// writes. What may be *read* is enforced by SQLite's authorizer, which sees
// every table and column a statement reads as it is compiled, however the
// statement names them: through quoting, aliases, subqueries, CTEs or
// EXPLAIN. A statement that reads a private table fails to compile, and so
// never runs. The private tables hold credentials (OAuth keys and sessions,
// push tokens) or what an account keeps to itself.

export const PRIVATE_TABLES = new Set([
  "oauth_key",
  "web_session",
  "carried_cookie_key",
  "push_token",
  "preference",
  "notification_pref",
  "notification_seen",
  "mute",
  "story_view",
  "space_invite",
  "space_support",
]);

/**
 * Tables that hold other tables' data outside their rows, private tables' with
 * the rest: the file's raw pages, and the index samples ANALYZE may keep.
 */
const BEYOND_ROWS = new Set(["sqlite_dbpage", "dbstat", "sqlite_stat3", "sqlite_stat4"]);

/** Functions that reach past this one database. */
const FORBIDDEN_FUNCTIONS = new Set(["load_extension", "fts3_tokenizer"]);

export const MAX_ROWS = 200;
const MAX_CELL = 2000;

export const isPrivate = (table: string) => PRIVATE_TABLES.has(table.toLowerCase());

/** Returns why a statement is refused before it is compiled, or undefined when it may be. */
export function refuse(sql: string): string | undefined {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!trimmed) return "empty statement";
  if (trimmed.includes(";")) return "one statement at a time";
  if (!/^(select|with|explain)\b/i.test(trimmed)) return "only SELECT, WITH and EXPLAIN are allowed";
  return undefined;
}

/**
 * The authorizer: a statement may select, read what is not private, call
 * functions that stay in this database, recurse, and use the table-valued
 * pragmas, which SQLite offers only for pragmas without side effects. Anything
 * else fails to compile.
 */
function authorize(action: number, arg1: string | null, arg2: string | null): number {
  switch (action) {
    case constants.SQLITE_SELECT:
    case constants.SQLITE_RECURSIVE:
      return constants.SQLITE_OK;
    case constants.SQLITE_READ: {
      const table = (arg1 ?? "").toLowerCase();
      return isPrivate(table) || BEYOND_ROWS.has(table) ? constants.SQLITE_DENY : constants.SQLITE_OK;
    }
    case constants.SQLITE_FUNCTION:
      return FORBIDDEN_FUNCTIONS.has((arg2 ?? "").toLowerCase()) ? constants.SQLITE_DENY : constants.SQLITE_OK;
    case constants.SQLITE_PRAGMA:
      // pragma_table_info('<table>') and its like name a table as the argument.
      return arg2 && isPrivate(arg2) ? constants.SQLITE_DENY : constants.SQLITE_OK;
    default:
      return constants.SQLITE_DENY;
  }
}

let db: DatabaseSync | undefined;

export function open(path: string): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(path, { readOnly: true });
    // grain-serve holds the write lock while indexing; wait rather than fail.
    db.exec("PRAGMA busy_timeout = 10000; PRAGMA query_only = 1;");
    db.setAuthorizer(authorize);
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
  try {
    // A table-valued pragma is authorized as it first steps, not as it compiles.
    for (const row of open(path).prepare(sql).iterate()) {
      if (rows.length >= MAX_ROWS) {
        truncated = true;
        break;
      }
      rows.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, clip(v)])));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // SQLite says what it refused, not why.
    if (/not authorized|prohibited/.test(message)) {
      throw new Error(`${message}: the private tables (${[...PRIVATE_TABLES].join(", ")}) and the file's raw pages cannot be read`);
    }
    throw err;
  }
  return { rows, truncated };
}
