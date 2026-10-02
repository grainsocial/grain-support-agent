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
- **Follow-up.** Ask the investigation agent more questions on the item's
  page; it answers in the same session, with the same read-only tools.
- **Fixes.** "Work on a fix" hands the report and your instructions to a
  second agent that edits one repository on an `agent/<item>-<slug>` branch.
  You read the diff, ask for changes, and when it is right, open a draft pull
  request as the grain-support-agent GitHub App. grain-android is on tangled,
  so its fixes download as a patch instead.
- **Dashboard** on port 8080: the queue, each item's triage, the report, the
  follow-up conversation and the fix. You can correct a triage call there;
  corrections are kept in `triage_feedback` as labeled data.

## The safety model

There are two agents (see `src/opencode.ts`), split by what they could leak.

**investigate** reads text written by strangers. Its tools are read, grep
and glob within the workspace, and read-only SQL on the appview's database.
No shell, no edits, no web, no subagents. A prompt injection in a post can
steer what it reads, but no tool sends anything anywhere, so the worst it can
do is write a wrong report.

**fix** produces something public, a pull request, so it never touches prod
data: no SQL tool. It can read and edit files in one repository's fix
checkout, and nothing else; no shell, since a shell could read the process
environment and reach the network. It starts from the report and your
instructions, not from the raw post. Its work leaves the server only when you
press the button, after reading the diff and the PR text.

Secrets other than the OpenRouter key are removed from the environment before
opencode starts. The SQL tool (`src/grain-db-mcp.ts`, guarded by
`src/grain-db.ts`) opens the database read-only and refuses any statement that
names a table holding credentials or private state: `_oauth_keys`,
`_oauth_sessions`, `_push_tokens`, `_preferences`, `_mutes`, `_space_invites`.
opencode's `external_directory` rule keeps the file tools inside the workspace
or the fix checkout, so neither agent can read the database file directly.

Reports render as markdown with raw HTML off and images disabled: an image
URL in a report would be fetched as soon as the page opened.

Nothing is posted to Bluesky. Drafted replies are a later step, and will wait
for approval like pull requests do.

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
| `GITHUB_APP_ID`, `GITHUB_APP_KEY` | | The GitHub App fixes become pull requests as; the key is the PEM, base64-encoded. Without them, fixes download as patches |
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
