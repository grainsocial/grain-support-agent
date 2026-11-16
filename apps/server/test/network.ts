// A fake of the network the server reads: plc.directory, one PDS, grain-serve
// at http://grain.test and Bluesky's public appview. Tests set GRAIN_URL,
// GRAIN_MOD_IDENTIFIER and GRAIN_MOD_APP_PASSWORD to match before importing.

import type { Report } from "../src/grain.ts";

export const GRAIN = "http://grain.test";
export const SERVICE_DID = "did:web:grain.test";
export const MODERATOR = "did:plc:moderator";
const PDS = "https://pds.test";

/** A procedure's input, as the fake reads it. */
export type Body = { id?: number; action?: string; [key: string]: unknown };

export interface Call {
  nsid: string;
  body: Body;
  auth: string | null;
}

export const network = {
  reports: [] as Report[],
  /** Records on the PDS, by at:// URI. */
  records: new Map<string, { [key: string]: unknown }>(),
  /** grain profiles, by DID. */
  profiles: new Map<string, { handle: string; displayName?: string }>(),
  /** Calls to grain-serve's methods that change something, in order. */
  calls: [] as Call[],
  /** The lxm of each service token minted. */
  minted: [] as string[],
  /** When set, grain-serve refuses every admin call with this status. */
  refuse: 0,
};

function token(lxm: string): string {
  const payload = { iss: MODERATOR, aud: SERVICE_DID, lxm, exp: Math.floor(Date.now() / 1000) + 60 };
  return `x.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.y`;
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const bad = (status: number, error: string, message = "") => new Response(JSON.stringify({ error, message }), { status });

function grain(nsid: string, q: URLSearchParams, body: Body, auth: string | null): Response {
  if (nsid === "social.grain.actor.getProfile") {
    const p = network.profiles.get(q.get("actor") ?? "");
    return p ? ok({ did: q.get("actor"), ...p }) : bad(400, "NotFound");
  }
  const lxm = auth && JSON.parse(Buffer.from(auth.split(".")[1], "base64url").toString()).lxm;
  if (lxm !== nsid) return bad(401, "AuthenticationRequired");
  if (network.refuse) return bad(network.refuse, "Forbidden", `${MODERATOR} is not an admin of this server`);
  switch (nsid) {
    case "social.grain.admin.listReports": {
      const before = Number(q.get("cursor") ?? Infinity);
      const limit = Number(q.get("limit") ?? 50);
      const matching = network.reports
        .filter((r) => r.status === (q.get("status") ?? "open") && r.id < before)
        .sort((a, b) => b.id - a.id);
      const page = matching.slice(0, limit);
      return ok({ reports: page, total: matching.length, ...(matching.length > limit ? { cursor: String(page.at(-1)!.id) } : {}) });
    }
    case "social.grain.admin.listLabelDefinitions":
      return ok({ definitions: [{ identifier: "nudity" }, { identifier: "spam" }, { identifier: "!hide" }] });
    case "social.grain.admin.resolveReport": {
      const r = network.reports.find((r) => r.id === body.id && r.status === "open");
      if (!r) return bad(400, "ReportNotFound");
      r.status = body.action === "resolve" ? "resolved" : "dismissed";
      break;
    }
    case "social.grain.admin.applyLabel":
    case "com.atproto.admin.updateSubjectStatus":
      break;
    default:
      return bad(501, "MethodNotImplemented");
  }
  network.calls.push({ nsid, body, auth });
  return ok({});
}

function pds(nsid: string, q: URLSearchParams, auth: string | null): Response {
  switch (nsid) {
    case "com.atproto.server.createSession":
      return ok({ did: MODERATOR, accessJwt: "access", refreshJwt: "refresh" });
    case "com.atproto.server.getServiceAuth": {
      if (auth !== "Bearer access") return bad(401, "AuthenticationRequired");
      if (q.get("aud") !== SERVICE_DID) return bad(400, "InvalidRequest");
      network.minted.push(q.get("lxm")!);
      return ok({ token: token(q.get("lxm")!) });
    }
    case "com.atproto.repo.getRecord": {
      const uri = `at://${q.get("repo")}/${q.get("collection")}/${q.get("rkey")}`;
      const value = network.records.get(uri);
      return value ? ok({ uri, value }) : bad(400, "RecordNotFound");
    }
    case "com.atproto.repo.listRecords": {
      const prefix = `at://${q.get("repo")}/${q.get("collection")}/`;
      const records = [...network.records].filter(([uri]) => uri.startsWith(prefix)).map(([uri, value]) => ({ uri, value }));
      return ok({ records });
    }
    default:
      return bad(501, "MethodNotImplemented");
  }
}

export function install(): void {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    const body: Body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.origin === "https://plc.directory") {
      return ok({ id: url.pathname.slice(1), service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: PDS }] });
    }
    const nsid = url.pathname.replace(/^\/xrpc\//, "");
    if (url.origin === GRAIN) return grain(nsid, url.searchParams, body, auth);
    if (url.origin === PDS) return pds(nsid, url.searchParams, auth);
    return bad(404, "NotFound");
  }) as typeof fetch;
}

/** A report as grain-serve lists it. */
export function report(r: Partial<Report> & Pick<Report, "id" | "subject" | "subjectDid" | "label" | "reportedBy">): Report {
  network.reports.push({ status: "open", createdAt: "2026-11-16T00:00:00.000Z", ...r });
  return network.reports.at(-1)!;
}
