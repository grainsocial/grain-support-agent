import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { config, type Repo } from "./config.ts";

export const git = promisify(execFile).bind(null, "git") as (
  args: string[],
  opts?: { maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

// Not itself a git repository, so opencode treats this directory as the
// project root: every checkout under it is readable, and nothing above it is.
export const workspace = resolve(config.stateDir, "workspace");

export const errorText = (err: unknown) => (err instanceof Error ? err.message.split("\n")[0] : String(err));

export function repoDir(name: string): string {
  return join(workspace, name);
}

async function refreshRepo(repo: Repo): Promise<string> {
  const dir = repoDir(repo.name);
  if (!existsSync(join(dir, ".git"))) {
    await git(["clone", "--branch", repo.branch, "--depth", "500", repo.url, dir]);
  } else {
    await git(["-C", dir, "fetch", "--depth", "500", "origin", repo.branch]);
    await git(["-C", dir, "reset", "--hard", "FETCH_HEAD"]);
    await git(["-C", dir, "clean", "-fdx"]);
  }
  const { stdout } = await git(["-C", dir, "log", "-1", "--format=%h %s"]);
  return `${repo.name}/ at ${stdout.trim()}`;
}

/** Brings every checkout up to date. A repo that fails to refresh is left out, not fatal. */
export async function refreshWorkspace(): Promise<string[]> {
  mkdirSync(workspace, { recursive: true });
  const results = await Promise.allSettled(config.repos.map(refreshRepo));
  return results.map((r, i) =>
    r.status === "fulfilled" ? r.value : `${config.repos[i].name}/ could not be refreshed: ${errorText(r.reason)}`,
  );
}
