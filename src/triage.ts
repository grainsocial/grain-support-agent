import { config } from "./config.ts";
import type { Item, Status, Triage } from "./store.ts";

// Triage runs on Clef, a decision model on Workers AI: it reads the item and
// answers a fixed set of typed questions with a probability for every option.
// It produces no free text, so the raw post can only move probabilities around.
// Whatever a post says, triage can only place it in one of the buckets below.

export const KINDS = {
  bug: "Something in grain is broken or behaves wrongly",
  complaint: "Unhappy with how grain works, without a specific defect",
  feature_request: "Asks for something grain does not do yet",
  question: "Asks how to do something or how grain works",
  praise: "Positive feedback or sharing something made with grain",
  moderation: "Reports abuse, harassment, illegal content or an account to act on",
  spam: "Spam, scams, or automated junk",
  other: "None of the above",
} as const;

export const AREAS = {
  upload: "Uploading photos, image processing, EXIF, alt text",
  feed: "Timelines, feeds, the carousel, what shows up where",
  profile: "Profiles, avatars, handles, follows",
  galleries: "Galleries, stories, comments, favorites",
  spaces: "Shared galleries, groups, invites, permissioned spaces",
  auth: "Signing in, sessions, OAuth, account creation",
  notifications: "Notifications and push",
  mobile: "The mobile app specifically",
  performance: "Slowness, timeouts, the site being down",
  other: "None of the above, or unclear",
} as const;

export const PLATFORMS = {
  ios: "The iPhone or iPad app",
  android: "The Android app",
  web: "The grain.social website in a browser",
  unknown: "Not said, or applies everywhere",
} as const;

const SEVERITY = [
  "No user impact",
  "Minor annoyance, a workaround exists",
  "A feature is broken for some users",
  "Data loss, a security problem, or grain is unusable",
];

function questions() {
  return {
    relevant: {
      type: "noul",
      instructions:
        "Is this about grain.social, the photo sharing app on the AT Protocol? Food grain, wood grain, film grain and other uses of the word are not.",
    },
    kind: { type: "choice", instructions: "What kind of message is this?", criteria: KINDS },
    severity: { type: "score", instructions: "How badly does this affect grain's users?", criteria: SEVERITY },
    area: { type: "choice", instructions: "Which part of grain is this about?", criteria: AREAS },
    platform: { type: "choice", instructions: "Which grain app is the person using?", criteria: PLATFORMS },
    needs_reply: {
      type: "noul",
      instructions: "Does the author expect an answer from the grain team?",
    },
  };
}

interface ClefAnswer {
  type: string;
  noul?: number;
  choice?: string;
  confidence?: number;
  score?: number;
}

async function fetchImage(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(png|jpeg|webp)/.test(type)) return undefined;
    return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  } catch {
    return undefined;
  }
}

export async function triage(item: Item): Promise<Triage> {
  const { accountId, apiToken, model } = config.clef;
  if (!accountId || !apiToken) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AI_TOKEN are not set");

  const images = (await Promise.all(item.images.map(fetchImage))).filter(Boolean);
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        state: {
          source: item.source === "bluesky" ? "A Bluesky post that mentions or replies to @grain.social" : "A report filed inside the grain app",
          text: item.text,
        },
        questions: questions(),
        ...(images.length ? { images } : {}),
      }),
    },
  );
  if (!res.ok) throw new Error(`clef: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { result?: { answers: Record<string, ClefAnswer> }; answers?: Record<string, ClefAnswer> };
  const answers = body.result?.answers ?? body.answers;
  if (!answers) throw new Error(`clef: no answers in ${JSON.stringify(body).slice(0, 300)}`);

  return {
    relevant: answers.relevant?.noul ?? 0,
    kind: answers.kind?.choice ?? "other",
    kindConfidence: answers.kind?.confidence ?? 0,
    severity: answers.severity?.score ?? 0,
    area: answers.area?.choice ?? "other",
    platform: answers.platform?.choice ?? "unknown",
    needsReply: answers.needs_reply?.noul ?? 0,
  };
}

/**
 * Where a triaged item goes next. Thresholds are deliberately cautious about
 * dropping things: only a confident "not about grain" or "spam" is dismissed
 * without a person seeing it, and a user report is never dismissed at all.
 */
export function route(t: Triage, source: Item["source"]): { status: Status; reason: string } {
  if (source === "bluesky" && t.relevant < 0.2) {
    return { status: "dismissed", reason: `not about grain (p=${t.relevant.toFixed(2)})` };
  }
  if (t.kind === "spam" && t.kindConfidence >= 0.85 && source === "bluesky") {
    return { status: "dismissed", reason: "spam" };
  }
  if (t.kind === "moderation" || source === "report") {
    return { status: "needs_review", reason: "moderation is decided by a person" };
  }
  if (t.relevant < 0.6 || t.kindConfidence < 0.5) {
    return { status: "needs_review", reason: "triage was unsure" };
  }
  if (t.kind === "bug" || (t.kind === "complaint" && t.severity >= 1.5) || t.severity >= 2) {
    return { status: "investigate", reason: `${t.kind}, severity ${t.severity.toFixed(1)}` };
  }
  return { status: "triaged", reason: t.kind };
}
