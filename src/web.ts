import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AREAS, KINDS, PLATFORMS } from "./triage.ts";
import { counts, get, list, recordFeedback, update, type Item, type Status } from "./store.ts";

// The dashboard. Server-rendered HTML, no client JavaScript. It has no login of
// its own: Caddy puts basic auth in front of it, and inside the compose network
// nothing else talks to it.

const VIEWS: Record<string, { label: string; statuses: Status[] }> = {
  inbox: { label: "Needs you", statuses: ["needs_review", "reported", "failed"] },
  working: { label: "In progress", statuses: ["new", "investigate", "investigating"] },
  triaged: { label: "Triaged", statuses: ["triaged"] },
  done: { label: "Done", statuses: ["done"] },
  dismissed: { label: "Dismissed", statuses: ["dismissed"] },
};

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root {
  --bg: #fafaf9; --surface: #ffffff; --text: #1c1917; --muted: #78716c;
  --border: #e7e5e4; --accent: #2563eb; --warn: #b45309; --bad: #b91c1c; --ok: #15803d;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0a09; --surface: #1c1917; --text: #f5f5f4; --muted: #a8a29e;
    --border: #292524; --accent: #60a5fa; --warn: #f59e0b; --bad: #f87171; --ok: #4ade80;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
a { color: var(--accent); }
h1 { font-size: 20px; margin: 0 0 16px; }
nav { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 16px; }
nav a { padding: 6px 12px; border-radius: 6px; text-decoration: none; color: var(--muted); }
nav a.on { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-bottom: 8px; }
.row { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; flex-wrap: wrap; }
.meta { color: var(--muted); font-size: 13px; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; }
.pill { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
.pill.bug, .pill.failed { color: var(--bad); border-color: currentColor; }
.pill.reported, .pill.investigating { color: var(--accent); border-color: currentColor; }
.pill.needs_review { color: var(--warn); border-color: currentColor; }
.report { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.55 ui-monospace, monospace; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; overflow-x: auto; }
table { border-collapse: collapse; font-size: 14px; }
td { padding: 2px 12px 2px 0; }
form { display: inline; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
button, select { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
img { max-width: 160px; max-height: 160px; border-radius: 6px; margin: 8px 8px 0 0; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function card(item: Item): string {
  const t = item.triage;
  return `<div class="card">
  <div class="row">
    <a href="/item/${item.id}"><strong>#${item.id}</strong> ${esc(item.source === "bluesky" ? `@${item.author}` : "In-app report")}</a>
    <span>
      ${t ? `<span class="pill ${esc(t.kind)}">${esc(t.kind)}</span> <span class="pill">${esc(t.area)}</span>${t.platform !== "unknown" ? ` <span class="pill">${esc(t.platform)}</span>` : ""}` : ""}
      <span class="pill ${esc(item.status)}">${esc(item.status.replace("_", " "))}</span>
    </span>
  </div>
  <p class="text">${esc(item.text.slice(0, 280))}${item.text.length > 280 ? "…" : ""}</p>
  <div class="meta">${esc(new Date(item.received_at).toLocaleString("en-US", { timeZone: "UTC" }))} UTC${item.route_reason ? ` · ${esc(item.route_reason)}` : ""}</div>
</div>`;
}

function dashboard(view: string): string {
  const v = VIEWS[view] ?? VIEWS.inbox;
  const n = counts();
  const tabs = Object.entries(VIEWS)
    .map(([key, { label, statuses }]) => {
      const total = statuses.reduce((sum, s) => sum + (n[s] ?? 0), 0);
      return `<a href="/?view=${key}" class="${v === VIEWS[key] ? "on" : ""}">${label} (${total})</a>`;
    })
    .join("");
  const items = list(v.statuses);
  return page(
    "grain support",
    `<h1>grain support</h1><nav>${tabs}</nav>${items.length ? items.map(card).join("") : `<p class="meta">Nothing here.</p>`}`,
  );
}

function options(choices: Record<string, string>, selected: string | undefined): string {
  return Object.keys(choices)
    .map((k) => `<option value="${k}"${k === selected ? " selected" : ""}>${k.replace("_", " ")}</option>`)
    .join("");
}

function detail(item: Item): string {
  const t = item.triage;
  const triage = t
    ? `<table>
        <tr><td class="meta">About grain</td><td>${(t.relevant * 100).toFixed(0)}%</td></tr>
        <tr><td class="meta">Kind</td><td>${esc(t.kind)} (${(t.kindConfidence * 100).toFixed(0)}% confident)</td></tr>
        <tr><td class="meta">Area</td><td>${esc(t.area)}</td></tr>
        <tr><td class="meta">Platform</td><td>${esc(t.platform)}</td></tr>
        <tr><td class="meta">Severity</td><td>${t.severity.toFixed(1)} of 3</td></tr>
        <tr><td class="meta">Expects a reply</td><td>${(t.needsReply * 100).toFixed(0)}%</td></tr>
      </table>
      <form method="post" action="/item/${item.id}/correct" class="actions">
        <select name="kind">${options(KINDS, t.kind)}</select>
        <select name="area">${options(AREAS, t.area)}</select>
        <select name="platform">${options(PLATFORMS, t.platform)}</select>
        <button>Correct triage</button>
      </form>`
    : `<p class="meta">Not triaged yet.</p>`;

  const action = (name: string, label: string, primary = false) =>
    `<form method="post" action="/item/${item.id}/${name}"><button${primary ? ' class="primary"' : ""}>${label}</button></form>`;

  return page(
    `#${item.id} grain support`,
    `<p><a href="/">Back to the queue</a></p>
<div class="card">
  <div class="row">
    <strong>#${item.id} ${esc(item.source === "bluesky" ? `@${item.author}` : `Report by ${item.author}`)}</strong>
    <span class="pill ${esc(item.status)}">${esc(item.status.replace("_", " "))}</span>
  </div>
  <p class="text">${esc(item.text)}</p>
  ${item.images.map((src) => `<a href="${esc(src)}"><img src="${esc(src)}" alt="Attached image"></a>`).join("")}
  <div class="meta"><a href="${esc(item.url)}">${esc(item.url)}</a></div>
  <div class="actions">
    ${item.status !== "investigating" ? action("investigate", item.report ? "Investigate again" : "Investigate", !item.report) : ""}
    ${item.status !== "done" ? action("done", "Mark done") : ""}
    ${item.status !== "dismissed" ? action("dismiss", "Dismiss") : ""}
  </div>
</div>
<div class="card"><h2 style="font-size:16px;margin:0 0 8px">Triage</h2>${triage}
  ${item.route_reason ? `<p class="meta">Routed: ${esc(item.route_reason)}</p>` : ""}</div>
${item.error ? `<div class="card"><h2 style="font-size:16px;margin:0 0 8px;color:var(--bad)">Error</h2><div class="report">${esc(item.error)}</div></div>` : ""}
${
  item.report || item.status === "investigating"
    ? `<div class="card"><div class="row"><h2 style="font-size:16px;margin:0 0 8px">Investigation</h2>
        <span class="meta">${item.cost ? `$${item.cost.toFixed(4)}` : ""}${item.session_id ? ` · session ${esc(item.session_id)}` : ""}</span></div>
        ${item.report ? `<div class="report">${esc(item.report)}</div>` : `<p class="meta">Running. Refresh to check.</p>`}</div>`
    : ""
}`,
  );
}

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) break;
  }
  return new URLSearchParams(body);
}

// Basic auth is something the browser sends with any request to this origin,
// including a form posted from another site. Refuse cross-site writes.
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) return false;
  return true;
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" });
  res.end(html);
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(303, { location: to });
  res.end();
}

