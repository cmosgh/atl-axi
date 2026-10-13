import { bool, flag, intFlag, parseArgs, parseFields } from "../args.js";
import { usageError } from "../errors.js";
import { displayValue, fieldCatalog, formatValue, pointsFields, sprintFields, sprintRefs, type FieldDef } from "../fields.js";
import { fields, jqlString, projectKey, searchJql, statusName, userName } from "../issue-api.js";
import { block, countLine, dig, helpBlock, obj, out, relTime, str, type Obj } from "../render.js";

export const SEARCH_HELP = `usage: atl-axi search ["<JQL>"] [flags]
Search issues by JQL and/or shortcut filters (combined with AND). Default order: updated DESC.
flags:
  --project <KEY>, --mine (assigned to you, not done), --status <name>, --sprint <id|open>, --text <words>, --limit <1-200> (default 20), --fields <type,priority,points,sprint,parent,labels,reporter,created,updated>
examples[4]:
  atl-axi search --mine
  atl-axi search --project PROJ --sprint open --fields points
  atl-axi search "project = PROJ AND status = 'In Progress'" --limit 50
  atl-axi search --text "login timeout" --project PROJ
`;

const EXTRA_FIELDS = ["type", "priority", "points", "sprint", "parent", "labels", "reporter", "created", "updated"] as const;

export function buildJql(base: string | undefined, filters: { project?: string; mine?: boolean; status?: string; sprint?: string; text?: string }): string {
  const clauses: string[] = [];
  let order = "ORDER BY updated DESC";
  if (base && base.trim()) {
    const match = base.match(/\s+ORDER\s+BY\s+.*$/i);
    const where = match ? base.slice(0, match.index).trim() : base.trim();
    if (match) order = match[0].trim();
    if (where) clauses.push(filters.project || filters.mine || filters.status || filters.sprint || filters.text ? `(${where})` : where);
  }
  if (filters.project) clauses.push(`project = ${filters.project}`);
  if (filters.mine) clauses.push("assignee = currentUser() AND statusCategory != Done");
  if (filters.status) clauses.push(`status = ${jqlString(filters.status)}`);
  if (filters.sprint) clauses.push(filters.sprint === "open" ? "sprint in openSprints()" : `sprint = ${filters.sprint}`);
  if (filters.text) clauses.push(`text ~ ${jqlString(filters.text)}`);
  return `${clauses.join(" AND ")} ${order}`.trim();
}

export function issueRow(issue: Obj, extras: readonly string[], catalog: FieldDef[]): Obj {
  const f = fields(issue);
  const row: Obj = {
    key: str(issue["key"]),
    summary: str(f["summary"]),
    status: statusName(issue),
    assignee: userName(f["assignee"]),
  };
  for (const extra of extras) {
    if (extra === "type") row["type"] = str(dig(f, "issuetype", "name"));
    else if (extra === "priority") row["priority"] = formatValue(f["priority"]);
    else if (extra === "points") row["points"] = displayValue(pointsFields(catalog).map((p) => f[p.id]).find((v) => v !== null && v !== undefined));
    else if (extra === "sprint") {
      const refs = sprintFields(catalog).flatMap((s) => sprintRefs(f[s.id]));
      const open = refs.filter((s) => s.state !== "closed");
      row["sprint"] = (open.length > 0 ? open : refs.slice(-1)).map((s) => s.name).join("; ") || "none";
    } else if (extra === "parent") row["parent"] = str(obj(f["parent"])["key"]) || "none";
    else if (extra === "labels") row["labels"] = formatValue(f["labels"]);
    else if (extra === "reporter") row["reporter"] = userName(f["reporter"]);
    else if (extra === "created") row["created"] = relTime(f["created"]);
    else if (extra === "updated") row["updated"] = relTime(f["updated"]);
  }
  return row;
}

export function requestFields(extras: readonly string[], catalog: FieldDef[]): string[] {
  const out = ["summary", "status", "assignee"];
  for (const extra of extras) {
    if (extra === "type") out.push("issuetype");
    else if (extra === "points") out.push(...pointsFields(catalog).map((f) => f.id));
    else if (extra === "sprint") out.push(...sprintFields(catalog).map((f) => f.id));
    else out.push(extra);
  }
  return out;
}

export async function searchCommand(args: string[]): Promise<string> {
  const command = "atl-axi search";
  const parsed = parseArgs(
    args,
    [
      { name: "--project" },
      { name: "--mine", boolean: true },
      { name: "--status" },
      { name: "--sprint" },
      { name: "--text" },
      { name: "--limit" },
      { name: "--fields" },
      { name: "--query" },
    ],
    command,
  );
  if (parsed.positionals.length > 1) throw usageError("pass the JQL as one quoted argument", [`usage: ${command} "<JQL>" [flags]`]);
  const base = parsed.positionals[0] ?? flag(parsed, "--query");
  const limit = intFlag(parsed, "--limit", 20, { min: 1, max: 200 });
  const extras = parseFields(flag(parsed, "--fields"), EXTRA_FIELDS);
  const sprint = flag(parsed, "--sprint");
  if (sprint !== undefined && sprint !== "open" && !/^\d+$/.test(sprint)) throw usageError(`--sprint expects a sprint id or 'open', got '${sprint}'`);
  const project = flag(parsed, "--project") === undefined ? undefined : projectKey(flag(parsed, "--project"));
  const filters = { project, mine: bool(parsed, "--mine"), status: flag(parsed, "--status"), sprint, text: flag(parsed, "--text") };
  if (!base && !filters.project && !filters.mine && !filters.status && !filters.sprint && !filters.text) {
    throw usageError("give a JQL query or at least one filter", ["Run `atl-axi search --help` for filters", "Try `atl-axi search --mine`"]);
  }
  const jql = buildJql(base, filters);

  const catalog = extras.includes("points") || extras.includes("sprint") ? await fieldCatalog() : [];
  const page = await searchJql(jql, requestFields(extras, catalog), limit);
  if (page.issues.length === 0) return block({ jql, issues: "0 matching issues" });

  const help = ["Run `atl-axi issue view <KEY>` for details"];
  if (page.more && limit < 200) help.push(`Repeat with --limit ${Math.min(200, limit * 2)} for more`);
  return out(
    block({ jql, count: countLine(page.issues.length, undefined, page.more), issues: page.issues.map((i) => issueRow(i, extras, catalog)) }),
    helpBlock(help),
  );
}
