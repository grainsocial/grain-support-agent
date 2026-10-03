import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import type {
  Fix,
  ItemDetail,
  ItemSummary,
  Options,
  PrRequest,
  QueueResponse,
  ThreadEntry,
  TriageCorrection,
  View,
} from "@workspace/types";
import { summarize, viewTurn } from "./activity.ts";
import { config } from "./config.ts";
import { EVENT, say } from "./conversation.ts";
import { canOpenPr, discardFix, fixDiffs, fixRepos, fixRoot, openPrs, prUrls } from "./fix.ts";
import { transcript } from "./opencode.ts";
import { account } from "./reports.ts";
import { shotsDir, shotsOf } from "./screenshots.ts";
import { counts, get, list, recordFeedback, update, VIEWS, type Item } from "./store.ts";
import { AREAS, KINDS, PLATFORMS } from "./triage.ts";
import { workspace } from "./workspace.ts";

// The dashboard's server: a JSON API under /api, the React app's built files
// for everything else, and the public screenshots under /shots. It has no
// login of its own: Caddy puts basic auth in front of it and adds a key that
// every request but the health check and the screenshots must carry.

const webDist = resolve(import.meta.dirname, "../../web/dist");

// ---------------------------------------------------------------------------
// Shaping items for the API
// ---------------------------------------------------------------------------

/** Whether an agent is working on the item, so the page should keep polling. */
function busy(item: Item): boolean {
  return (
    Boolean(item.chat_pending) ||
    item.status === "investigating" ||
    item.fix_status === "working" ||
    item.status === "new" ||
    shotsOf(item)?.status === "running"
  );
}

function summary(item: Item): ItemSummary {
  return {
    id: item.id,
    source: item.source,
    author: item.author,
    text: item.text,
    url: item.url,
    receivedAt: item.received_at,
    status: item.status,
    triage: item.triage,
    routeReason: item.route_reason,
    fixStatus: item.fix_status,
    working: Boolean(item.chat_pending) || item.status === "investigating" || item.fix_status === "working",
    cost: item.cost,
    subject: item.subject_did ? account(item.subject_did) : null,
    reporter: item.source === "report" && item.author.startsWith("did:") ? account(item.author) : null,
  };
}

