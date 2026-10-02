import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MAX_ROWS, open, query, refuse } from "./grain-db.ts";

// An MCP server over stdio that gives the investigation agent read-only SQL on
// the appview's database. opencode spawns it; the path comes from GRAIN_DB_PATH.

const path = process.env.GRAIN_DB_PATH;
if (!path) throw new Error("GRAIN_DB_PATH is not set");

const server = new McpServer({ name: "grain-db", version: "1.0.0" });

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

server.registerTool(
  "list_tables",
  {
    description:
      "List the tables in grain's appview database. Collection tables are named after their NSID, e.g. [social.grain.photo]; bracket them in SQL because the names contain dots.",
    inputSchema: {},
  },
  async () => {
    const rows = open(path)
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((r) => String(r.name))
      .filter((name) => !refuse(`SELECT * FROM [${name}]`));
    return text(rows);
  },
);

server.registerTool(
  "describe_table",
  {
    description: "Show a table's CREATE statement and its indexes.",
    inputSchema: { table: z.string() },
  },
  async ({ table }) => {
    const why = refuse(`SELECT * FROM [${table}]`);
    if (why) return failure(why);
    const rows = open(path)
      .prepare(`SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ?`)
      .all(table);
    return rows.length ? text(rows) : failure(`no table named ${table}`);
  },
);

server.registerTool(
  "sql_query",
  {
    description: `Run one read-only SELECT against grain's appview database (SQLite) and get up to ${MAX_ROWS} rows back. The database is live and large; filter and LIMIT rather than scanning. Timestamps are ISO 8601 strings; compare with strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'), not datetime().`,
    inputSchema: { sql: z.string() },
  },
  async ({ sql }) => {
    try {
      return text(query(path, sql));
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err));
    }
  },
);

await server.connect(new StdioServerTransport());
