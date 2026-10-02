import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

// The work queue. One row per thing that came in from outside: a Bluesky post
// or a user report. `status` is where it sits in the pipeline:
//
//   new           waiting for triage
//   needs_review  triage was unsure, or it is a moderation matter; a person looks
//   triaged       understood, no investigation wanted (praise, a question, ...)
//   investigate   queued for the investigation agent
//   investigating the agent is on it
//   reported      the agent wrote a report
//   failed        triage or investigation errored; `error` says why
//   done          a person dealt with it
//   dismissed     not about grain, or spam

export type Status =
  | "new"
  | "needs_review"
  | "triaged"
  | "investigate"
  | "investigating"
  | "reported"
  | "failed"
  | "done"
  | "dismissed";

export type Source = "bluesky" | "report";

export interface Item {
  id: number;
  source: Source;
  source_ref: string;
  author: string;
  text: string;
  url: string;
  images: string[];
  received_at: string;
  status: Status;
  triage: Triage | null;
  route_reason: string;
  session_id: string;
  investigated_at: string;
  report: string;
  cost: number;
  error: string;
  updated_at: string;
  fix_repo: string;
  fix_session_id: string;
  fix_branch: string;
  fix_status: FixStatus;
  fix_summary: string;
  fix_title: string;
  fix_body: string;
  fix_pr_url: string;
  fix_error: string;
  /** JSON: for each repository, Clef's probability that the fix needs it. */
  fix_targets: string;
}

// A fix, at most one per item:
//   working    the fix agent is editing
//   ready      it finished; the diff waits for a person
//   failed     the agent errored; fix_error says why
//   pr_open    a person approved it and a draft pull request is open
export type FixStatus = "" | "working" | "ready" | "failed" | "pr_open";

export interface Triage {
  relevant: number;
  kind: string;
  kindConfidence: number;
  severity: number;
  area: string;
  platform: string;
  needsReply: number;
}

mkdirSync(config.stateDir, { recursive: true });
const db = new DatabaseSync(join(config.stateDir, "agent.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    images TEXT NOT NULL DEFAULT '[]',
    received_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    triage TEXT,
    route_reason TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    investigated_at TEXT NOT NULL DEFAULT '',
    report TEXT NOT NULL DEFAULT '',
    cost REAL NOT NULL DEFAULT 0,
    error TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE (source, source_ref)
  );
  CREATE INDEX IF NOT EXISTS items_status ON items (status, id);
  -- A person's correction of a triage call. Kept from day one so there is
  -- labeled data if Clef is ever fine-tuned on grain's traffic.
  CREATE TABLE IF NOT EXISTS triage_feedback (
    item_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    predicted TEXT NOT NULL,
    corrected TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cursors (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Columns added after the table first shipped. ADD COLUMN for each one a
// database is missing, so an existing queue keeps its rows.
const LATER_COLUMNS: Record<string, string> = {
  fix_repo: "TEXT NOT NULL DEFAULT ''",
  fix_session_id: "TEXT NOT NULL DEFAULT ''",
  fix_branch: "TEXT NOT NULL DEFAULT ''",
  fix_status: "TEXT NOT NULL DEFAULT ''",
  fix_summary: "TEXT NOT NULL DEFAULT ''",
  fix_title: "TEXT NOT NULL DEFAULT ''",
  fix_body: "TEXT NOT NULL DEFAULT ''",
  fix_pr_url: "TEXT NOT NULL DEFAULT ''",
  fix_error: "TEXT NOT NULL DEFAULT ''",
  fix_targets: "TEXT NOT NULL DEFAULT ''",
};
const existing = new Set(db.prepare(`SELECT name FROM pragma_table_info('items')`).all().map((r) => String(r.name)));
for (const [column, type] of Object.entries(LATER_COLUMNS)) {
  if (!existing.has(column)) db.exec(`ALTER TABLE items ADD COLUMN ${column} ${type}`);
}

const now = () => new Date().toISOString();

function hydrate(row: Record<string, unknown>): Item {
  return {
    ...(row as unknown as Item),
    images: JSON.parse(String(row.images)),
    triage: row.triage ? JSON.parse(String(row.triage)) : null,
  };
}

/** Adds an item unless one with the same source reference exists. Returns whether it was new. */
export function enqueue(item: {
  source: Source;
  source_ref: string;
  author: string;
  text: string;
  url: string;
  images?: string[];
  received_at: string;
  status?: Status;
}): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO items (source, source_ref, author, text, url, images, received_at, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      item.source,
      item.source_ref,
      item.author,
      item.text,
      item.url,
      JSON.stringify(item.images ?? []),
      item.received_at,
      item.status ?? "new",
      now(),
    );
  return result.changes > 0;
}

export function get(id: number): Item | undefined {
  const row = db.prepare(`SELECT * FROM items WHERE id = ?`).get(id);
  return row ? hydrate(row) : undefined;
}

export function list(statuses: Status[], limit = 200): Item[] {
  const marks = statuses.map(() => "?").join(",");
  return db
    .prepare(`SELECT * FROM items WHERE status IN (${marks}) ORDER BY id DESC LIMIT ?`)
    .all(...statuses, limit)
    .map(hydrate);
}

export function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of db.prepare(`SELECT status, COUNT(*) AS n FROM items GROUP BY status`).all()) {
    out[String(row.status)] = Number(row.n);
  }
  return out;
}

/** The oldest item in a status, for the workers to take next. */
export function next(status: Status): Item | undefined {
  const row = db.prepare(`SELECT * FROM items WHERE status = ? ORDER BY id LIMIT 1`).get(status);
  return row ? hydrate(row) : undefined;
}

type Updatable = Omit<Item, "id" | "source" | "source_ref" | "author" | "text" | "url" | "images" | "received_at" | "updated_at">;

export function update(id: number, fields: Partial<Updatable>): void {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(key === "triage" ? JSON.stringify(value) : (value as string | number));
  }
  sets.push("updated_at = ?");
  values.push(now(), id);
  db.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

/** Investigations started since UTC midnight, for the daily cap. */
export function investigationsToday(): number {
  const midnight = new Date().toISOString().slice(0, 10);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM items WHERE investigated_at >= ?`)
    .get(midnight);
  return Number(row?.n ?? 0);
}

export function recordFeedback(itemId: number, field: string, predicted: string, corrected: string): void {
  db.prepare(
    `INSERT INTO triage_feedback (item_id, field, predicted, corrected, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(itemId, field, predicted, corrected, now());
}

export function getCursor(name: string): string | undefined {
  const row = db.prepare(`SELECT value FROM cursors WHERE name = ?`).get(name);
  return row ? String(row.value) : undefined;
}

export function setCursor(name: string, value: string): void {
  db.prepare(
    `INSERT INTO cursors (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value`,
  ).run(name, value);
}

/** Adds to an item's running spend. */
export function addCost(id: number, cost: number): void {
  db.prepare(`UPDATE items SET cost = cost + ? WHERE id = ?`).run(cost, id);
}

/**
 * After a restart: investigations that were running go back on the queue, and
 * fixes that were running are marked failed, since their edits may be partial.
 */
export function requeueInterrupted(): void {
  db.prepare(`UPDATE items SET status = 'investigate', updated_at = ? WHERE status = 'investigating'`).run(now());
  db.prepare(
    `UPDATE items SET fix_status = 'failed', fix_error = 'interrupted by a restart', updated_at = ? WHERE fix_status = 'working'`,
  ).run(now());
}
