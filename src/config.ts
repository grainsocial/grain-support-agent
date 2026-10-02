// Every setting comes from the environment. Secrets are read once here and then
// removed from process.env, so the opencode server and the tools it spawns never
// inherit them: the investigation agent reads untrusted text, and anything in
// its environment is something a prompt injection could ask it to repeat.

function optional(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}

function secret(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  delete process.env[name];
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export interface Repo {
  name: string;
  url: string;
  branch: string;
}

function parseRepos(spec: string): Repo[] {
  return spec
    .split(/\s+/)
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^([\w.-]+)=([^#]+)(?:#(.+))?$/);
      if (!match) throw new Error(`REPOS: cannot parse "${entry}", expected name=url#branch`);
      return { name: match[1], url: match[2], branch: match[3] ?? "main" };
    });
}

export const config = {
  port: int("PORT", 8080),
  stateDir: optional("STATE_DIR", "./state"),

  // The appview's live database, opened read-only. Empty disables the reports
  // source and the SQL tool.
  grainDbPath: optional("GRAIN_DB_PATH"),

  // The repositories the investigation agent reads, as `name=url#branch`
  // separated by spaces. Each is checked out side by side in one workspace and
  // refreshed before every investigation.
  repos: parseRepos(
    optional(
      "REPOS",
      [
        "grain=https://github.com/grainsocial/grain.git#main",
        "grain-ios=https://github.com/grainsocial/grain-ios.git#main",
        "grain-android=https://tangled.org/grain.social/grain-android#main",
      ].join(" "),
    ),
  ),

  bluesky: {
    identifier: optional("BSKY_IDENTIFIER", "grain.social"),
    appPassword: secret("BSKY_APP_PASSWORD"),
    // Resolved from the account's DID document when unset.
    pds: optional("BSKY_PDS"),
    pollMs: int("BSKY_POLL_MS", 60_000),
  },

  reportsPollMs: int("REPORTS_POLL_MS", 60_000),

  clef: {
    accountId: optional("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: secret("CLOUDFLARE_AI_TOKEN"),
    model: optional("CLEF_MODEL", "clef"),
  },

  investigation: {
    // OpenRouter reads OPENROUTER_API_KEY itself, so that one key stays in the
    // environment the opencode server inherits. Everything else does not.
    provider: optional("INVESTIGATION_PROVIDER", "openrouter"),
    model: optional("INVESTIGATION_MODEL", "z-ai/glm-5.3"),
    timeoutMs: int("INVESTIGATION_TIMEOUT_MS", 10 * 60_000),
    // A hard ceiling on spend: investigations started per UTC day.
    maxPerDay: int("INVESTIGATIONS_PER_DAY", 20),
  },
};

export const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
