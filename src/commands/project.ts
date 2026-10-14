import { expectPositionals, flag, intFlag, parseArgs } from "../args.js";
import { jiraJson } from "../client.js";
import { usageError } from "../errors.js";
import { projectKey } from "../issue-api.js";
import { arr, block, countLine, helpBlock, num, obj, out, str } from "../render.js";

export const PROJECT_HELP = `usage: atl-axi project <list|view> [args] [flags]
subcommands[2]:
  list, view <KEY> (issue types with their hierarchy level and workflow statuses)
flags{list}:
  --search <text> (key or name contains), --limit <1-100> (default 50)
examples[2]:
  atl-axi project list --search pay
  atl-axi project view PROJ
`;

export async function projectCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub === "view") return projectView(rest);
  if (sub !== "list") throw usageError(sub ? `unknown project subcommand '${sub}'` : "missing project subcommand", ["subcommands: list, view"]);
  const command = "atl-axi project list";
  const parsed = parseArgs(rest, [{ name: "--search" }, { name: "--limit" }], command);
  expectPositionals(parsed, 0, `${command} [--search <text>]`);
  const limit = intFlag(parsed, "--limit", 50, { min: 1, max: 100 });

  const page = obj(
    await jiraJson("/rest/api/3/project/search", { query: { query: flag(parsed, "--search"), maxResults: limit, orderBy: "key" } }),
  );
  const rows = arr(page["values"]).map((raw) => {
    const p = obj(raw);
    return { key: str(p["key"]), name: str(p["name"]), type: str(p["projectTypeKey"]) };
  });
  if (rows.length === 0) return block({ projects: "0 projects visible to this token" });
  return out(
    block({ count: countLine(rows.length, num(page["total"]), page["isLast"] === false), projects: rows }),
    helpBlock(["Run `atl-axi search --project <KEY>` for its recent issues"]),
  );
}

async function projectView(args: string[]): Promise<string> {
  const command = "atl-axi project view";
  const [raw] = expectPositionals(parseArgs(args, [], command), 1, `${command} <KEY>`);
  const key = projectKey(raw);
  const [project, statuses] = await Promise.all([
    jiraJson(`/rest/api/3/project/${key}`).then(obj),
    jiraJson(`/rest/api/3/project/${key}/statuses`).then(arr),
  ]);
  const levels = new Map(arr(project["issueTypes"]).map(obj).map((t) => [str(t["id"]), num(t["hierarchyLevel"]) ?? 0]));
  const types = statuses
    .map(obj)
    .map((t) => ({
      type: str(t["name"]),
      level: levels.get(str(t["id"])) ?? (t["subtask"] === true ? -1 : 0),
      statuses: arr(t["statuses"]).map((st) => str(obj(st)["name"])).join("; "),
    }))
    .sort((a, b) => b.level - a.level || a.type.localeCompare(b.type));
  return out(
    block({
      project: { key, name: str(project["name"]), style: str(project["style"]) === "next-gen" ? "team-managed" : "company-managed", lead: str(obj(project["lead"])["displayName"]) || "none" },
      types,
    }),
    helpBlock([
      "level: 1 epic; 0 standard; -1 subtask",
      `Run \`atl-axi issue create --project ${key} --type <type> --summary <text>\``,
    ]),
  );
}
