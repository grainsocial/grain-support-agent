import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isPrivate, MAX_ROWS, open, query } from "./grain-db.ts";

// An MCP server over stdio that gives the investigation agent read-only SQL on
// grain-serve's index. opencode spawns it; the path comes from GRAIN_DB_PATH.

const path = process.env.GRAIN_DB_PATH;
if (!path) throw new Error("GRAIN_DB_PATH is not set");

const server = new McpServer({ name: "grain-db", version: "1.0.0" });

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

server.registerTool(
  "list_tables",
  {
    description:
      "List the tables in grain-serve's index. Each record collection has a table named for it: profile, gallery, gallery_item, photo, photo_exif, comment, favorite, follow, story and so on, a row per record with uri, cid, did (its author), indexed_at, then the record's fields in snake case. Beside them are repo, report, label, takedown and classification. grain/crates/grain-serve/src/index/schema.rs describes every table.",
    inputSchema: {},
  },
  async () => {
    const rows = open(path)
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all()
      .map((r) => String(r.name))
      .filter((name) => !isPrivate(name));
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
    if (isPrivate(table)) return failure(`${table} holds private data and cannot be read`);
    const rows = open(path)
      .prepare(`SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ?`)
      .all(table);
    return rows.length ? text(rows) : failure(`no table named ${table}`);
  },
);

server.registerTool(
  "sql_query",
  {
    description: `Run one read-only SELECT against grain-serve's index (SQLite) and get up to ${MAX_ROWS} rows back. The index is live and large; filter and LIMIT rather than scanning. Timestamps are ISO 8601 strings; compare with strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day'), not datetime(). JSON columns (a photo's blob, a classification's signals) read with json_extract.`,
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
