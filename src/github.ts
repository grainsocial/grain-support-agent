import { createSign } from "node:crypto";
import { config } from "./config.ts";

// The grain-support-agent GitHub App. It is installed only on the repos it may
// open pull requests against, with Contents and Pull requests write and nothing
// else. Tokens are minted per use and expire within the hour.

const API = "https://api.github.com";

export const githubConfigured = () => Boolean(config.github.appId && config.github.appKey);

/** owner/name for a GitHub clone URL, or undefined for any other host. */
export function githubRepo(url: string): string | undefined {
  return url.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];
}

function appJwt(): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: config.github.appId })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(config.github.appKey, "base64url")}`;
}

async function api<T>(path: string, auth: string | undefined, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      ...(auth ? { authorization: auth } : {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${path}: ${res.status} ${(body as { message?: string }).message ?? ""}`);
  return body as T;
}

/** An installation token scoped to one repository. */
export async function repoToken(repo: string): Promise<string> {
  const jwt = `Bearer ${appJwt()}`;
  const installation = await api<{ id: number }>(`/repos/${repo}/installation`, jwt);
  const { token } = await api<{ token: string }>(`/app/installations/${installation.id}/access_tokens`, jwt, {
    method: "POST",
    body: JSON.stringify({ repositories: [repo.split("/")[1]] }),
  });
  return token;
}

/** The name and noreply email commits made as the app's bot user carry. */
export async function botIdentity(): Promise<{ name: string; email: string }> {
  const app = await api<{ slug: string }>("/app", `Bearer ${appJwt()}`);
  const name = `${app.slug}[bot]`;
  // Public, and an app JWT is not accepted here.
  const user = await api<{ id: number }>(`/users/${encodeURIComponent(name)}`, undefined).catch(() => undefined);
  return { name, email: user ? `${user.id}+${name}@users.noreply.github.com` : `${name}@users.noreply.github.com` };
}

/** Opens a draft pull request, or returns the open one for this branch. */
export async function openDraftPr(
  repo: string,
  token: string,
  pr: { head: string; base: string; title: string; body: string },
): Promise<string> {
  const auth = `token ${token}`;
  const [owner] = repo.split("/");
  const open = await api<{ html_url: string }[]>(
    `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${pr.head}`)}`,
    auth,
  );
  if (open[0]) return open[0].html_url;
  const created = await api<{ html_url: string }>(`/repos/${repo}/pulls`, auth, {
    method: "POST",
    body: JSON.stringify({ ...pr, draft: true }),
  });
  return created.html_url;
}
