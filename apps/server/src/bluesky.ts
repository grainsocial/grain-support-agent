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

interface Session {
  did: string;
  accessJwt: string;
  refreshJwt: string;
  pds: string;
}

let session: Session | undefined;

async function resolvePds(identifier: string): Promise<{ did: string; pds: string }> {
  let did = identifier;
  if (!did.startsWith("did:")) {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(identifier)}`,
    );
    if (!res.ok) throw new Error(`resolveHandle ${identifier}: ${res.status}`);
    did = ((await res.json()) as { did: string }).did;
  }
  if (config.bluesky.pds) return { did, pds: config.bluesky.pds };
  const docUrl = did.startsWith("did:web:")
    ? `https://${did.slice("did:web:".length)}/.well-known/did.json`
    : `https://plc.directory/${did}`;
  const doc = (await (await fetch(docUrl)).json()) as {
    service?: { id: string; serviceEndpoint: string }[];
  };
  const pds = doc.service?.find((s) => s.id === "#atproto_pds")?.serviceEndpoint;
  if (!pds) throw new Error(`no PDS in the DID document for ${did}`);
  return { did, pds };
}

async function login(): Promise<Session> {
  const { pds } = await resolvePds(config.bluesky.identifier);
  const res = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier: config.bluesky.identifier, password: config.bluesky.appPassword }),
  });
  if (!res.ok) throw new Error(`createSession: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { did: string; accessJwt: string; refreshJwt: string };
  return { ...body, pds };
}

async function refresh(current: Session): Promise<Session> {
  const res = await fetch(`${current.pds}/xrpc/com.atproto.server.refreshSession`, {
    method: "POST",
    headers: { authorization: `Bearer ${current.refreshJwt}` },
  });
  // createSession is rate limited far harder than refresh, so it is the fallback.
  if (!res.ok) return login();
  const body = (await res.json()) as { did: string; accessJwt: string; refreshJwt: string };
  return { ...body, pds: current.pds };
}

async function call(path: string): Promise<unknown> {
  session ??= await login();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${session.pds}/xrpc/${path}`, {
      headers: { authorization: `Bearer ${session.accessJwt}`, "atproto-proxy": APPVIEW_PROXY },
    });
    if (res.ok) return res.json();
    const text = await res.text();
    if (attempt === 0 && (res.status === 401 || text.includes("ExpiredToken"))) {
      session = await refresh(session);
      continue;
    }
    throw new Error(`${path.split("?")[0]}: ${res.status} ${text}`);
  }
}

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
