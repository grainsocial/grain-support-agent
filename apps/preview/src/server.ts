import { createServer } from "node:http";
import { preview, type Page } from "./run.ts";

// The runner's HTTP API, for the support agent only: it is on a Compose
// network nothing else joins. POST /preview with a ref of an allowed repo, an
// optional patch on top, and the pages to photograph. One run at a time.

const PORT = Number(process.env.PORT ?? 8090);
const REPOS = (process.env.PREVIEW_REPOS ?? "https://github.com/grainsocial/grain.git").split(/\s+/).filter(Boolean);
const MAX_PAGES = 8;

let queue: Promise<unknown> = Promise.resolve();

function valid(body: unknown): { repoUrl: string; ref: string; patch?: string; pages: Page[] } | string {
  const b = body as Record<string, unknown>;
  if (typeof b?.repoUrl !== "string" || !REPOS.includes(b.repoUrl)) return "repoUrl is not one this runner builds";
  if (typeof b.ref !== "string" || !/^[\w./-]{1,200}$/.test(b.ref)) return "ref is missing or malformed";
  if (b.patch !== undefined && (typeof b.patch !== "string" || b.patch.length > 2_000_000)) return "patch is malformed";
  if (!Array.isArray(b.pages) || !b.pages.length || b.pages.length > MAX_PAGES) return `pages must be 1 to ${MAX_PAGES} entries`;
  for (const p of b.pages as Page[]) {
    if (typeof p.path !== "string" || !p.path.startsWith("/") || p.path.length > 300) return "every page needs a path starting with /";
    if (typeof p.name !== "string" || !/^[\w-]{1,64}$/.test(p.name)) return "every page needs a file-safe name";
    if (!(p.width >= 320 && p.width <= 2560 && p.height >= 320 && p.height <= 2560)) return "page sizes must be 320 to 2560";
  }
  return { repoUrl: b.repoUrl, ref: b.ref, patch: b.patch as string | undefined, pages: b.pages as Page[] };
}

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/_health") return res.end("ok");
  if (req.method !== "POST" || req.url !== "/preview") {
    res.writeHead(404);
    return res.end();
  }
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let request;
  try {
    request = valid(JSON.parse(raw));
  } catch {
    request = "body is not JSON";
  }
  const reply = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (typeof request === "string") return reply(400, { error: request });

  const job = queue.then(() => preview(request.repoUrl, request.ref, request.pages, request.patch));
  queue = job.catch(() => {});
  try {
    const result = await job;
    reply(200, {
      shots: result.shots.map((s) => ({ name: s.name, png: s.png.toString("base64") })),
      failed: result.failed,
      log: result.log.slice(-20_000),
    });
  } catch (err) {
    reply(502, { error: err instanceof Error ? err.message : String(err), log: ((err as { log?: string }).log ?? "").slice(-20_000) });
  }
}).listen(PORT, () => console.log(`preview runner on :${PORT}`));
