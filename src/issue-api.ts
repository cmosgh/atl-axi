import { jiraJson } from "./client.js";
import { usageError } from "./errors.js";
import { arr, obj, str, type Obj } from "./render.js";

const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

export function issueKey(raw: string | undefined, label = "issue key"): string {
  const key = (raw ?? "").trim().toUpperCase();
  if (!KEY_RE.test(key)) throw usageError(`invalid ${label} '${raw ?? ""}' - expected e.g. PROJ-123`);
  return key;
}

export function projectKey(raw: string | undefined): string {
  const key = (raw ?? "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw usageError(`invalid project key '${raw ?? ""}' - expected e.g. PROJ`);
  return key;
}

export function issuePath(key: string): string {
  return `/rest/api/3/issue/${encodeURIComponent(key)}`;
}

export async function fetchIssue(key: string, fields: readonly string[], query: Record<string, string> = {}): Promise<Obj> {
  return obj(await jiraJson(issuePath(key), { query: { fields: fields.join(","), ...query } }));
}

export interface SearchPage {
  issues: Obj[];
  more: boolean;
}

/** `/search/jql` pages by token and reports no total. */
export async function searchJql(jql: string, fields: readonly string[], limit: number, timeoutMs?: number): Promise<SearchPage> {
  const issues: Obj[] = [];
  let token: string | undefined;
  let more = false;
  do {
    const page = obj(
      await jiraJson("/rest/api/3/search/jql", {
        query: { jql, fields: fields.join(","), maxResults: Math.min(100, limit - issues.length), nextPageToken: token },
        timeoutMs,
      }),
    );
    issues.push(...arr(page["issues"]).map(obj));
    token = str(page["nextPageToken"]) || undefined;
    more = token !== undefined && page["isLast"] !== true;
  } while (more && issues.length < limit);
  return { issues: issues.slice(0, limit), more: more || issues.length > limit };
}

export function fields(issue: Obj): Obj {
  return obj(issue["fields"]);
}

export function statusName(issue: Obj): string {
  return str(obj(fields(issue)["status"])["name"]) || "unknown";
}

export function statusCategory(issue: Obj): string {
  return str(obj(obj(fields(issue)["status"])["statusCategory"])["key"]);
}

export function userName(value: unknown): string {
  return str(obj(value)["displayName"]) || "unassigned";
}

/** JQL string literal. */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
