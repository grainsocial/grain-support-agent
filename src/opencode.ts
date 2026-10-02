import { resolve } from "node:path";
import { createOpencode, type Config, type OpencodeClient, type Part, type Message } from "@opencode-ai/sdk";
import { config } from "./config.ts";

// One opencode server, two agents with different tools.
//
//   investigate  reads the workspace and queries the appview read-only. It is
//                the one that sees untrusted text, so it has no way to send
//                anything anywhere and no way to change anything.
//   fix          edits files in one repo's fix checkout. It never sees prod
//                data, because its work leaves the server as a public pull
//                request: no grain-db tools. No shell either, since a shell
//                could read this process's environment and reach the network.
//
// Global settings deny everything; each agent turns on only what it needs.

export type AgentName = "investigate" | "fix";

const OFF = {
  bash: false,
  edit: false,
  write: false,
  patch: false,
  apply_patch: false,
  webfetch: false,
  websearch: false,
  codesearch: false,
  task: false,
  skill: false,
  // Waits for a person to answer, which never happens in a headless run.
  question: false,
};

const LOCKED = {
  edit: "deny" as const,
  bash: "deny" as const,
  webfetch: "deny" as const,
  external_directory: "deny" as const,
};

export function opencodeConfig(): Config {
  const mcp: Config["mcp"] = config.grainDbPath
    ? {
        "grain-db": {
          type: "local" as const,
          command: ["node", resolve(import.meta.dirname, "grain-db-mcp.ts")],
          environment: { GRAIN_DB_PATH: resolve(config.grainDbPath) },
          enabled: true,
        },
      }
    : {};
  return {
    model: `${config.investigation.provider}/${config.investigation.model}`,
    autoupdate: false,
    share: "disabled" as const,
    tools: OFF,
    permission: LOCKED,
    mcp,
    agent: {
      investigate: {
        mode: "primary",
        description: "Reads grain's code and queries the appview read-only.",
        tools: OFF,
        permission: LOCKED,
      },
      fix: {
        mode: "primary",
        description: "Edits one repository to fix a reported problem.",
        tools: { ...OFF, edit: true, write: true, patch: true, apply_patch: true, "grain-db*": false },
        permission: { ...LOCKED, edit: "allow" as const },
      },
    },
  };
}

let client: OpencodeClient | undefined;

export async function opencode(): Promise<OpencodeClient> {
  if (client) return client;
  // Sessions live under the state directory so they survive a restart and can
  // be picked up again from the dashboard.
  process.env.XDG_DATA_HOME = resolve(config.stateDir, "opencode-data");
  process.env.XDG_CACHE_HOME = resolve(config.stateDir, "opencode-cache");
  const started = await createOpencode({ port: 4096, timeout: 30_000, config: opencodeConfig() });
  client = started.client;
  return client;
}

export async function newSession(directory: string, title: string): Promise<string> {
  const oc = await opencode();
  const created = await oc.session.create({ body: { title }, query: { directory } });
  if (!created.data) throw new Error(`session.create: ${JSON.stringify(created.error)}`);
  return created.data.id;
}

/** Sends one message and waits for the agent to finish. Aborted after the configured timeout. */
export async function prompt(
  sessionId: string,
  directory: string,
  agent: AgentName,
  text: string,
): Promise<{ text: string; cost: number }> {
  const oc = await opencode();
  const timeout = setTimeout(() => {
    oc.session.abort({ path: { id: sessionId }, query: { directory } }).catch(() => {});
  }, config.investigation.timeoutMs);
  try {
    const res = await oc.session.prompt({
      path: { id: sessionId },
      query: { directory },
      body: {
        agent,
        model: { providerID: config.investigation.provider, modelID: config.investigation.model },
        parts: [{ type: "text", text }],
      },
    });
    if (!res.data) throw new Error(`session.prompt: ${JSON.stringify(res.error)}`);
    const { info, parts } = res.data;
    if (info.error) throw new Error(`${info.error.name}: ${JSON.stringify(info.error.data)}`);
    const out = parts
      .filter((p) => p.type === "text")
      .map((p) => ("text" in p ? p.text : ""))
      .join("\n")
      .trim();
    return { text: out, cost: info.cost ?? 0 };
  } finally {
    clearTimeout(timeout);
  }
}

export async function transcript(sessionId: string, directory: string): Promise<{ info: Message; parts: Part[] }[]> {
  const oc = await opencode();
  const res = await oc.session.messages({ path: { id: sessionId }, query: { directory } });
  return res.data ?? [];
}
