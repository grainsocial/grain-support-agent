import { config, hasOpenRouter } from "./config.ts";
import { pollBluesky } from "./bluesky.ts";
import { investigate } from "./investigate.ts";
import { pollReports } from "./reports.ts";
import { investigationsToday, next, requeueInterrupted, update } from "./store.ts";
import { route, triage } from "./triage.ts";
import { startWeb } from "./web.ts";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A loop that runs `step` until it reports no more work, then waits for a wake-up or `idleMs`. */
function worker(name: string, idleMs: number, step: () => Promise<boolean>): () => void {
  let wake: (() => void) | undefined;
  (async () => {
    for (;;) {
      let more = false;
      try {
        more = await step();
      } catch (err) {
        console.error(`${name}:`, errorText(err));
      }
      if (!more) await new Promise<void>((r) => ((wake = r), setTimeout(r, idleMs)));
    }
  })();
  return () => wake?.();
}

function poller(name: string, everyMs: number, poll: () => number | Promise<number>, then: () => void): void {
  (async () => {
    for (;;) {
      try {
        const added = await poll();
        if (added) {
          console.log(`${name}: ${added} new`);
          then();
        }
      } catch (err) {
        console.error(`${name}:`, errorText(err));
      }
      await sleep(everyMs);
    }
  })();
}

const clefConfigured = Boolean(config.clef.accountId && config.clef.apiToken);

const wakeInvestigator = worker("investigate", 60_000, async () => {
  if (!hasOpenRouter) return false;
  if (investigationsToday() >= config.investigation.maxPerDay) return false;
  const item = next("investigate");
  if (!item) return false;
  update(item.id, { status: "investigating", investigated_at: new Date().toISOString(), error: "", report: "" });
  console.log(`investigate: #${item.id}`);
  try {
    const { report, cost } = await investigate(item, (session_id) => update(item.id, { session_id }));
    update(item.id, { status: "reported", report, cost });
  } catch (err) {
    update(item.id, { status: "failed", error: errorText(err) });
  }
  return true;
});

const wakeTriage = worker("triage", 30_000, async () => {
  const item = next("new");
  if (!item) return false;
  if (!clefConfigured) {
    update(item.id, { status: "needs_review", route_reason: "triage is not configured" });
    return true;
  }
  try {
    const t = await triage(item);
    const { status, reason } = route(t, item.source);
    update(item.id, { status, triage: t, route_reason: reason });
    if (status === "investigate") wakeInvestigator();
  } catch (err) {
    update(item.id, { status: "failed", error: errorText(err) });
  }
  return true;
});

requeueInterrupted();
startWeb(config.port, wakeInvestigator);

if (config.bluesky.appPassword) poller("bluesky", config.bluesky.pollMs, pollBluesky, wakeTriage);
else console.warn("bluesky: BSKY_APP_PASSWORD is not set, mentions are not polled");

if (config.grainDbPath) poller("reports", config.reportsPollMs, pollReports, wakeTriage);
else console.warn("reports: GRAIN_DB_PATH is not set, reports are not polled");

if (!clefConfigured) console.warn("triage: Clef is not configured, every item goes to review");
if (!hasOpenRouter) console.warn("investigate: OPENROUTER_API_KEY is not set, nothing is investigated");
