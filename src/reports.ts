import { config } from "./config.ts";
import { open } from "./grain-db.ts";
import { enqueue, getCursor, setCursor } from "./store.ts";

// User reports filed in the app, read from the appview's `_reports` table.
// Only open reports are queued; the cursor is the highest report id seen, so a
// report resolved by an admin before the next poll is simply never picked up.

const CURSOR = "reports.id";

export function pollReports(): number {
  if (!config.grainDbPath) return 0;
  const db = open(config.grainDbPath);

  let after = Number(getCursor(CURSOR) ?? NaN);
  if (!Number.isFinite(after)) {
    // First run: start from the newest report rather than queueing the backlog.
    const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM _reports`).get();
    after = Number(row?.id ?? 0);
    setCursor(CURSOR, String(after));
    return 0;
  }

  const rows = db
    .prepare(
      `SELECT id, subject_uri, subject_did, label, reason, reported_by, created_at
       FROM _reports WHERE id > ? AND status = 'open' ORDER BY id LIMIT 100`,
    )
    .all(after);

  let added = 0;
  for (const r of rows) {
    const text = [`Report label: ${r.label}`, `Subject: ${r.subject_uri}`, r.reason ? `Reason: ${r.reason}` : ""]
      .filter(Boolean)
      .join("\n");
    if (
      enqueue({
        source: "report",
        source_ref: String(r.id),
        author: String(r.reported_by),
        text,
        url: String(r.subject_uri),
        received_at: String(r.created_at),
      })
    ) {
      added++;
    }
    after = Math.max(after, Number(r.id));
  }
  setCursor(CURSOR, String(after));
  return added;
}
