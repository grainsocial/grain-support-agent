import type { DatabaseSync } from "node:sqlite";
import type { Account } from "@workspace/types";
import { config } from "./config.ts";
import { open } from "./grain-db.ts";
import { enqueue, getCursor, setCursor } from "./store.ts";

// Reports read from the appview's `_reports` table: filed by a person in the
// app, or by one of the appview's classifiers, which file as `system:<name>`.
// Only open reports are queued; the cursor is the highest report id seen, so a
// report resolved by an admin before the next poll is simply never picked up.

const CURSOR = "reports.id";
const GRAIN = "https://grain.social";

interface ReportRow {
  id: number;
  subject_uri: string;
  subject_did: string;
  label: string;
  reason: string | null;
  reported_by: string;
  created_at: string;
}

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
    .all(after) as unknown as ReportRow[];

  let added = 0;
  for (const r of rows) {
    const classifier = r.reported_by.startsWith("system:") ? r.reported_by.slice("system:".length) : null;
    const item = classifier
      ? {
          source: "classifier" as const,
          author: classifier,
          text: classifierText(r, classifier, db),
          url: grainUrl(r.subject_uri, (photo) => galleryOf(db, photo)),
        }
      : {
          source: "report" as const,
          author: r.reported_by,
          text: [`Report label: ${r.label}`, `Subject: ${r.subject_uri}`, r.reason ? `Reason: ${r.reason}` : ""]
            .filter(Boolean)
            .join("\n"),
          url: grainUrl(r.subject_uri, (photo) => galleryOf(db, photo)),
        };
    if (enqueue({ ...item, source_ref: String(r.id), received_at: r.created_at, subject_did: r.subject_did })) added++;
    after = Math.max(after, Number(r.id));
  }
  setCursor(CURSOR, String(after));
  return added;
}

/**
 * What a classifier report says, for the queue and the brief. A photo's image
 * goes in as a link rather than an attachment, so a nudity report does not put
 * the picture on screen the moment the item is opened.
 */
function classifierText(r: ReportRow, classifier: string, db: DatabaseSync): string {
  const lines = [`The ${classifier} classifier filed a ${r.label} report.`];
  // The appview writes the reason as `<classifier>: <signal> <score>`.
  const signal = r.reason?.replace(`${classifier}: `, "");
  if (signal) lines.push(`Signal: ${signal}`);
  lines.push(`Subject: ${r.subject_uri}`);
  if (r.subject_uri.includes("/social.grain.photo/")) {
    const row = db.prepare(`SELECT photo FROM "social.grain.photo" WHERE uri = ?`).get(r.subject_uri) as
      | { photo: string }
      | undefined;
    const cid = row ? blobCid(row.photo) : null;
    if (cid) lines.push(`Image: https://cdn.bsky.app/img/feed_thumbnail/plain/${r.subject_did}/${cid}@jpeg`);
  }
  return lines.join("\n");
}

function blobCid(json: string): string | null {
  try {
    const ref = JSON.parse(json)?.ref;
    const cid = typeof ref === "string" ? ref : ref?.$link;
    return typeof cid === "string" ? cid : null;
  } catch {
    return null;
  }
}

function galleryOf(db: DatabaseSync, photoUri: string): string | null {
  const row = db.prepare(`SELECT gallery FROM "social.grain.gallery.item" WHERE item = ? LIMIT 1`).get(photoUri) as
    | { gallery: string }
    | undefined;
  return row?.gallery ?? null;
}

/**
 * The page on grain.social that shows a report's subject: the account, the
 * gallery, or for a photo, the gallery it is in. grain has no page for a lone
 * photo, so one in no gallery falls back to its owner's profile.
 */
export function grainUrl(subject: string, galleryOf: (photoUri: string) => string | null): string {
  if (subject.startsWith("did:")) return `${GRAIN}/profile/${subject}`;
  const m = subject.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) return subject;
  const [, did, collection, rkey] = m;
  if (collection === "social.grain.gallery") return `${GRAIN}/profile/${did}/gallery/${rkey}`;
  if (collection === "social.grain.photo") {
    const gallery = galleryOf(subject);
    if (gallery) return grainUrl(gallery, () => null);
  }
  return `${GRAIN}/profile/${did}`;
}

/**
 * An account as the dashboard shows it: handle and display name read from the
 * appview as they are now, so a renamed account shows its current handle.
 * Without the database there is only the DID.
 */
export function account(did: string): Account {
  let handle: string | null = null;
  let displayName: string | null = null;
  if (config.grainDbPath) {
    try {
      const db = open(config.grainDbPath);
      const repo = db.prepare(`SELECT handle FROM _repos WHERE did = ?`).get(did) as { handle: string | null } | undefined;
      handle = repo?.handle || null;
      const profile = db.prepare(`SELECT display_name FROM "social.grain.actor.profile" WHERE did = ? LIMIT 1`).get(did) as
        | { display_name: string | null }
        | undefined;
      displayName = profile?.display_name?.trim() || null;
    } catch {
      // A missing table or a locked database leaves the DID, which still links.
    }
  }
  return { did, handle, displayName, url: `${GRAIN}/profile/${handle ?? did}` };
}
