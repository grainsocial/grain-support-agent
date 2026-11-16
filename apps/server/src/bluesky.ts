import { Session } from "./atproto.ts";
import { config } from "./config.ts";
import { enqueue, getCursor, setCursor } from "./store.ts";

// Mentions, replies and quotes of the grain account, from its notifications.
// Bluesky's appview works out what counts as a mention, which is more reliable
// than matching post text ourselves. Read-only: this never marks notifications
// seen, so the account's unread state in the Bluesky app is left alone.

const APPVIEW_PROXY = "did:web:api.bsky.app#bsky_appview";
const CURSOR = "bluesky.indexedAt";
// On a first run, how far back to pick up mentions that arrived before the
// agent existed.
const FIRST_RUN_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const MAX_PAGES = 5;

const account = new Session(config.bluesky.identifier, config.bluesky.appPassword, config.bluesky.pds);

const call = (path: string) => account.call(path, { headers: { "atproto-proxy": APPVIEW_PROXY } });

interface Notification {
  uri: string;
  author: { did: string; handle: string };
  reason: string;
  record: { text?: string; embed?: Embed };
  indexedAt: string;
}

interface Embed {
  $type?: string;
  images?: { image?: { ref?: { $link?: string } } }[];
  media?: Embed;
}

function imageUrls(authorDid: string, embed: Embed | undefined): string[] {
  const images = embed?.images ?? embed?.media?.images ?? [];
  return images
    .map((i) => i.image?.ref?.$link)
    .filter((cid): cid is string => Boolean(cid))
    .slice(0, 4)
    .map((cid) => `https://cdn.bsky.app/img/feed_thumbnail/plain/${authorDid}/${cid}@jpeg`);
}

function postUrl(uri: string): string {
  const [, , did, , rkey] = uri.split("/");
  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

export async function pollBluesky(): Promise<number> {
  const since =
    getCursor(CURSOR) ?? new Date(Date.now() - FIRST_RUN_LOOKBACK_MS).toISOString();
  let newest = since;
  let added = 0;
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: "50" });
    for (const reason of ["mention", "reply", "quote"]) params.append("reasons", reason);
    if (cursor) params.set("cursor", cursor);
    const body = (await call(`app.bsky.notification.listNotifications?${params}`)) as {
      notifications: Notification[];
      cursor?: string;
    };

    let reachedSeen = false;
    for (const n of body.notifications) {
      if (n.indexedAt <= since) {
        reachedSeen = true;
        continue;
      }
      if (n.indexedAt > newest) newest = n.indexedAt;
      const isNew = enqueue({
        source: "bluesky",
        source_ref: n.uri,
        author: n.author.handle,
        text: n.record.text ?? "",
        url: postUrl(n.uri),
        images: imageUrls(n.author.did, n.record.embed),
        received_at: n.indexedAt,
      });
      if (isNew) added++;
    }
    if (reachedSeen || !body.cursor) break;
    cursor = body.cursor;
  }

  setCursor(CURSOR, newest);
  return added;
}