export function startWeb(port: number, onInvestigate: () => void): void {
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/_health") return send(res, 200, "ok");
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, dashboard(url.searchParams.get("view") ?? "inbox"));

      const match = url.pathname.match(/^\/item\/(\d+)(?:\/(\w+))?$/);
      const item = match ? get(Number(match[1])) : undefined;
      if (!match || !item) return send(res, 404, page("Not found", "<p>Not found.</p>"));

      if (req.method === "GET" && !match[2]) return send(res, 200, detail(item));
      if (req.method !== "POST" || !sameOrigin(req)) return send(res, 403, page("Refused", "<p>Refused.</p>"));

      switch (match[2]) {
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
        case "correct": {
          const fields = await form(req);
          if (!item.triage) break;
          const triage = { ...item.triage };
          for (const [field, allowed] of [["kind", KINDS], ["area", AREAS], ["platform", PLATFORMS]] as const) {
            const value = fields.get(field);
            if (value && value in allowed && value !== triage[field]) {
              recordFeedback(item.id, field, triage[field], value);
              triage[field] = value;
            }
          }
          update(item.id, { triage });
          break;
        }
        default:
          return send(res, 404, page("Not found", "<p>Not found.</p>"));
      }
      redirect(res, `/item/${item.id}`);
    } catch (err) {
      console.error(err);
      send(res, 500, page("Error", `<p>${esc(err instanceof Error ? err.message : err)}</p>`));
    }
  }).listen(port, () => console.log(`dashboard on :${port}`));
}
