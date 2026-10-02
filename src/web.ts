import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import MarkdownIt from "markdown-it";
import { summarize, viewTurn, type Step, type TurnView } from "./activity.ts";
import { EVENT, say } from "./conversation.ts";
import { config } from "./config.ts";
import { canOpenPr, discardFix, fixDiffs, fixRepos, fixRoot, openPrs, prUrls } from "./fix.ts";
import { shotsDir, shotsOf } from "./screenshots.ts";
import { transcript } from "./opencode.ts";
import { counts, get, list, recordFeedback, update, VIEWS, type Item, type View } from "./store.ts";
import { AREAS, KINDS, PLATFORMS } from "./triage.ts";
import { workspace } from "./workspace.ts";

// The dashboard: the queue, and each item as a conversation with its agent.
// Server-rendered HTML; the only client script refreshes the thread while an
// agent works. It has no login of its own: Caddy puts basic auth in front of
// it, and inside the compose network nothing else talks to it.

// Agent text is written by a model that has read untrusted text, so it renders
// with raw HTML off and images disabled: an image URL in it would be fetched
// the moment the page opens, which is how a prompt injection would carry data
// out. Links stay, since nothing follows a link until it is clicked.
const markdown = new MarkdownIt({ html: false, linkify: true }).disable("image");
const defaultLink = markdown.renderer.rules.link_open ?? ((tokens, i, opts, _env, self) => self.renderToken(tokens, i, opts));
markdown.renderer.rules.link_open = (tokens, i, opts, env, self) => {
  tokens[i].attrSet("rel", "noopener noreferrer nofollow");
  tokens[i].attrSet("target", "_blank");
  return defaultLink(tokens, i, opts, env, self);
};

export const renderReport = (report: string) => markdown.render(report);

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// While an agent works, fetch the thread every few seconds and swap it in.
// The message box sits outside the thread, so a half-typed message survives.
// Cmd or Ctrl+Enter sends.
const SCRIPT = (id: number, busy: boolean) => `<script>
const box = document.getElementById("message");
box?.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) box.form.requestSubmit(); });
const nearBottom = () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
${busy ? "window.scrollTo(0, document.body.scrollHeight);" : ""}
(function poll(busy) {
  if (!busy) return;
  setTimeout(async () => {
    try {
      const stick = nearBottom();
      const res = await fetch("/item/${id}/thread");
      const next = await res.json();
      document.getElementById("thread").innerHTML = next.html;
      document.getElementById("status").innerHTML = next.status;
      if (stick) window.scrollTo(0, document.body.scrollHeight);
      busy = next.busy;
    } catch {}
    poll(busy);
  }, 2500);
})(${busy});
</script>`;

