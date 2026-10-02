import { randomBytes } from "node:crypto";
import { request } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config.ts";
import { fixDiffs, onFixSettled, prUrls, refreshPrBodies } from "./fix.ts";
import { get, update, type Item } from "./store.ts";

// Before and after screenshots of a fix to grain's web app. The fix agent
// lists the pages its change shows up on; when the fix is ready, the preview
// runner photographs each one on the commit the fix started from and again
// with the fix applied, against its own seeded dev stack. The images are
// served publicly under an unguessable path so a pull request can show them.

export const shotsDir = resolve(config.stateDir, "shots");

const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  desktop: { width: 1280, height: 900 },
} as const;

export interface ShotPage {
  name: string;
  path: string;
  viewport: keyof typeof VIEWPORTS;
  device: "default" | "ios" | "android";
}

export interface Shots {
  status: "running" | "done" | "failed";
  token: string;
  pages: (ShotPage & { before: boolean; after: boolean })[];
  error?: string;
  log?: string;
}

export function shotsOf(item: Item): Shots | undefined {
  try {
    return item.fix_shots ? JSON.parse(item.fix_shots) : undefined;
  } catch {
    return undefined;
  }
}

/** The pages the fix agent listed under "## Screenshots": `- /path mobile android`, one per line. */
export function screenshotPages(summary: string): ShotPage[] {
  const section = summary.match(/##\s*Screenshots\s*\n([\s\S]*?)(?:\n##\s|$)/i)?.[1] ?? "";
  const pages: ShotPage[] = [];
  for (const line of section.split("\n")) {
    const path = line.match(/(?:^|\s|`)(\/[^\s`]*)/)?.[1];
    if (!path || path.length > 300) continue;
    const viewport = /\bdesktop\b/i.test(line) ? "desktop" : "mobile";
    const device = /\bandroid\b/i.test(line) ? "android" : /\bios\b|\biphone\b/i.test(line) ? "ios" : "default";
    pages.push({ name: `${pages.length + 1}-${viewport}${device === "default" ? "" : `-${device}`}`, path, viewport, device });
    if (pages.length === 4) break;
  }
  return pages;
}

interface RunnerReply {
  shots?: { name: string; png: string }[];
  failed?: { name: string; error: string }[];
  error?: string;
  log?: string;
}

/** A plain HTTP request: a run takes minutes, longer than fetch waits for response headers. */
function callRunner(body: object): Promise<RunnerReply> {
  const url = new URL("/preview", config.previewUrl);
  const payload = JSON.stringify(body);
  return new Promise((resolvePromise, reject) => {
    const req = request(
      url,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          try {
            resolvePromise(JSON.parse(raw));
          } catch {
            reject(new Error(`preview runner replied ${res.statusCode} with ${raw.slice(0, 200)}`));
          }
        });
      },
    );
    req.setTimeout(15 * 60_000, () => req.destroy(new Error("preview runner took more than 15 minutes")));
    req.on("error", reject);
    req.end(payload);
  });
}

export async function takeScreenshots(item: Item): Promise<void> {
  if (!config.previewUrl) return;
  const grain = config.repos.find((r) => r.name === "grain");
  const pages = screenshotPages(item.fix_summary);
  if (!grain || !pages.length) return;
  const diff = (await fixDiffs(item)).find((d) => d.repo === "grain");
  if (!diff) return;

  const token = randomBytes(18).toString("base64url");
  const save = (shots: Shots) => update(item.id, { fix_shots: JSON.stringify(shots) });
  const state: Shots = { status: "running", token, pages: pages.map((p) => ({ ...p, before: false, after: false })) };
  save(state);

  const runnerPages = pages.map((p) => ({ name: p.name, path: p.path, ...VIEWPORTS[p.viewport], device: p.device }));
  try {
    const dir = join(shotsDir, token);
    mkdirSync(dir, { recursive: true });
    const logs: string[] = [];
    for (const [side, patch] of [["before", undefined], ["after", diff.diff]] as const) {
      const reply = await callRunner({ repoUrl: grain.url, ref: diff.base, patch, pages: runnerPages });
      if (reply.log) logs.push(`--- ${side} ---\n${reply.log.slice(-4000)}`);
      if (reply.error) throw Object.assign(new Error(`${side}: ${reply.error}`), { log: logs.join("\n") });
      for (const shot of reply.shots ?? []) {
        writeFileSync(join(dir, `${shot.name}-${side}.png`), Buffer.from(shot.png, "base64"));
        const page = state.pages.find((p) => p.name === shot.name);
        if (page) page[side] = true;
      }
    }
    state.status = "done";
    save(state);
    // A pull request opened while these were being taken gets them now.
    const latest = get(item.id);
    if (latest && Object.keys(prUrls(latest)).length) await refreshPrBodies(latest);
  } catch (err) {
    state.status = "failed";
    state.error = err instanceof Error ? err.message : String(err);
    state.log = (err as { log?: string }).log;
    save(state);
  }
}

/** The screenshots as a markdown table for a pull request, or "" when there are none. */
export function prSection(item: Item): string {
  const shots = shotsOf(item);
  if (shots?.status !== "done") return "";
  const url = (file: string) => `${config.publicUrl}/shots/${shots.token}/${file}`;
  const rows = shots.pages
    .filter((p) => p.before || p.after)
    .map((p) => {
      const label = `\`${p.path}\` ${p.viewport}${p.device === "default" ? "" : `, ${p.device}`}`;
      const img = (side: "before" | "after") => (p[side] ? `<img src="${url(`${p.name}-${side}.png`)}" width="${p.viewport === "mobile" ? 260 : 420}">` : "");
      return `| ${label} | ${img("before")} | ${img("after")} |`;
    });
  if (!rows.length) return "";
  return `### Screenshots\n\nTaken against seeded dev data, on the commit this branch started from and with this change applied.\n\n| Page | Before | After |\n| --- | --- | --- |\n${rows.join("\n")}`;
}

/** Takes screenshots each time a fix is ready. Called once at startup. */
export function screenshotFixes(): void {
  onFixSettled((item) => {
    if (item.fix_status !== "ready") return;
    takeScreenshots(item).catch((err) => console.error("screenshots:", err));
  });
}
