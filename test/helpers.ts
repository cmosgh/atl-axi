import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { main } from "../src/cli.js";

export interface Route {
  method?: string;
  /** Path below /ex/jira/<cloud>, matched exactly unless a RegExp is given. */
  path: string | RegExp;
  status?: number;
  json?: unknown;
  /** Dynamic response; wins over json. */
  reply?: (call: Call) => { status?: number; json?: unknown };
}

export interface Call {
  method: string;
  url: URL;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export const CLOUD = "test-cloud";
export const ME = { accountId: "acc-robin", displayName: "Robin Reviewer" };
export const ANA = { accountId: "acc-ana", displayName: "Ana Author" };

/** Env-based credentials so tests never touch the real OS keychain. */
export function useTestEnv(): void {
  process.env["ATLASSIAN_EMAIL"] = "robin@example.test";
  process.env["ATLASSIAN_API_TOKEN"] = "test-token";
  process.env["JIRA_CLOUD_ID"] = CLOUD;
  process.env["ATL_AXI_NO_KEYCHAIN"] = "1";
  process.env["ATL_AXI_CONFIG_DIR"] = mkdtempSync(join(tmpdir(), "atl-axi-test-"));
  delete process.env["ATLASSIAN_SITE"];
  delete process.env["ATL_AXI_API_BASE"];
}

/** Synthetic field catalog: two points fields (only one per screen) and a sprint field. */
export const FIELDS = [
  { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
  { id: "labels", name: "Labels", custom: false, schema: { type: "array", items: "string" } },
  { id: "customfield_10014", name: "Story Points", custom: true, schema: { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" } },
  { id: "customfield_10103", name: "Story point estimate", custom: true, schema: { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float" } },
  { id: "customfield_10010", name: "Sprint", custom: true, schema: { type: "array", items: "json", custom: "com.pyxis.greenhopper.jira:gh-sprint" } },
  { id: "customfield_10200", name: "Team", custom: true, schema: { type: "option", custom: "com.atlassian.jira.plugin.system.customfieldtypes:select" } },
  { id: "customfield_10300", name: "Notes", custom: true, schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" } },
];

export function mockApi(routes: Route[]): { calls: Call[] } {
  const calls: Call[] = [];
  const all: Route[] = [...routes, { path: "/rest/api/3/field", json: FIELDS }, { path: "/rest/api/3/myself", json: ME }];
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(`/ex/jira/${CLOUD}`, "");
    const call: Call = {
      method,
      url,
      path,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const route = all.find(
      (r) => (r.method ?? "GET") === method && (typeof r.path === "string" ? r.path === path : r.path.test(path)),
    );
    if (!route) return new Response(JSON.stringify({ errorMessages: [`no mock for ${method} ${path}`] }), { status: 404 });
    const dynamic = route.reply?.(call);
    const status = dynamic?.status ?? route.status ?? 200;
    const json = dynamic?.json ?? route.json;
    return new Response(status === 204 ? null : JSON.stringify(json ?? {}), { status });
  });
  return { calls };
}

export async function run(...argv: string[]): Promise<{ stdout: string; exitCode: number }> {
  let stdout = "";
  process.exitCode = 0;
  await main({ argv, stdout: { write: (chunk: string) => (stdout += chunk) } });
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { stdout, exitCode };
}

export function issue(key: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    fields: {
      summary: "Retry the sync worker",
      status: { name: "To Do", statusCategory: { key: "new" } },
      issuetype: { name: "Task" },
      priority: { name: "Medium" },
      assignee: ANA,
      labels: [],
      updated: new Date(Date.now() - 3_600_000).toISOString(),
      ...fields,
    },
  };
}

export const doc = (text: string): Record<string, unknown> => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});
