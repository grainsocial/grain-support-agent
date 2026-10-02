import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";

// One preview run: check out a ref of grain, bring up a dev stack of its own
// (plc-sqlite, the reference PDS, grain's dev server with its seed data), and
// photograph the pages asked for. Everything lives in a directory that is
// deleted afterwards; only installed node_modules are kept, by lockfile hash.
//
// The ports are the ones grain's dev config expects (PLC 2582, PDS 2583,
// app 3000), so one run at a time. The server queues them.

const run = promisify(execFile);
const CACHE = process.env.PREVIEW_CACHE ?? "/cache";

export interface Page {
  /** File-safe name for the screenshot. */
  name: string;
  /** Path on the app, with any query string. */
  path: string;
  width: number;
  height: number;
  colorScheme?: "light" | "dark";
  fullPage?: boolean;
  /** Which device to present as, for pages that treat iOS or Android differently. */
  device?: "default" | "ios" | "android";
}

const USER_AGENTS = {
  ios: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
};

export interface Shot {
  name: string;
  png: Buffer;
}

export interface RunResult {
  shots: Shot[];
  failed: { name: string; error: string }[];
  log: string;
}

async function waitFor(url: string, timeoutMs: number, accept = (status: number) => status < 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (accept(res.status)) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not come up in ${timeoutMs / 1000}s (${last})`);
}

function start(name: string, cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }, log: string[]): ChildProcess {
  // Its own process group, so stopping it takes the processes it started with it.
  const child = spawn(cmd, args, { ...opts, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const capture = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) if (line.trim()) log.push(`[${name}] ${line}`);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  return child;
}

function stop(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {}
}

/** node_modules for this lockfile, hard-linked from the cache, installing once per lockfile. */
async function installDeps(src: string, log: string[]): Promise<void> {
  const lock = readFileSync(join(src, "package-lock.json"));
  const key = createHash("sha256").update(lock).digest("hex").slice(0, 16);
  const cached = join(CACHE, "node_modules", key);
  const env = { ...process.env, NODE_ENV: "development" };
  if (!existsSync(cached)) {
    log.push(`[deps] npm ci for lockfile ${key}`);
    await run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: src, env, maxBuffer: 64 * 1024 * 1024 });
    mkdirSync(join(CACHE, "node_modules"), { recursive: true });
    const tmp = `${cached}.${randomUUID()}`;
    await run("cp", ["-al", join(src, "node_modules"), tmp]);
    renameSync(tmp, cached);
  } else {
    log.push(`[deps] cached node_modules for lockfile ${key}`);
    await run("cp", ["-al", cached, join(src, "node_modules")]);
  }
}

/** `patch`, when given, is applied on top of `ref`: a fix that has not been pushed anywhere yet. */
export async function preview(repoUrl: string, ref: string, pages: Page[], patch?: string): Promise<RunResult> {
  const log: string[] = [];
  const dir = join(CACHE, "runs", randomUUID());
  const src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  const procs: ChildProcess[] = [];
  try {
    await run("git", ["init", "-q", src]);
    await run("git", ["-C", src, "fetch", "-q", "--depth", "1", repoUrl, ref]);
    await run("git", ["-C", src, "checkout", "-q", "FETCH_HEAD"]);
    log.push(`[git] ${repoUrl} ${ref} at ${(await run("git", ["-C", src, "log", "-1", "--format=%h %s"])).stdout.trim()}`);
    if (patch) {
      await new Promise<void>((resolve, reject) => {
        const apply = spawn("git", ["-C", src, "apply", "--whitespace=nowarn", "-"], { stdio: ["pipe", "ignore", "pipe"] });
        let err = "";
        apply.stderr.on("data", (d) => (err += d));
        apply.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`the patch does not apply: ${err.trim()}`))));
        apply.stdin.end(patch);
      });
      log.push("[git] applied the fix");
    }
    await installDeps(src, log);

    procs.push(
      start("plc", "node", ["/opt/plc/server.js"], { cwd: "/opt/plc", env: { ...process.env, PORT: "2582", PLC_DB_PATH: join(dir, "plc.db") } }, log),
    );
    await waitFor("http://127.0.0.1:2582/_health", 30_000);

    mkdirSync(join(dir, "pds", "blobs"), { recursive: true });
    procs.push(
      start(
        "pds",
        "node",
        ["/opt/pds/index.js"],
        {
          cwd: "/opt/pds",
          env: {
            ...process.env,
            PDS_HOSTNAME: "localhost",
            PDS_PORT: "2583",
            PDS_DID_PLC_URL: "http://localhost:2582",
            PDS_DATA_DIRECTORY: join(dir, "pds"),
            PDS_BLOBSTORE_DISK_LOCATION: join(dir, "pds", "blobs"),
            PDS_JWT_SECRET: "dev-jwt-secret",
            PDS_ADMIN_PASSWORD: "dev-admin",
            PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            PDS_INVITE_REQUIRED: "false",
            PDS_DEV_MODE: "true",
          },
        },
        log,
      ),
    );
    await waitFor("http://127.0.0.1:2583/xrpc/_health", 60_000);

    // hatk's Vite plugin sees the PDS answering, skips starting Docker, runs
    // seeds/seed.ts against it, then serves the app.
    const env = { ...process.env, NODE_ENV: "development", PORT: "3000" };
    await run("npx", ["svelte-kit", "sync"], { cwd: src, env });
    procs.push(start("app", "npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", "3000", "--strictPort"], { cwd: src, env }, log));
    await waitFor("http://127.0.0.1:3000/", 300_000, (s) => s < 400);
    // Seeded records reach the appview over the PDS's firehose; wait until the
    // first seeded profile is indexed.
    await waitFor("http://127.0.0.1:3000/profile/alice.test", 60_000, (s) => s === 200);

    const browser = await chromium.launch();
    const shots: Shot[] = [];
    const failed: { name: string; error: string }[] = [];
    try {
      for (const p of pages) {
        const device = p.device && p.device !== "default" ? p.device : undefined;
        const page = await browser.newPage({
          viewport: { width: p.width, height: p.height },
          colorScheme: p.colorScheme ?? "light",
          ...(device ? { userAgent: USER_AGENTS[device], isMobile: true, hasTouch: true } : {}),
        });
        try {
          await page.goto(`http://127.0.0.1:3000${p.path}`, { waitUntil: "networkidle", timeout: 60_000 });
          shots.push({ name: p.name, png: await page.screenshot({ fullPage: p.fullPage ?? false }) });
        } catch (err) {
          failed.push({ name: p.name, error: err instanceof Error ? err.message : String(err) });
        } finally {
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
    return { shots, failed, log: log.join("\n") };
  } catch (err) {
    log.push(`[error] ${err instanceof Error ? err.message : String(err)}`);
    throw Object.assign(new Error(err instanceof Error ? err.message : String(err)), { log: log.join("\n") });
  } finally {
    for (const p of procs.reverse()) stop(p);
    rmSync(dir, { recursive: true, force: true });
  }
}
