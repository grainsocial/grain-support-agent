// The AT Protocol network as this service reads it: an account's PDS from its
// DID document, the public records on it, and an account signed in with an
// app password.

const DID_DOC_MS = 60 * 60_000;
const TIMEOUT_MS = 15_000;

const pdsCache = new Map<string, { until: number; pds: Promise<string> }>();

/** The DID of a handle or DID. */
export async function resolveDid(identifier: string): Promise<string> {
  if (identifier.startsWith("did:")) return identifier;
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(identifier)}`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`resolveHandle ${identifier}: ${res.status}`);
  return ((await res.json()) as { did: string }).did;
}

/** The PDS a DID's document names, kept for an hour. */
export function pdsOf(did: string): Promise<string> {
  const hit = pdsCache.get(did);
  if (hit && hit.until > Date.now()) return hit.pds;
  const pds = (async () => {
    const docUrl = did.startsWith("did:web:")
      ? `https://${did.slice("did:web:".length)}/.well-known/did.json`
      : `https://plc.directory/${did}`;
    const res = await fetch(docUrl, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`the DID document for ${did}: ${res.status}`);
    const doc = (await res.json()) as { service?: { id: string; serviceEndpoint: string }[] };
    const endpoint = doc.service?.find((s) => s.id === "#atproto_pds" || s.id === `${did}#atproto_pds`)?.serviceEndpoint;
    if (!endpoint) throw new Error(`no PDS in the DID document for ${did}`);
    return endpoint.replace(/\/+$/, "");
  })();
  pdsCache.set(did, { until: Date.now() + DID_DOC_MS, pds });
  pds.catch(() => pdsCache.delete(did));
  return pds;
}

export interface AtRecord {
  uri: string;
  value: { [key: string]: unknown };
}

function parseUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const m = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  return m ? { did: m[1], collection: m[2], rkey: m[3] } : null;
}

/** A record as its author's PDS holds it now, or null when it holds none. */
export async function getRecord(uri: string): Promise<AtRecord | null> {
  const parts = parseUri(uri);
  if (!parts) return null;
  const params = new URLSearchParams({ repo: parts.did, collection: parts.collection, rkey: parts.rkey });
  const res = await fetch(`${await pdsOf(parts.did)}/xrpc/com.atproto.repo.getRecord?${params}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 400 || res.status === 404) return null;
  if (!res.ok) throw new Error(`getRecord ${uri}: ${res.status}`);
  return (await res.json()) as AtRecord;
}

/** One page of an account's records of a collection. */
export async function listRecords(
  did: string,
  collection: string,
  cursor?: string,
): Promise<{ records: AtRecord[]; cursor?: string }> {
  const params = new URLSearchParams({ repo: did, collection, limit: "100" });
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`${await pdsOf(did)}/xrpc/com.atproto.repo.listRecords?${params}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`listRecords ${did} ${collection}: ${res.status}`);
  return (await res.json()) as { records: AtRecord[]; cursor?: string };
}

/** An account's Bluesky profile, from Bluesky's public appview. */
export async function blueskyProfile(actor: string): Promise<{ handle?: string; displayName?: string }> {
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`app.bsky.actor.getProfile ${actor}: ${res.status}`);
  return (await res.json()) as { handle?: string; displayName?: string };
}

interface Tokens {
  did: string;
  accessJwt: string;
  refreshJwt: string;
  pds: string;
}

/**
 * An account signed in to its PDS with an app password. Its calls carry the
 * access token, and one refused for an expired token is made again once
 * after a refresh.
 */
export class Session {
  private tokens: Promise<Tokens> | undefined;
  private readonly identifier: string;
  private readonly password: string;
  private readonly pds: string;

  /** `pds` is the account's PDS, when it is not the one its DID document names. */
  constructor(identifier: string, password: string, pds = "") {
    this.identifier = identifier;
    this.password = password;
    this.pds = pds;
  }

  private async login(): Promise<Tokens> {
    const pds = this.pds || (await pdsOf(await resolveDid(this.identifier)));
    const res = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: this.identifier, password: this.password }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`createSession: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as Omit<Tokens, "pds">;
    return { ...body, pds };
  }

  private async refresh(current: Tokens): Promise<Tokens> {
    const res = await fetch(`${current.pds}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: { authorization: `Bearer ${current.refreshJwt}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // createSession is rate limited far harder than refresh, so it is the fallback.
    if (!res.ok) return this.login();
    const body = (await res.json()) as Omit<Tokens, "pds">;
    return { ...body, pds: current.pds };
  }

  private hold(tokens: Promise<Tokens>): Promise<Tokens> {
    this.tokens = tokens;
    // A failed login is tried again on the next call, not remembered.
    tokens.catch(() => {
      if (this.tokens === tokens) this.tokens = undefined;
    });
    return tokens;
  }

  /** An XRPC call to the account's PDS: `path` is the method and its query string. */
  async call(path: string, init: { method?: string; headers?: { [name: string]: string }; body?: string } = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const held = this.tokens ?? this.hold(this.login());
      const tokens = await held;
      const res = await fetch(`${tokens.pds}/xrpc/${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${tokens.accessJwt}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return res.json();
      const text = await res.text();
      if (attempt === 0 && (res.status === 401 || text.includes("ExpiredToken"))) {
        // The first call to find the token expired refreshes it; the others wait for that.
        if (this.tokens === held) this.hold(this.refresh(tokens));
        continue;
      }
      throw new Error(`${path.split("?")[0]}: ${res.status} ${text}`);
    }
  }
}
