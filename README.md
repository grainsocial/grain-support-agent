# grain-support-agent

An always-on support agent for [grain.social](https://grain.social). It watches
what comes in from outside, sorts it, and investigates the things that look
like bugs, so a person starts from a report instead of a raw post.

```
Bluesky mentions ─┐                         ┌─ dismissed (not about grain, spam)
                  ├─► queue ─► Clef triage ─┼─ needs review (moderation, unsure)
in-app reports ───┘                         ├─ triaged (praise, questions, requests)
                                            └─ investigate ─► opencode + OpenRouter ─► report

classifier reports ─► queue ─► moderation brief (opencode, read-only) ─► needs you
```

- **Ingest.** The grain.social account's notifications (mentions, replies,
  quotes) every minute, and new open rows in the appview's `_reports` table.
  A report the appview's classifiers filed (`reported_by` is `system:<name>`)
  comes in as its own kind of item, linked to the page on grain.social that
  shows its subject.
- **Moderation briefs.** A classifier report skips triage, since Clef already
  scored it in the appview. The investigate agent gathers what a moderator
  would look up, the scores and what the model was shown, the account's
  other posts, earlier reports, labels and takedowns, and writes a brief with a
  suggested outcome. It decides nothing; the item lands in front of a person,
  who acts in grain's `/admin`. A photo's image is a link in the item, never
  an attachment, so opening a nudity report does not put the picture on
  screen. Briefs count toward `INVESTIGATIONS_PER_DAY`.
- **Triage** runs on [Clef](https://developers.cloudflare.com/workers-ai/models/clef/),
  a decision model on Workers AI. It answers fixed questions (is this about
  grain, what kind, which area, which platform, how severe) with a probability
  for every option. It writes no free text, so a post cannot talk its way past
  it. Routing thresholds are in `route()` in `apps/server/src/triage.ts`.
- **Investigation** runs in [opencode](https://opencode.ai) on an OpenRouter
  model (GLM 5.3 by default). It works in one workspace holding
  checkouts of grain, grain-ios and grain-android, and writes a root-cause
  report.
- **Conversation.** Each item's page is a thread with its agent: the post,
  the triage, the investigation, then you and the agent talking. Ask it
  questions, tell it to fix the problem, ask for changes. It acts through a
  few tools (`apps/server/src/support-mcp.ts`): start a fix, revise it, read its diff,
  and propose a pull request. When a fix finishes, the service tells the
  agent, and it reports back in the thread.
- **Fixes** run in a second agent that edits a worktree of each repository
  the fix needs, all on one `agent/<item>-<slug>` branch. Clef picks the
  repositories from the report unless the agent names them. Each changed
  repository on GitHub becomes a draft pull request as the
  grain-support-agent GitHub App, once you press the button on the proposal;
  grain-android, on tangled, downloads as a patch.
- **Restarts** do not lose work: investigations, conversation turns and
  fixes pick up where they stopped.

## The safety model

There are two agents (see `apps/server/src/opencode.ts`), split by what they could leak.

**investigate** is the agent you talk to, and it reads text written by
strangers. Its tools are read, grep and glob within the workspace, read-only
SQL on the appview's database, and the support tools. No shell, no edits, no
web, no subagents. Nothing it can do sends anything anywhere by itself: a
fix goes public only when you approve its pull request. Starting or revising
a fix is refused unless you started the turn, so a post cannot set one
going, and the agent cannot keep revising its own work after a fix-finished
event.

**fix** produces something public, a pull request, so it never touches prod
data: no SQL tool. It can read and edit files in one repository's fix
checkout, and nothing else; no shell, since a shell could read the process
environment and reach the network. It starts from the report and your
instructions, not from the raw post. Its work leaves the server only when you
press the button, after reading the diff and the PR text.

Secrets other than the OpenRouter key are removed from the environment before
opencode starts. The SQL tool (`apps/server/src/grain-db-mcp.ts`, guarded by
`apps/server/src/grain-db.ts`) opens the database read-only and refuses any statement that
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

## Layout

An npm workspace, run with Turbo:

| Path | What |
| --- | --- |
| `apps/server` | The service: ingest, triage, the agents, and the dashboard's JSON API under `/api`. It also hosts the built web app. Node 24 or later, running its TypeScript directly. |
| `apps/web` | The dashboard: React, Vite, TanStack Router (file-based, `src/routes`) and TanStack Query, with shadcn components on Base UI. |
| `apps/preview` | The screenshot runner, its own image. |
| `packages/types` | The API's types, shared by server and web. Types only: Node's type stripping does not reach into `node_modules`, and type-only imports are erased before anything loads. |
| `packages/ui` | The shadcn components (`npx shadcn add <name>` from `apps/web`). |

## Running locally

```sh
npm install
npm test
npm run dev -w server   # the API on :8080; set GRAIN_DB_PATH, OPENROUTER_API_KEY, ...
npm run dev -w web      # the dashboard on :5173, proxying /api and /shots to :8080
```

## Deploying

The service runs in the grain Compose stack on the Hetzner host, built from
this repository. Everything is in `stacks/grain` in hetzner-infra:

1. Fill in the support agent section of `secrets.env` and run
   `scripts/push-secrets.sh`.
2. Set `agent_enabled = true` in `terraform.tfvars` and push the rendered
   config with `scripts/push-config.sh`.
3. Point `agent.grain.social` at the host in Cloudflare.
4. `grain-deploy` on the host builds and starts it.

## Screenshots

`apps/preview` is a second image: a runner that photographs grain's web app with
a fix applied. For each run it starts its own dev stack in one container,
[plc-sqlite](https://tangled.org/chadtmiller.com/plc-sqlite), the reference
PDS, and grain's dev server, which seeds alice.test and friends. Then it
photographs the pages the fix agent listed, once on the commit the fix
started from and once with the fix's patch applied, and throws the stack
away. node_modules are cached by lockfile hash; a run takes about half a
minute once they are.

It runs code an agent wrote, so it holds no secrets and mounts nothing but
its cache, and it shares a network only with this service. The dashboard
refuses any request without the key Caddy adds, so the runner cannot reach
it either.

Screenshots are served at `/shots/<token>/`, the one path Caddy leaves
outside basic auth, so a pull request can show them; the token is the only
key. They show seed data, never production data.
