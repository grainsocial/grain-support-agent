import type { Account } from "@workspace/types";
import { blueskyProfile, getRecord, listRecords } from "./atproto.ts";
import { config } from "./config.ts";
import { getProfile, listReports, moderatorConfigured, openReports, serviceDid, type Report } from "./grain.ts";
import { enqueue, getCursor, setCursor } from "./store.ts";

// Reports read from grain-serve (social.grain.admin.listReports): filed by a
// person in the app, or by one of grain-serve's classifiers, which file as
// grain's own DID with the classifier named at the head of the reason. Only
// open reports are queued; the cursor is the highest report id seen, so a
// report resolved by an admin before the next poll is simply never picked up.

const CURSOR = "grain.reports.id";
// How many pages of an account's gallery items to search for a photo's gallery.
const GALLERY_ITEM_PAGES = 10;

export async function pollReports(): Promise<number> {
  if (!moderatorConfigured()) return 0;

  const seen = getCursor(CURSOR);
  if (seen === undefined) {
    // First run: start from the newest report rather than queueing the backlog.
    const { reports } = await listReports({ status: "open", limit: 1 });
    setCursor(CURSOR, String(reports[0]?.id ?? 0));
    return 0;
  }

  let after = Number(seen);
  const fresh = (await openReports((r) => r.id <= after)).reverse();
  let added = 0;
  for (const r of fresh) {
    if (enqueue(await itemOf(r))) added++;
    after = Math.max(after, r.id);
    setCursor(CURSOR, String(after));
  }
  return added;
}

async function itemOf(r: Report) {
  const gallery = isPhoto(r.subject) ? await galleryOf(r.subject) : null;
  const common = {
    url: grainUrl(r.subject, gallery),
    subject_did: r.subjectDid,
    subject_uri: r.subject,
    source_ref: String(r.id),
    received_at: r.createdAt,
  };
  const classifier = classifierOf(r);
  if (classifier) {
    return { ...common, source: "classifier" as const, author: classifier.name, text: await classifierText(r, classifier) };
  }
  const text = [
    `Report label: ${r.label}`,
    `Subject: ${r.subject}`,
    r.reasonType ? `Reason type: ${r.reasonType}` : "",
    r.reason ? `Reason: ${r.reason}` : "",
  ];
  return { ...common, source: "report" as const, author: r.reportedBy, text: text.filter(Boolean).join("\n") };
}

/**
 * The classifier that filed a report, if one did. A classifier files as
 * grain-serve itself, its reason `<classifier>: <signal> <score>`.
 */
export function classifierOf(r: Report): { name: string; signal: string } | null {
  if (r.reportedBy !== serviceDid) return null;
  const m = r.reason?.match(/^([^:\s]+): ([^]*)$/);
  return m ? { name: m[1], signal: m[2] } : { name: "grain", signal: r.reason ?? "" };
}

/**
 * What a classifier report says, for the queue and the brief. A photo's image
 * goes in as a link rather than an attachment, so a nudity report does not put
 * the picture on screen the moment the item is opened.
 */
async function classifierText(r: Report, classifier: { name: string; signal: string }): Promise<string> {
  const lines = [`The ${classifier.name} classifier filed a ${r.label} report.`];
  if (classifier.signal) lines.push(`Signal: ${classifier.signal}`);
  lines.push(`Subject: ${r.subject}`);
  if (isPhoto(r.subject)) {
    const photo = await getRecord(r.subject).catch(() => null);
    const cid = blobCid(photo?.value.photo);
    if (cid) lines.push(`Image: https://cdn.bsky.app/img/feed_thumbnail/plain/${r.subjectDid}/${cid}@jpeg`);
  }
  return lines.join("\n");
}

function blobCid(blob: unknown): string | null {
  if (!blob || typeof blob !== "object" || !("ref" in blob)) return null;
  const ref = blob.ref;
  if (typeof ref === "string") return ref;
  if (ref && typeof ref === "object" && "$link" in ref && typeof ref.$link === "string") return ref.$link;
  return null;
}

const isPhoto = (uri: string) => uri.includes("/social.grain.photo/");