/** What a person sent, without the item tag the service adds for the agent's tools. */
const personText = (text: string) => text.replace(/\n\n\(support item #\d+\)$/, "");

/** The conversation with the item's agent, as entries in order. */
async function conversation(item: Item, live: boolean): Promise<ThreadEntry[]> {
  if (!item.session_id) return [];
  const messages = await transcript(item.session_id, workspace).catch(() => []);
  const out: ThreadEntry[] = [];
  for (let i = 0; i < messages.length; i++) {
    const { info, parts } = messages[i];
    if (info.role !== "user") continue;
    let j = i + 1;
    while (j < messages.length && messages[j].info.role === "assistant") j++;
    const view = viewTurn(messages.slice(i + 1, j), workspace, info.time.created);
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => ("text" in p ? p.text : ""))
      .join("\n");

    if (i === 0) {
      const added = text.split("\n\nThe maintainer adds:\n\n")[1];
      if (added) out.push({ kind: "user", text: personText(added) });
      out.push({ kind: "event", text: "Investigation" });
    } else if (text.startsWith(EVENT)) {
      out.push({ kind: "event", text: text.slice(EVENT.length).split("\n\n")[0] });
    } else {
      out.push({ kind: "user", text: personText(text) });
    }
    const isLive = live && j >= messages.length && !view.ended;
    if (isLive || view.steps.length || view.text) {
      out.push({
        kind: "agent",
        who: "Agent",
        steps: view.steps,
        summary: summarize(view.steps),
        text: view.text,
        cost: view.cost,
        live: isLive,
        startedAt: view.startedAt,
      });
    }
    i = j - 1;
  }
  return out;
}

async function fixOf(item: Item): Promise<Fix | null> {
  if (!item.fix_status) return null;
  let live: Fix["live"] = null;
  if (item.fix_status === "working" && item.fix_session_id) {
    const messages = await transcript(item.fix_session_id, fixRoot(item)).catch(() => []);
    const lastUser = messages.map((m) => m.info.role).lastIndexOf("user");
    const view = viewTurn(messages.slice(lastUser + 1), fixRoot(item), messages[lastUser]?.info.time.created ?? Date.now());
    live = {
      kind: "agent",
      who: `Fix agent · ${fixRepos(item).join(", ")}`,
      steps: view.steps,
      summary: summarize(view.steps),
      text: view.text,
      cost: view.cost,
      live: true,
      startedAt: view.startedAt,
    };
  }
  const diffs = item.fix_status === "working" ? [] : await fixDiffs(item);
  const count = (diff: string, sign: "+" | "-") =>
    diff.split("\n").filter((l) => l.startsWith(sign) && !l.startsWith(sign.repeat(3))).length;
  const shots = shotsOf(item);
  const shotUrl = (file: string) => `/shots/${shots!.token}/${file}`;
  return {
    status: item.fix_status,
    repos: fixRepos(item),
    branch: item.fix_branch,
    error: item.fix_error,
    title: item.fix_title,
    body: item.fix_body,
    prUrls: prUrls(item),
    diffs: diffs.map((d) => ({
      repo: d.repo,
      stat: d.stat,
      diff: d.diff,
      added: count(d.diff, "+"),
      removed: count(d.diff, "-"),
      canOpenPr: canOpenPr(d.repo),
    })),
    screenshots: shots
      ? {
          status: shots.status,
          error: shots.error,
          log: shots.log,
          pages: shots.pages.map((p) => ({
            name: p.name,
            path: p.path,
            viewport: p.viewport,
            device: p.device,
            before: p.before ? shotUrl(`${p.name}-before.png`) : undefined,
            after: p.after ? shotUrl(`${p.name}-after.png`) : undefined,
          })),
        }
      : null,
    live,
  };
}

async function detail(item: Item): Promise<ItemDetail> {
  const live = Boolean(item.chat_pending) || item.status === "investigating";
  const thread = await conversation(item, live);
  if (item.status === "investigate") thread.push({ kind: "event", text: "Queued for investigation" });
  if (item.status === "investigating" && !item.session_id) thread.push({ kind: "event", text: "Refreshing the checkouts", tone: "live" });
  if (item.chat_error) thread.push({ kind: "event", text: item.chat_error, tone: "bad" });
  if (item.error && item.status === "failed") thread.push({ kind: "event", text: item.error, tone: "bad" });
  return {
    ...summary(item),
    images: item.images,
    error: item.error,
    chatError: item.chat_error,
    hasSession: Boolean(item.session_id),
    thread,
    fix: await fixOf(item),
    busy: busy(item),
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/** Whether the request came through Caddy, which adds the dashboard key. */
function fromCaddy(req: IncomingMessage): boolean {
  if (!config.dashboardKey) return true;
  const sent = Buffer.from(String(req.headers["x-dashboard-key"] ?? ""));
  const key = Buffer.from(config.dashboardKey);
  return sent.length === key.length && timingSafeEqual(sent, key);
}

// Basic auth is something the browser sends with any request to this origin,
// including one from another site. Refuse cross-site writes.
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return false;
  return true;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200_000) throw new Error("request too large");
  }
  return (raw ? JSON.parse(raw) : {}) as T;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

/** The built web app; any path that is not a file gets index.html, for the client router. */
function serveApp(res: ServerResponse, pathname: string): void {
  const file = normalize(join(webDist, pathname));
  const target = file.startsWith(webDist) && existsSync(file) && statSync(file).isFile() ? file : join(webDist, "index.html");
  if (!existsSync(target)) return json(res, 503, { error: "the web app is not built" });
  const hashed = target.includes(`${webDist}/assets/`);
  res.writeHead(200, {
    "content-type": TYPES[extname(target)] ?? "application/octet-stream",
    "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    "x-frame-options": "DENY",
  });
  createReadStream(target).pipe(res);
}

const OPTIONS: Options = { kinds: KINDS, areas: AREAS, platforms: PLATFORMS };

async function api(req: IncomingMessage, res: ServerResponse, path: string, url: URL, onInvestigate: () => void): Promise<void> {
  if (req.method === "GET" && path === "/options") return json(res, 200, OPTIONS);

  if (req.method === "GET" && path === "/items") {
    const requested = url.searchParams.get("view") ?? "inbox";
    const view = (requested in VIEWS ? requested : "inbox") as View;
    const n = counts();
    const body: QueueResponse = {
      view,
      views: (Object.keys(VIEWS) as View[]).map((v) => ({ view: v, label: VIEWS[v].label, count: n[v] })),
      items: list(view).map(summary),
    };
    return json(res, 200, body);
  }

  const match = path.match(/^\/items\/(\d+)(?:\/([\w-]+))?$/);
  const item = match ? get(Number(match[1])) : undefined;
  if (!match || !item) return json(res, 404, { error: "not found" });
  const action = match[2];

  if (req.method === "GET" && !action) return json(res, 200, await detail(item));
  if (req.method === "GET" && action === "patch") {
    const repo = url.searchParams.get("repo") ?? "";
    const found = (await fixDiffs(item)).find((d) => d.repo === repo);
    if (!found) return json(res, 404, { error: "no change in that repository" });
    res.writeHead(200, {
      "content-type": "text/x-diff; charset=utf-8",
      "content-disposition": `attachment; filename="${repo}-${item.id}.patch"`,
    });
    return void res.end(found.diff);
  }

  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
  if (!sameOrigin(req)) return json(res, 403, { error: "refused" });

  switch (action) {
    case "messages": {
      const { message } = await readJson<{ message?: string }>(req);
      if (!message?.trim()) return json(res, 400, { error: "say something" });
      if (item.status === "investigate") return json(res, 409, { error: "wait for the investigation to start" });
      say(item, message.trim()).catch(console.error);
      break;
    }
    case "investigate":
      update(item.id, { status: "investigate", error: "" });
      onInvestigate();
      break;
    case "done":
      update(item.id, { status: "done" });
      break;
    case "dismiss":
      update(item.id, { status: "dismissed", route_reason: "dismissed by hand" });
      break;
    case "triage": {
      if (!item.triage) return json(res, 409, { error: "not triaged yet" });
      const fields = await readJson<TriageCorrection>(req);
      const triage = { ...item.triage };
      for (const [field, allowed] of [["kind", KINDS], ["area", AREAS], ["platform", PLATFORMS]] as const) {
        const value = fields[field];
        if (value && value in allowed && value !== triage[field]) {
          recordFeedback(item.id, field, triage[field], value);
          triage[field] = value;
        }
      }
      update(item.id, { triage });
      break;
    }
    case "pr": {
      const { title, body } = await readJson<PrRequest>(req);
      try {
        await openPrs(item, title ?? "", body ?? "");
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        update(item.id, { fix_error: error });
        return json(res, 502, { error });
      }
      break;
    }
    case "discard-fix":
      if (item.fix_status === "working") return json(res, 409, { error: "the fix agent is still working" });
      await discardFix(item);
      break;
    default:
      return json(res, 404, { error: "not found" });
  }
  json(res, 200, await detail(get(item.id)!));
}

export function startWeb(port: number, onInvestigate: () => void): void {
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/_health") return void res.end("ok");

      // Screenshots are public, so a pull request can show them; Caddy leaves
      // this path outside basic auth. The token in the path is the only key.
      const shot = url.pathname.match(/^\/shots\/([\w-]{16,64})\/([\w-]{1,80}\.png)$/);
      if (req.method === "GET" && shot) {
        const file = join(shotsDir, shot[1], shot[2]);
        if (!existsSync(file)) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" });
        return void createReadStream(file).pipe(res);
      }

      if (!fromCaddy(req)) return json(res, 403, { error: "refused" });
      if (url.pathname.startsWith("/api/")) return await api(req, res, url.pathname.slice(4), url, onInvestigate);
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      serveApp(res, url.pathname);
    } catch (err) {
      console.error(err);
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }).listen(port, () => console.log(`dashboard on :${port}`));
}