function page(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root {
  --bg: #fafaf9; --surface: #ffffff; --text: #1c1917; --muted: #78716c; --mine: #eff6ff;
  --border: #e7e5e4; --accent: #2563eb; --warn: #b45309; --bad: #b91c1c; --ok: #15803d;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0a09; --surface: #1c1917; --text: #f5f5f4; --muted: #a8a29e; --mine: #172033;
    --border: #292524; --accent: #60a5fa; --warn: #f59e0b; --bad: #f87171; --ok: #4ade80;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 24px 16px 32px; }
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
.pill.needs_review, .pill.fix-ready { color: var(--warn); border-color: currentColor; }
.pill.fix-working { color: var(--accent); border-color: currentColor; }
.pill.fix-failed { color: var(--bad); border-color: currentColor; }
.pill.fix-pr_open { color: var(--ok); border-color: currentColor; }
.markdown { overflow-wrap: anywhere; }
.markdown h1, .markdown h2, .markdown h3 { font-size: 15px; margin: 18px 0 6px; }
.markdown > :first-child { margin-top: 0; }
.markdown > :last-child { margin-bottom: 0; }
.markdown p, .markdown ul, .markdown ol { margin: 0 0 10px; }
.markdown ul, .markdown ol { padding-left: 22px; }
.markdown code { font: 13px ui-monospace, monospace; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
.markdown pre { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; overflow-x: auto; }
.markdown pre code { border: 0; padding: 0; background: none; }
.markdown table { display: block; overflow-x: auto; margin-bottom: 10px; border-collapse: collapse; }
.markdown th, .markdown td { border: 1px solid var(--border); padding: 4px 8px; text-align: left; }
.markdown blockquote { margin: 0 0 10px; padding-left: 12px; border-left: 3px solid var(--border); color: var(--muted); }

.thread { display: flex; flex-direction: column; gap: 14px; margin: 16px 0; }
.msg { max-width: 100%; }
.msg .who { font-size: 12px; color: var(--muted); margin-bottom: 4px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.bubble { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
.msg.mine { align-self: flex-end; max-width: 85%; }
.msg.mine .who { justify-content: flex-end; }
.msg.mine .bubble { background: var(--mine); white-space: pre-wrap; overflow-wrap: anywhere; }
.event { align-self: center; font-size: 13px; color: var(--muted); text-align: center; max-width: 90%; }
.event a { color: inherit; }
.event.bad { color: var(--bad); }
.work { font-size: 13px; color: var(--muted); margin: 0 0 8px; }
.work summary { cursor: pointer; }
.steps { list-style: none; padding: 0; margin: 6px 0 0; font-size: 13px; }
.steps li { display: flex; gap: 8px; padding: 1px 0; }
.steps .mark { width: 14px; flex: none; text-align: center; }
.steps .done .mark { color: var(--ok); }
.steps .failed .mark { color: var(--bad); }
.steps .running .mark { color: var(--accent); }
.steps code { font-size: 12px; overflow-wrap: anywhere; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.25; } }
@media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
.live-text { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--muted); }

.fixcard { border-color: var(--accent); }
.fixcard h3 { font-size: 14px; margin: 0; }
.fixcard details.repo { margin-top: 10px; }
.fixcard details.repo summary { cursor: pointer; font-size: 13px; }
.diff { font: 12px/1.45 ui-monospace, monospace; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 8px 0; overflow-x: auto; white-space: pre; margin-top: 6px; }
.diff span { display: block; padding: 0 12px; }
.diff .add { background: color-mix(in srgb, var(--ok) 14%, transparent); }
.diff .del { background: color-mix(in srgb, var(--bad) 14%, transparent); }
.diff .hunk { color: var(--accent); }
.diff .file { font-weight: 600; }

.composer { position: sticky; bottom: 0; background: linear-gradient(transparent, var(--bg) 18px); padding: 18px 0 16px; }
.composer form { display: flex; gap: 8px; align-items: flex-end; }
.composer textarea { flex: 1; min-height: 48px; max-height: 40vh; }
textarea, input[type=text] { font: inherit; width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); }
textarea { resize: vertical; }
form.stack { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
form { margin: 0; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
button, select { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.link { border: 0; background: none; padding: 0; color: var(--accent); font-size: 13px; }
details.triage-fix summary { cursor: pointer; }
img { max-width: 160px; max-height: 160px; border-radius: 6px; margin: 8px 8px 0 0; }
</style>
</head>
<body><main>${body}</main>${script}</body>
</html>`;
}

const FIX_PILL: Record<string, string> = { working: "fixing", ready: "fix ready", failed: "fix failed", pr_open: "PR open" };

function pills(item: Item): string {
  const t = item.triage;
  return [
    t ? `<span class="pill ${esc(t.kind)}">${esc(t.kind.replace("_", " "))}</span>` : "",
    t ? `<span class="pill">${esc(t.area)}</span>` : "",
    t && t.platform !== "unknown" ? `<span class="pill">${esc(t.platform)}</span>` : "",
    `<span class="pill ${esc(item.status)}">${esc(item.status.replace("_", " "))}</span>`,
    item.fix_status ? `<span class="pill fix-${esc(item.fix_status)}">${FIX_PILL[item.fix_status]}</span>` : "",
    item.chat_pending ? `<span class="pill investigating">working</span>` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function card(item: Item): string {
  return `<div class="card">
  <div class="row">
    <a href="/item/${item.id}"><strong>#${item.id}</strong> ${esc(item.source === "bluesky" ? `@${item.author}` : "In-app report")}</a>
    <span>${pills(item)}</span>
  </div>
  <p class="text">${esc(item.text.slice(0, 280))}${item.text.length > 280 ? "…" : ""}</p>
  <div class="meta">${esc(new Date(item.received_at).toLocaleString("en-US", { timeZone: "UTC" }))} UTC${item.route_reason ? ` · ${esc(item.route_reason)}` : ""}</div>
</div>`;
}

function dashboard(requested: string): string {
  const view: View = requested in VIEWS ? (requested as View) : "inbox";
  const n = counts();
  const tabs = (Object.keys(VIEWS) as View[])
    .map((key) => `<a href="/?view=${key}" class="${key === view ? "on" : ""}">${VIEWS[key].label} (${n[key]})</a>`)
    .join("");
  const items = list(view);
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

// ---------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------

const STEP_MARK = { running: "…", done: "✓", failed: "✗" };

function stepList(steps: Step[]): string {
  return `<ul class="steps">${steps
    .map((st) => `<li class="${st.state}"><span class="mark">${STEP_MARK[st.state]}</span><span>${esc(st.label)}${st.detail ? ` <code>${esc(st.detail.slice(0, 200))}</code>` : ""}</span></li>`)
    .join("")}</ul>`;
}

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** An agent's turn: its work folded into one line, then what it said. Live while it runs. */
function agentMessage(view: TurnView, live: boolean, who = "Agent"): string {
  const shown = view.steps.slice(-25);
  const work = live
    ? `<div class="work"><span class="dot"></span> Working · ${elapsed(Date.now() - view.startedAt)}${view.steps.length ? ` · ${view.steps.length} steps` : ""}${view.cost ? ` · $${view.cost.toFixed(4)}` : ""}${shown.length ? stepList(shown) : ""}</div>`
    : view.steps.length
      ? `<details class="work"><summary>${esc(summarize(view.steps))}${view.cost ? ` · $${view.cost.toFixed(4)}` : ""}</summary>${stepList(view.steps)}</details>`
      : "";
  const body = view.text
    ? live
      ? `<div class="live-text">${esc(view.text.slice(-800))}</div>`
      : `<div class="markdown">${renderReport(view.text)}</div>`
    : "";
  if (!work && !body) return "";
  return `<div class="msg"><div class="who">${esc(who)}</div><div class="bubble">${work}${body}</div></div>`;
}

const event = (html: string, bad = false) => `<div class="event${bad ? " bad" : ""}">${html}</div>`;

function triageEvent(item: Item): string {
  const t = item.triage;
  if (!t) return item.status === "new" ? event("Waiting for triage") : "";
  const summary = [t.kind.replace("_", " "), t.area, t.platform !== "unknown" ? t.platform : "", `severity ${t.severity.toFixed(1)}`]
    .filter(Boolean)
    .join(" · ");
  // The routing reason only says something new when it is not just the kind again.
  const reason = item.route_reason && !item.route_reason.startsWith(t.kind) ? ` · ${esc(item.route_reason)}` : "";
  return event(`Triaged: ${esc(summary)}${reason}
    <details class="triage-fix"><summary class="meta">correct</summary>
      <form method="post" action="/item/${item.id}/correct" class="actions" style="justify-content:center;margin-top:6px">
        <select name="kind">${options(KINDS, t.kind)}</select>
        <select name="area">${options(AREAS, t.area)}</select>
        <select name="platform">${options(PLATFORMS, t.platform)}</select>
        <button>Save</button>
      </form>
    </details>`);
}

function postMessage(item: Item): string {
  const who = item.source === "bluesky" ? `@${item.author} on Bluesky` : `In-app report by ${item.author}`;
  return `<div class="msg"><div class="who">${esc(who)} · ${esc(new Date(item.received_at).toLocaleString("en-US", { timeZone: "UTC" }))} UTC · <a href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">open</a></div>
    <div class="bubble"><div class="text" style="margin:0">${esc(item.text)}</div>
    ${item.images.map((src) => `<a href="${esc(src)}"><img src="${esc(src)}" alt="Attached image"></a>`).join("")}</div></div>`;
}

/** What a person sent, without the item tag the service adds for the agent's tools. */
const personText = (text: string) => text.replace(/\n\n\(support item #\d+\)$/, "");

async function conversation(item: Item, live: boolean): Promise<string> {
  if (!item.session_id) return "";
  const messages = await transcript(item.session_id, workspace).catch(() => []);
  const out: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const { info, parts } = messages[i];
    if (info.role !== "user") continue;
    let j = i + 1;
    while (j < messages.length && messages[j].info.role === "assistant") j++;
    const view = viewTurn(messages.slice(i + 1, j), workspace, info.time.created);
    const isLast = j >= messages.length;
    const text = parts
      .filter((p) => p.type === "text")
      .map((p) => ("text" in p ? p.text : ""))
      .join("\n");

    if (i === 0) {
      const added = text.split("\n\nThe maintainer adds:\n\n")[1];
      if (added) out.push(`<div class="msg mine"><div class="who">You</div><div class="bubble">${esc(personText(added))}</div></div>`);
      out.push(event("Investigation"));
    } else if (text.startsWith(EVENT)) {
      out.push(event(esc(text.slice(EVENT.length).split("\n\n")[0])));
    } else {
      out.push(`<div class="msg mine"><div class="who">You</div><div class="bubble">${esc(personText(text))}</div></div>`);
    }
    out.push(agentMessage(view, live && isLast && !view.ended));
    i = j - 1;
  }
  return out.join("");
}

function renderDiff(diff: string): string {
  const lines = diff.split("\n").map((line) => {
    const cls = line.startsWith("diff --git")
      ? "file"
      : line.startsWith("@@")
        ? "hunk"
        : line.startsWith("+") && !line.startsWith("+++")
          ? "add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "del"
            : "";
    return `<span${cls ? ` class="${cls}"` : ""}>${esc(line) || " "}</span>`;
  });
  return `<div class="diff">${lines.join("")}</div>`;
}

function screenshotBlock(item: Item): string {
  const shots = shotsOf(item);
  if (!shots) return "";
  if (shots.status === "running") return `<p class="meta" style="margin:10px 0 0"><span class="dot"></span> Taking before and after screenshots of ${shots.pages.length} page${shots.pages.length === 1 ? "" : "s"}</p>`;
  if (shots.status === "failed") {
    return `<details class="repo"><summary style="color:var(--bad)">Screenshots failed: ${esc(shots.error ?? "")}</summary><pre class="meta" style="white-space:pre-wrap;max-height:300px;overflow:auto">${esc(shots.log ?? "")}</pre></details>`;
  }
  const img = (file: string, ok: boolean) => (ok ? `<a href="/shots/${esc(shots.token)}/${esc(file)}" target="_blank"><img src="/shots/${esc(shots.token)}/${esc(file)}" alt="" style="max-width:100%;max-height:none;margin:0;border:1px solid var(--border)"></a>` : `<p class="meta">not taken</p>`);
  return `<details class="repo" open><summary><strong>Screenshots</strong> <span class="meta">before and after, on seed data</span></summary>
    ${shots.pages
      .map(
        (p) => `<p class="meta" style="margin:10px 0 4px"><code>${esc(p.path)}</code> ${esc(p.viewport)}${p.device === "default" ? "" : `, ${esc(p.device)}`}</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;max-width:${p.viewport === "mobile" ? "560px" : "100%"}">
        <div><div class="meta">Before</div>${img(`${p.name}-before.png`, p.before)}</div>
        <div><div class="meta">After</div>${img(`${p.name}-after.png`, p.after)}</div>
      </div>`,
      )
      .join("")}</details>`;
}

/** The fix, as the latest thing in the thread: live while it runs, then the diff and the approval. */
async function fixCard(item: Item): Promise<string> {
  if (!item.fix_status) return "";
  const where = esc(fixRepos(item).join(", "));

  if (item.fix_status === "working") {
    if (!item.fix_session_id) return event(`<span class="dot"></span> Preparing checkouts of ${where} for the fix`);
    const messages = await transcript(item.fix_session_id, fixRoot(item)).catch(() => []);
    const lastUser = messages.map((m) => m.info.role).lastIndexOf("user");
    const view = viewTurn(messages.slice(lastUser + 1), fixRoot(item), messages[lastUser]?.info.time.created ?? Date.now());
    return agentMessage(view, true, `Fix agent · ${fixRepos(item).join(", ")}`);
  }
  if (item.fix_status === "failed") {
    return `<div class="card fixcard"><h3 style="color:var(--bad)">The fix in ${where} failed</h3>
      <p class="meta">${esc(item.fix_error)}</p>
      <form method="post" action="/item/${item.id}/discard_fix"><button>Discard it</button></form></div>`;
  }

  const diffs = await fixDiffs(item);
  const urls = prUrls(item);
  const prRepos = diffs.map((d) => d.repo).filter(canOpenPr);
  const patchRepos = diffs.map((d) => d.repo).filter((r) => !canOpenPr(r));
  const added = (d: { diff: string }) => d.diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
  const removed = (d: { diff: string }) => d.diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

  const approval = prRepos.length
    ? `<form method="post" action="/item/${item.id}/pr" class="stack">
        <input type="text" name="title" value="${esc(item.fix_title)}" placeholder="Pull request title" required aria-label="Pull request title">
        <textarea name="body" style="min-height:120px" aria-label="Pull request description">${esc(item.fix_body)}</textarea>
        <div class="actions">
          <button class="primary">${prRepos.every((r) => urls[r]) ? "Push update" : "Open draft pull request"}${prRepos.length > 1 ? "s" : ""} in ${esc(prRepos.join(" and "))}</button>
          ${patchRepos.map((r) => `<a href="/item/${item.id}/fix.patch?repo=${encodeURIComponent(r)}">Download ${esc(r)} patch</a>`).join("")}
        </div>
      </form>`
    : `<div class="actions" style="margin-top:10px">${patchRepos.map((r) => `<a href="/item/${item.id}/fix.patch?repo=${encodeURIComponent(r)}"><button type="button" class="primary">Download ${esc(r)} patch</button></a>`).join("")}</div>`;

  return `<div class="card fixcard">
    <div class="row"><h3>Fix in ${where}</h3><span class="meta"><code>${esc(item.fix_branch)}</code></span></div>
    ${Object.entries(urls).map(([r, u]) => `<p style="margin:6px 0 0">Draft pull request in ${esc(r)}: <a href="${esc(u)}">${esc(u)}</a></p>`).join("")}
    ${item.fix_error ? `<p style="color:var(--bad);margin:6px 0 0">${esc(item.fix_error)}</p>` : ""}
    ${
      diffs.length
        ? diffs.map((d) => `<details class="repo"><summary><strong>${esc(d.repo)}</strong> <span class="meta">+${added(d)} −${removed(d)}</span></summary><pre class="meta" style="margin:6px 0 0;white-space:pre-wrap">${esc(d.stat.trim())}</pre>${renderDiff(d.diff)}</details>`).join("")
        : `<p class="meta">The fix agent made no changes.</p>`
    }
    ${screenshotBlock(item)}
    ${diffs.length ? approval : ""}
    <div class="actions" style="margin-top:8px"><form method="post" action="/item/${item.id}/discard_fix"><button class="link">Discard fix</button></form></div>
  </div>`;
}

/** Whether an agent is working on the item, so the page should keep refreshing. */
function busy(item: Item): boolean {
  return (
    Boolean(item.chat_pending) ||
    item.status === "investigating" ||
    item.fix_status === "working" ||
    item.status === "new" ||
    shotsOf(item)?.status === "running"
  );
}

async function threadHtml(item: Item): Promise<string> {
  const live = Boolean(item.chat_pending) || item.status === "investigating";
  const waiting =
    item.status === "investigate"
      ? event("Queued for investigation")
      : item.status === "investigating" && !item.session_id
        ? event(`<span class="dot"></span> Refreshing the checkouts`)
        : "";
  return [
    postMessage(item),
    triageEvent(item),
    await conversation(item, live),
    waiting,
    item.chat_error ? event(esc(item.chat_error), true) : "",
    item.error && item.status === "failed" ? event(esc(item.error), true) : "",
    await fixCard(item),
  ].join("");
}

async function detail(item: Item): Promise<string> {
  const action = (name: string, label: string) =>
    `<form method="post" action="/item/${item.id}/${name}"><button>${label}</button></form>`;
  const placeholder = item.session_id
    ? "Message the agent. Ask about the problem, ask it to fix it, or to change the fix."
    : "Message the agent. It investigates first, then answers.";
  return page(
    `#${item.id} grain support`,
    `<div class="row"><a href="/">Back to the queue</a>
  <div class="actions">
    ${!item.session_id && item.status !== "investigating" && item.status !== "investigate" ? action("investigate", "Investigate") : ""}
    ${item.status !== "done" ? action("done", "Mark done") : ""}
    ${item.status !== "dismissed" ? action("dismiss", "Dismiss") : ""}
  </div></div>
<div class="row" style="margin-top:12px"><h1 style="margin:0">#${item.id}</h1><span id="status">${pills(item)}${item.cost ? ` <span class="meta">$${item.cost.toFixed(4)}</span>` : ""}</span></div>
<div class="thread" id="thread">${await threadHtml(item)}</div>
<div class="composer">
  <form method="post" action="/item/${item.id}/say">
    <textarea name="message" id="message" placeholder="${esc(placeholder)}" required aria-label="Message the agent"></textarea>
    <button class="primary">Send</button>
  </form>
</div>`,
    SCRIPT(item.id, busy(item)),
  );
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

async function form(req: IncomingMessage): Promise<URLSearchParams> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 200_000) break;
  }
  return new URLSearchParams(body);
}

/** Whether the request came through Caddy, which adds the dashboard key. */
function fromCaddy(req: IncomingMessage): boolean {
  if (!config.dashboardKey) return true;
  const sent = Buffer.from(String(req.headers["x-dashboard-key"] ?? ""));
  const key = Buffer.from(config.dashboardKey);
  return sent.length === key.length && timingSafeEqual(sent, key);
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
      if (!fromCaddy(req)) return send(res, 403, "Refused.");
      // Screenshots are public, so a pull request can show them; Caddy leaves
      // this path outside basic auth. The token in the path is the only key.
      const shot = url.pathname.match(/^\/shots\/([\w-]{16,64})\/([\w-]{1,80}\.png)$/);
      if (req.method === "GET" && shot) {
        const file = join(shotsDir, shot[1], shot[2]);
        if (!existsSync(file)) return send(res, 404, "not found");
        res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=31536000, immutable" });
        return void createReadStream(file).pipe(res);
      }
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, dashboard(url.searchParams.get("view") ?? "inbox"));

      const match = url.pathname.match(/^\/item\/(\d+)(?:\/([\w.]+))?$/);
      const item = match ? get(Number(match[1])) : undefined;
      if (!match || !item) return send(res, 404, page("Not found", "<p>Not found.</p>"));

      if (req.method === "GET" && !match[2]) return send(res, 200, await detail(item));
      if (req.method === "GET" && match[2] === "thread") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(
          JSON.stringify({
            busy: busy(item),
            html: await threadHtml(item),
            status: `${pills(item)}${item.cost ? ` <span class="meta">$${item.cost.toFixed(4)}</span>` : ""}`,
          }),
        );
      }
      if (req.method === "GET" && match[2] === "fix.patch") {
        const repo = url.searchParams.get("repo") ?? "";
        const found = (await fixDiffs(item)).find((d) => d.repo === repo);
        if (!found) return send(res, 404, page("Not found", "<p>No change in that repository.</p>"));
        res.writeHead(200, {
          "content-type": "text/x-diff; charset=utf-8",
          "content-disposition": `attachment; filename="${repo}-${item.id}.patch"`,
        });
        return res.end(found.diff);
      }
      if (req.method !== "POST" || !sameOrigin(req)) return send(res, 403, page("Refused", "<p>Refused.</p>"));

      switch (match[2]) {
        case "say": {
          const message = (await form(req)).get("message")?.trim();
          if (!message || item.status === "investigate") break;
          say(item, message).catch(console.error);
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
        case "pr": {
          const fields = await form(req);
          try {
            await openPrs(item, fields.get("title") ?? "", fields.get("body") ?? "");
          } catch (err) {
            update(item.id, { fix_error: err instanceof Error ? err.message : String(err) });
          }
          break;
        }
        case "discard_fix":
          if (item.fix_status !== "working") await discardFix(item);
          break;
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
