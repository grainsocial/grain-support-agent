import { Session } from "./atproto.ts";
import { config } from "./config.ts";

// grain-serve's XRPC methods, as this service calls them.
//
// Its moderation methods (social.grain.admin.*, and atproto's own
// com.atproto.admin.updateSubjectStatus) are called as the moderating account:
// each with a service token its PDS mints for that one method, naming
// grain-serve by its DID. grain-serve lets the call in when GRAIN_ADMIN_DIDS
// names the account. Its other reads are public and carry no token.

/** grain-serve's DID, which its service tokens name as their audience. */
export const serviceDid = `did:web:${new URL(config.grainUrl).host}`;

export const moderatorConfigured = () =>
  Boolean(config.grainModerator.identifier && config.grainModerator.appPassword);

const moderator = new Session(config.grainModerator.identifier, config.grainModerator.appPassword);

// A token is used until this long before it expires.
const TOKEN_MARGIN_S = 15;
const tokens = new Map<string, { token: string; exp: number }>();

function expiry(jwt: string): number {
  try {
    const exp = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"))?.exp;
    return typeof exp === "number" ? exp : 0;
  } catch {
    return 0;
  }
}

/** A service token for calling `lxm` on grain-serve, kept until shortly before it expires. */
async function serviceToken(lxm: string): Promise<string> {
  const now = Date.now() / 1000;
  const held = tokens.get(lxm);
  if (held && held.exp - TOKEN_MARGIN_S > now) return held.token;
  const params = new URLSearchParams({ aud: serviceDid, lxm });
  const { token } = (await moderator.call(`com.atproto.server.getServiceAuth?${params}`)) as { token: string };
  tokens.set(lxm, { token, exp: expiry(token) });
  return token;
}

type Params = { [name: string]: string | number | undefined };

async function xrpc<T>(nsid: string, { params, body, admin }: { params?: Params; body?: unknown; admin: boolean }): Promise<T> {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) query.set(k, String(v));
  const headers: { [name: string]: string } = {};
  if (admin) headers.authorization = `Bearer ${await serviceToken(nsid)}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${config.grainUrl}/xrpc/${nsid}${query.size ? `?${query}` : ""}`, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let said = text.slice(0, 200);
    try {
      const err = JSON.parse(text) as { error?: string; message?: string };
      said = [err.error, err.message].filter(Boolean).join(": ") || said;
    } catch {
      // Not XRPC's error shape: the start of the body says it.
    }
    throw new Error(`grain ${res.status}: ${said}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** social.grain.admin.defs#reportView */
export interface Report {
  id: number;
  /** An account's bare DID, or a record's at:// URI. */
  subject: string;
  subjectDid: string;
  /** The label the report asks for. */
  label: string;
  reason?: string;
  reasonType?: string;
  reportedBy: string;
  reportedByHandle?: string;
  status: "open" | "resolved" | "dismissed";
  resolvedBy?: string;
  resolvedAt?: string;
  createdAt: string;
}

/** One page of reports, newest first, from before `cursor`. */
export function listReports(params: { status?: string; label?: string; limit?: number; cursor?: string } = {}) {
  return xrpc<{ reports: Report[]; cursor?: string; total: number }>("social.grain.admin.listReports", { params, admin: true });
}

/** Open reports, newest first, reading pages until `enough` says to stop. */
export async function openReports(enough: (report: Report) => boolean = () => false): Promise<Report[]> {
  const found: Report[] = [];
  let cursor: string | undefined;
  do {
    const page = await listReports({ status: "open", limit: 100, cursor });
    for (const report of page.reports) {
      if (enough(report)) return found;
      found.push(report);
    }
    cursor = page.cursor;
  } while (cursor);
  return found;
}

/** Closes an open report: resolving it gives out the label it asked for, dismissing it does not. */
export function resolveReport(id: number, action: "resolve" | "dismiss") {
  return xrpc<object>("social.grain.admin.resolveReport", { body: { id, action }, admin: true });
}

/** Gives out a label, as grain's labeler, on an account's bare DID or a record's at:// URI. */
export function applyLabel(uri: string, val: string) {
  return xrpc<object>("social.grain.admin.applyLabel", { body: { uri, val }, admin: true });
}

/** The labels grain defines. */
export function listLabelDefinitions() {
  return xrpc<{ definitions: { identifier: string }[] }>("social.grain.admin.listLabelDefinitions", { admin: true });
}

/** Takes an account down: every read leaves it out. */
export function takeDown(did: string) {
  return xrpc<object>("com.atproto.admin.updateSubjectStatus", {
    body: { subject: { $type: "com.atproto.admin.defs#repoRef", did }, takedown: { applied: true } },
    admin: true,
  });
}

/** An account's grain profile, as anyone reads it. */
export function getProfile(actor: string) {
  return xrpc<{ did: string; handle?: string; displayName?: string }>("social.grain.actor.getProfile", {
    params: { actor },
    admin: false,
  });
}
