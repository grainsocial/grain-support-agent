// The dashboard API: what the server sends and the web app renders. Types only.

export type Status =
  | "new"
  | "needs_review"
  | "triaged"
  | "investigate"
  | "investigating"
  | "reported"
  | "failed"
  | "done"
  | "dismissed";

export type FixStatus = "" | "working" | "ready" | "failed" | "pr_open";

export type View = "inbox" | "working" | "pr" | "triaged" | "done" | "dismissed";

export interface Triage {
  relevant: number;
  kind: string;
  kindConfidence: number;
  severity: number;
  area: string;
  platform: string;
  needsReply: number;
}

/** An account on grain, as a report names it. */
export interface Account {
  did: string;
  /** Null when the appview has no handle for it. */
  handle: string | null;
  displayName: string | null;
  /** Its profile on grain.social. */
  url: string;
}

/** An item as the queue lists it. */
export interface ItemSummary {
  id: number;
  source: "bluesky" | "report" | "classifier";
  author: string;
  text: string;
  url: string;
  receivedAt: string;
  status: Status;
  triage: Triage | null;
  routeReason: string;
  fixStatus: FixStatus;
  /** An agent is answering or working on this item right now. */
  working: boolean;
  cost: number;
  /** For a report, the account it concerns. */
  subject: Account | null;
  /** For a report, what it is about, named for a person, and its page on grain.social. */
  subjectLink: { label: string; url: string } | null;
  /** For a report filed in the app, who filed it. */
  reporter: Account | null;
}

export interface QueueResponse {
  view: View;
  views: { view: View; label: string; count: number }[];
  items: ItemSummary[];
}

export interface Step {
  tool: string;
  label: string;
  detail: string;
  state: "running" | "done" | "failed";
}

/** One thing in an item's conversation, in order. */
export type ThreadEntry =
  | { kind: "event"; text: string; tone?: "bad" | "live" }
  | { kind: "user"; text: string }
  | {
      kind: "agent";
      who: string;
      steps: Step[];
      /** One line, like "read 14 files, ran 2 queries". */
      summary: string;
      text: string;
      cost: number;
      /** Still running: show the steps as they happen. */
      live: boolean;
      startedAt: number;
    };

export interface RepoDiff {
  repo: string;
  stat: string;
  diff: string;
  added: number;
  removed: number;
  /** On GitHub, so it becomes a pull request; otherwise a patch download. */
  canOpenPr: boolean;
}

export interface ShotPage {
  name: string;
  path: string;
  viewport: "mobile" | "desktop";
  device: "default" | "ios" | "android";
  /** Public URLs, when taken. */
  before?: string;
  after?: string;
}

export interface Screenshots {
  status: "running" | "done" | "failed";
  pages: ShotPage[];
  error?: string;
  log?: string;
}

export interface Fix {
  status: Exclude<FixStatus, "">;
  repos: string[];
  branch: string;
  error: string;
  title: string;
  body: string;
  prUrls: Record<string, string>;
  diffs: RepoDiff[];
  screenshots: Screenshots | null;
  /** The fix agent's current turn, while it works. */
  live: Extract<ThreadEntry, { kind: "agent" }> | null;
}

export interface ItemDetail extends ItemSummary {
  images: string[];
  error: string;
  chatError: string;
  hasSession: boolean;
  thread: ThreadEntry[];
  fix: Fix | null;
  /** Something is running; poll for changes. */
  busy: boolean;
}

export interface Options {
  kinds: Record<string, string>;
  areas: Record<string, string>;
  platforms: Record<string, string>;
}

export interface TriageCorrection {
  kind?: string;
  area?: string;
  platform?: string;
}

export interface PrRequest {
  title: string;
  body: string;
}

export interface ApiError {
  error: string;
}
