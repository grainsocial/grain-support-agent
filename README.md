# grain-support-agent

An always-on support agent for [grain.social](https://grain.social). It watches
what comes in from outside, sorts it, and investigates the things that look
like bugs, so a person starts from a report instead of a raw post.

```
Bluesky mentions ─┐                         ┌─ dismissed (not about grain, spam)
                  ├─► queue ─► Clef triage ─┼─ needs review (moderation, unsure)
in-app reports ───┘                         ├─ triaged (praise, questions, requests)
                                            └─ investigate ─► opencode + OpenRouter ─► report
```

- **Ingest.** The grain.social account's notifications (mentions, replies,
  quotes) every minute, and new open rows in the appview's `_reports` table.
- **Triage** runs on [Clef](https://developers.cloudflare.com/workers-ai/models/clef/),
  a decision model on Workers AI. It answers fixed questions (is this about
  grain, what kind, which area, which platform, how severe) with a probability
  for every option. It writes no free text, so a post cannot talk its way past
  it. Routing thresholds are in `route()` in `src/triage.ts`.
- **Investigation** runs in [opencode](https://opencode.ai) on an OpenRouter
  model (GLM 5.3 by default). It works in one workspace holding
  checkouts of grain, grain-ios and grain-android, and writes a root-cause
  report.
- **Dashboard** on port 8080: the queue, each item's triage, and the report.
  You can correct a triage call there; corrections are kept in
  `triage_feedback` as labeled data.

## The safety model

The investigation agent reads text written by strangers. Its tools are:
read, grep and glob within the workspace, and read-only SQL on the appview's
database. Everything else is off: no shell, no edits, no web, no subagents.
Secrets other than the OpenRouter key are removed from the environment before
opencode starts. A prompt injection in a post can steer what the agent reads,
but no tool sends anything anywhere, so the worst it can do is write a wrong
report.

The SQL tool (`src/grain-db-mcp.ts`, guarded by `src/grain-db.ts`) opens the
database read-only and refuses any statement that names a table holding
credentials or private state: `_oauth_keys`, `_oauth_sessions`, `_push_tokens`,
`_preferences`, `_mutes`, `_space_invites`. opencode's `external_directory`
rule stops the file tools from reading the database file directly.

Nothing is posted, opened or changed anywhere. Draft replies and PRs are a
later step, and both will wait for approval.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | | Without it, nothing is investigated |
| `INVESTIGATION_MODEL` | `z-ai/glm-5.3` | Any OpenRouter model id with tool calling |
| `INVESTIGATIONS_PER_DAY` | `20` | Spend ceiling, UTC day |
| `INVESTIGATION_TIMEOUT_MS` | `600000` | An investigation is aborted after this |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN` | | Without them, every item goes to review |
| `CLEF_MODEL` | `clef` | `clef-flash` is faster and smaller |
| `BSKY_IDENTIFIER` | `grain.social` | |
| `BSKY_APP_PASSWORD` | | Without it, mentions are not polled |
| `GRAIN_DB_PATH` | | The appview's `grain.db`. Without it, no reports and no SQL tool |
| `REPOS` | grain, grain-ios, grain-android | `name=url#branch`, space separated |
| `STATE_DIR` | `./state` | Queue database, opencode sessions, checkouts |

On OpenRouter, restrict routing to providers that neither train on nor retain
prompts (Settings, Privacy), since prompts carry production data.

## Running locally

```sh
npm install
npm test
GRAIN_DB_PATH=~/code/grain/data/grain.db OPENROUTER_API_KEY=... npm start
```

Node 24 or later; it runs the TypeScript directly.

## Deploying

The service runs in the grain Compose stack on the Hetzner host, built from
this repository. Everything is in `stacks/grain` in hetzner-infra:

1. Fill in the support agent section of `secrets.env` and run
   `scripts/push-secrets.sh`.
2. Set `agent_enabled = true` in `terraform.tfvars` and push the rendered
   config with `scripts/push-config.sh`.
3. Point `agent.grain.social` at the host in Cloudflare.
4. `grain-deploy` on the host builds and starts it.
