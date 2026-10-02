import { config, hasOpenRouter } from "./config.ts";
import { pollBluesky } from "./bluesky.ts";
import { resumeTurn, serial } from "./conversation.ts";
import { resumeFix } from "./fix.ts";
import { investigate, resumeInvestigation } from "./investigate.ts";
import { screenshotFixes, takeScreenshots } from "./screenshots.ts";
import { startSupportMcp } from "./support-mcp.ts";
import { during } from "./turns.ts";
import { pollReports } from "./reports.ts";
import { addCost, interrupted, investigationsToday, next, update, type Item } from "./store.ts";
import { clefConfigured as clefReady, route, triage } from "./triage.ts";
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

const clefConfigured = clefReady();

const wakeInvestigator = worker("investigate", 60_000, async () => {
  if (!hasOpenRouter) return false;
  if (investigationsToday() >= config.investigation.maxPerDay) return false;
  const item = next("investigate");
  if (!item) return false;
  // The old session goes with the old report; a restart before the new one
  // opens must not mistake it for this run.
  update(item.id, { status: "investigating", investigated_at: new Date().toISOString(), error: "", report: "", session_id: "" });
  console.log(`investigate: #${item.id}`);
  await serial(item.id, () =>
    finishInvestigation(item, during(item.id, "investigation", () => investigate(item, (session_id) => update(item.id, { session_id })))),
  );
  return true;
});

async function finishInvestigation(item: Item, run: Promise<{ report: string; cost: number }>): Promise<void> {
  try {
    const { report, cost } = await run;
    update(item.id, { status: "reported", report, fix_targets: "" });
    addCost(item.id, cost);
  } catch (err) {
    update(item.id, { status: "failed", error: errorText(err) });
  }
}

/** Picks up whatever a restart cut off, each from where it stopped. */
function resumeInterrupted(): void {
  const { investigations, chats, fixes, screenshots } = interrupted();
  for (const item of screenshots) {
    console.log(`resume: screenshots for #${item.id}`);
    takeScreenshots(item).catch((err) => console.error("resume screenshots:", errorText(err)));
  }
  for (const item of investigations) {
    console.log(`resume: investigation #${item.id}`);
    serial(item.id, () => finishInvestigation(item, during(item.id, "investigation", () => resumeInvestigation(item))));
  }
  for (const item of chats) {
    console.log(`resume: conversation on #${item.id}`);
    resumeTurn(item);
  }
  for (const item of fixes) {
    console.log(`resume: fix on #${item.id}`);
    resumeFix(item).catch((err) => console.error("resume fix:", errorText(err)));
  }
}

const wakeTriage = worker("triage", 30_000, async () => {
  const item = next("new");
  if (!item) return false;
  // A classifier report was already scored by Clef in the appview; asking again
  // learns nothing. It goes to the agent for a brief of the evidence, and on to
  // a person, who decides. Without an agent it goes to the person directly.
  if (item.source === "classifier") {
    if (hasOpenRouter) {
      update(item.id, { status: "investigate", route_reason: "classifier report: gathering evidence" });
      wakeInvestigator();
    } else {
      update(item.id, { status: "needs_review", route_reason: "classifier report" });
    }
    return true;
  }
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

startSupportMcp();
screenshotFixes();
resumeInterrupted();
startWeb(config.port, wakeInvestigator);

if (config.bluesky.appPassword) poller("bluesky", config.bluesky.pollMs, pollBluesky, wakeTriage);
else console.warn("bluesky: BSKY_APP_PASSWORD is not set, mentions are not polled");

if (config.grainDbPath) poller("reports", config.reportsPollMs, pollReports, wakeTriage);
else console.warn("reports: GRAIN_DB_PATH is not set, reports are not polled");

if (!clefConfigured) console.warn("triage: Clef is not configured, every item goes to review");
if (!hasOpenRouter) console.warn("investigate: OPENROUTER_API_KEY is not set, nothing is investigated");
