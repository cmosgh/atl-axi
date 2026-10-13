import { expectPositionals, flag, intFlag, parseArgs, parseFields } from "../args.js";
import { jiraJson } from "../client.js";
import { usageError } from "../errors.js";
import { fieldCatalog, pointsFields, sprintFields, sprintRefs, type SprintRef } from "../fields.js";
import { fields, projectKey, searchJql } from "../issue-api.js";
import { arr, block, helpBlock, num, obj, out, str } from "../render.js";
import { issueRow, requestFields } from "./search.js";

export const SPRINT_HELP = `usage: atl-axi sprint <list|issues> [args] [flags]
subcommands[2]:
  list --project <KEY> | --board <id>, issues <sprint-id>
flags{list}:
  --project <KEY> (sprints seen on the project's issues; works without Agile API scopes), --board <id> (Agile API; needs read:sprint:jira-software), --state <active,future,closed> (default active,future)
flags{issues}:
  --limit <1-200> (default 50), --fields <type,priority,points,parent,labels,updated>
examples[3]:
  atl-axi sprint list --project PROJ
  atl-axi sprint issues 578 --fields points
  atl-axi issue edit PROJ-123 --sprint 578
`;

const STATES = ["active", "future", "closed"] as const;
const STATE_JQL: Record<string, string> = { active: "openSprints()", future: "futureSprints()", closed: "closedSprints()" };

export async function sprintCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "list") return sprintList(rest);
  if (sub === "issues") return sprintIssues(rest);
  throw usageError(sub ? `unknown sprint subcommand '${sub}'` : "missing sprint subcommand", ["subcommands: list, issues <sprint-id>"]);
}

async function sprintList(args: string[]): Promise<string> {
  const command = "atl-axi sprint list";
  const parsed = parseArgs(args, [{ name: "--project" }, { name: "--board" }, { name: "--state" }], command);
  expectPositionals(parsed, 0, `${command} --project <KEY> | --board <id> [--state active,future]`);
  const states = flag(parsed, "--state") === undefined ? ["active", "future"] : parseFields(flag(parsed, "--state"), STATES);
  const board = flag(parsed, "--board");
  const rawProject = flag(parsed, "--project");
  if ((board === undefined) === (rawProject === undefined)) throw usageError("give exactly one of --project or --board");
  if (board !== undefined && !/^\d+$/.test(board)) throw usageError(`--board expects a numeric board id, got '${board}'`);

  let sprints: SprintRef[];
  let source: string;
  if (board !== undefined) {
    const page = obj(await jiraJson(`/rest/agile/1.0/board/${board}/sprint`, { query: { state: states.join(","), maxResults: 50 } }));
    sprints = arr(page["values"]).map(obj).map((s) => ({ id: num(s["id"]) ?? 0, name: str(s["name"]), state: str(s["state"]), boardId: Number(board) }));
    source = `board ${board}`;
  } else {
    const project = projectKey(rawProject);
    const catalog = await fieldCatalog();
    const sprintIds = sprintFields(catalog).map((f) => f.id);
    if (sprintIds.length === 0) return block({ sprints: "this site has no sprint field" });
    const jql = `project = ${project} AND (${states.map((s) => `sprint in ${STATE_JQL[s]}`).join(" OR ")}) ORDER BY updated DESC`;
    const page = await searchJql(jql, sprintIds, 200);
    const seen = new Map<number, SprintRef>();
    for (const issue of page.issues) {
      for (const id of sprintIds) for (const s of sprintRefs(fields(issue)[id])) if (states.includes(s.state)) seen.set(s.id, s);
    }
    sprints = [...seen.values()];
    source = `issues in ${project}`;
  }

  const order = (s: SprintRef): number => STATES.indexOf(s.state as (typeof STATES)[number]);
  sprints.sort((x, y) => order(x) - order(y) || x.id - y.id);
  if (sprints.length === 0) return block({ sprints: `0 ${states.join("/")} sprints found via ${source}` });
  return out(
    block({ source, sprints: sprints.map((s) => ({ id: s.id, name: s.name, state: s.state, board: s.boardId ?? "unknown" })) }),
    helpBlock([
      "Run `atl-axi sprint issues <id>` for a sprint's issues",
      "Run `atl-axi issue edit <KEY> --sprint <id>` to move an issue into a sprint",
      ...(board === undefined ? ["Empty future sprints are not listed here; use --board <id> with Agile API scopes to see them"] : []),
    ]),
  );
}

async function sprintIssues(args: string[]): Promise<string> {
  const command = "atl-axi sprint issues";
  const parsed = parseArgs(args, [{ name: "--limit" }, { name: "--fields" }], command);
  const [raw] = expectPositionals(parsed, 1, `${command} <sprint-id> [--limit n] [--fields a,b]`);
  if (!/^\d+$/.test(raw ?? "")) throw usageError(`invalid sprint id '${raw}'`, ["Run `atl-axi sprint list --project <KEY>` for ids"]);
  const limit = intFlag(parsed, "--limit", 50, { min: 1, max: 200 });
  const extras = parseFields(flag(parsed, "--fields"), ["type", "priority", "points", "parent", "labels", "updated"]);

  const catalog = await fieldCatalog();
  const wanted = [...new Set([...requestFields(extras, catalog), ...pointsFields(catalog).map((f) => f.id)])];
  const page = await searchJql(`sprint = ${raw} ORDER BY rank ASC`, wanted, limit);
  if (page.issues.length === 0) return block({ sprint: Number(raw), issues: "0 issues" });

  const points = page.issues
    .map((i) => pointsFields(catalog).map((f) => num(fields(i)[f.id])).find((v) => v !== undefined))
    .filter((v): v is number => v !== undefined);
  const byStatus = new Map<string, number>();
  for (const issue of page.issues) {
    const s = str(obj(fields(issue)["status"])["name"]);
    byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
  }
  return out(
    block({
      sprint: Number(raw),
      count: page.more ? `${page.issues.length}+` : page.issues.length,
      points: points.length > 0 ? `${points.reduce((a, b) => a + b, 0)} across ${points.length} estimated` : "none estimated",
      by_status: [...byStatus.entries()].map(([s, n]) => `${s} ${n}`).join("; "),
      issues: page.issues.map((i) => issueRow(i, extras, catalog)),
    }),
    helpBlock(["Run `atl-axi issue view <KEY>` for details"]),
  );
}
