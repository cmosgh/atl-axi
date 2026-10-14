import { bool, flag, parseArgs } from "../args.js";
import { jiraJson } from "../client.js";
import { usageError } from "../errors.js";
import { block, helpBlock, out, type Obj } from "../render.js";

export const API_HELP = `usage: atl-axi api [GET|POST|PUT|DELETE] <path> [flags]
Escape hatch for any Jira Cloud REST endpoint (/rest/api/3/..., /rest/agile/1.0/...), sent through the configured site.
flags:
  --query <key=value> (repeatable), --data <json> (request body), --full (do not truncate long strings), --raw (print the response body as compact JSON, for jq or a read-modify-write), --confirm (required for DELETE)
examples[4]:
  atl-axi api /rest/api/3/issue/PROJ-1/worklog
  atl-axi api /rest/api/3/issue/PROJ-1 --query fields=description --raw
  atl-axi api /rest/api/3/project/PROJ/versions
  atl-axi api PUT /rest/api/3/issue/PROJ-1 --data '{"fields":{"customfield_10050":"x"}}'
`;

const METHODS = ["GET", "POST", "PUT", "DELETE"] as const;
type Method = (typeof METHODS)[number];
const STRING_LIMIT = 300;
const ARRAY_LIMIT = 50;

/** Raw API payloads are verbose; cap strings and arrays unless --full. */
function shrink(value: unknown, stats: { cut: boolean }): unknown {
  if (typeof value === "string") {
    if (value.length <= STRING_LIMIT) return value;
    stats.cut = true;
    return `${value.slice(0, STRING_LIMIT)}... (${value.length} chars)`;
  }
  if (Array.isArray(value)) {
    if (value.length > ARRAY_LIMIT) stats.cut = true;
    return value.slice(0, ARRAY_LIMIT).map((item) => shrink(item, stats));
  }
  if (value !== null && typeof value === "object") {
    const result: Obj = {};
    for (const [key, inner] of Object.entries(value)) {
      // `self`/`avatarUrls`/`expand` are navigation noise for an agent.
      if (key === "self" || key === "avatarUrls" || key === "expand" || key === "iconUrl") continue;
      result[key] = shrink(inner, stats);
    }
    return result;
  }
  return value;
}

export async function apiCommand(args: string[]): Promise<string> {
  const command = "atl-axi api";
  const usage = `${command} [GET|POST|PUT|DELETE] <path> [--query k=v] [--data <json>]`;
  const parsed = parseArgs(
    args,
    [
      { name: "--query", repeatable: true },
      { name: "--data" },
      { name: "--full", boolean: true },
      { name: "--raw", boolean: true },
      { name: "--confirm", boolean: true },
    ],
    command,
  );

  const positionals = [...parsed.positionals];
  let method: Method = "GET";
  const first = positionals[0]?.toUpperCase();
  if (first !== undefined && (METHODS as readonly string[]).includes(first)) {
    method = first as Method;
    positionals.shift();
  }
  if (positionals.length !== 1) {
    throw usageError(positionals.length === 0 ? "missing API path" : "too many arguments", [`usage: ${usage}`]);
  }

  const path = positionals[0]!;
  if (!/^\/rest\//.test(path) || path.includes("://")) {
    throw usageError("path must start with /rest/ (e.g. /rest/api/3/issue/PROJ-1)", [`usage: ${usage}`]);
  }

  const query: Record<string, string> = {};
  for (const pair of parsed.values.get("--query") ?? []) {
    const eq = pair.indexOf("=");
    if (eq < 1) throw usageError(`--query expects key=value, got '${pair}'`);
    query[pair.slice(0, eq)] = pair.slice(eq + 1);
  }

  let body: unknown;
  const data = flag(parsed, "--data");
  if (data !== undefined) {
    if (method === "GET") throw usageError("--data needs POST or PUT", [`usage: ${usage}`]);
    try {
      body = JSON.parse(data) as unknown;
    } catch {
      throw usageError("--data is not valid JSON");
    }
  }

  if (method === "DELETE" && !bool(parsed, "--confirm")) {
    return out(
      block({ delete_preview: { path, result: "NOT executed - DELETE needs --confirm" } }),
      helpBlock([`Run \`${command} DELETE ${positionals[0]} --confirm\` to execute`]),
    );
  }

  const response = await jiraJson(path, { method, query, body });
  if (bool(parsed, "--raw")) return JSON.stringify(response);
  const stats = { cut: false };
  const shown = bool(parsed, "--full") ? response : shrink(response, stats);
  const payload: Obj =
    shown !== null && typeof shown === "object" && !Array.isArray(shown)
      ? (shown as Obj)
      : { result: shown };
  return out(
    block(Object.keys(payload).length === 0 ? { result: `${method} ${path} succeeded (empty response)` } : payload),
    helpBlock(stats.cut ? ["Long strings/arrays were truncated and self/avatar links dropped; add `--full` for the raw payload"] : []),
  );
}