// Names and links are read from the network as they are now, so a renamed
// account shows its current handle, and kept a while so the dashboard does not
// read them on every poll.
const KEEP_MS = 10 * 60_000;
const KEEP_FAILED_MS = 60_000;
const kept = new Map<string, { until: number; value: Promise<unknown> }>();

function remember<T>(key: string, load: () => Promise<T>, fallback: T): Promise<T> {
  const hit = kept.get(key);
  if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
  const value = load().catch(() => {
    kept.set(key, { until: Date.now() + KEEP_FAILED_MS, value: Promise.resolve(fallback) });
    return fallback;
  });
  kept.set(key, { until: Date.now() + KEEP_MS, value });
  return value;
}

/** The gallery a photo is in, from its author's gallery items. */
export function galleryOf(photoUri: string): Promise<string | null> {
  return remember(
    `gallery:${photoUri}`,
    async () => {
      const did = photoUri.split("/")[2];
      let cursor: string | undefined;
      for (let page = 0; page < GALLERY_ITEM_PAGES; page++) {
        const found = await listRecords(did, "social.grain.gallery.item", cursor);
        const item = found.records.find((r) => r.value.item === photoUri);
        if (item && typeof item.value.gallery === "string") return item.value.gallery;
        if (!found.cursor) break;
        cursor = found.cursor;
      }
      return null;
    },
    null,
  );
}

function galleryTitle(galleryUri: string): Promise<string | null> {
  return remember(
    `title:${galleryUri}`,
    async () => {
      const title = (await getRecord(galleryUri))?.value.title;
      return typeof title === "string" ? title.trim() || null : null;
    },
    null,
  );
}

/**
 * The page on grain.social that shows a report's subject: the account, the
 * gallery, or for a photo, the gallery it is in. grain has no page for a lone
 * photo, so one in no gallery falls back to its owner's profile.
 */
export function grainUrl(subject: string, gallery: string | null = null): string {
  if (subject.startsWith("did:")) return `${config.grainUrl}/profile/${subject}`;
  const m = subject.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!m) return subject;
  const [, did, collection, rkey] = m;
  if (collection === "social.grain.gallery") return `${config.grainUrl}/profile/${did}/gallery/${rkey}`;
  if (collection === "social.grain.photo" && gallery) return grainUrl(gallery);
  return `${config.grainUrl}/profile/${did}`;
}

/**
 * An account as the dashboard shows it: its handle and display name on grain,
 * or on Bluesky for one grain does not show. Without either there is only the
 * DID, which still links.
 */
export function account(did: string): Promise<Account> {
  const bare = { did, handle: null, displayName: null, url: `${config.grainUrl}/profile/${did}` };
  return remember(
    `account:${did}`,
    async () => {
      const profile = await getProfile(did).catch(() => blueskyProfile(did));
      const handle = profile.handle && profile.handle !== "handle.invalid" ? profile.handle : null;
      const displayName = profile.displayName?.trim() || null;
      return { did, handle, displayName, url: `${config.grainUrl}/profile/${handle ?? did}` };
    },
    bare,
  );
}

/**
 * A report's subject as a person would name it, with the page that shows it:
 * the account's handle, a gallery's title, or the gallery a photo is in.
 */
export async function subjectLink(uri: string, did: string): Promise<{ label: string; url: string }> {
  const who = await account(did);
  const handle = who.handle ? `@${who.handle}` : did;
  if (uri.startsWith("did:")) return { label: handle, url: who.url };
  if (uri.includes("/social.grain.gallery/")) {
    const t = await galleryTitle(uri);
    return { label: t ? `"${t}", a gallery by ${handle}` : `a gallery by ${handle}`, url: grainUrl(uri) };
  }
  if (isPhoto(uri)) {
    const gallery = await galleryOf(uri);
    const t = gallery ? await galleryTitle(gallery) : null;
    const where = t ? `in "${t}"` : gallery ? "in a gallery" : "in no gallery";
    return { label: `a photo by ${handle}, ${where}`, url: grainUrl(uri, gallery) };
  }
  return { label: uri, url: grainUrl(uri) };
}
