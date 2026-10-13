import { expectPositionals, flag, intFlag, parseArgs } from "../args.js";
import { jiraJson } from "../client.js";
import { usageError } from "../errors.js";
import { arr, block, countLine, helpBlock, num, obj, out, str } from "../render.js";

export const PROJECT_HELP = `usage: atl-axi project list [flags]
flags:
  --search <text> (key or name contains), --limit <1-100> (default 50)
examples[1]:
  atl-axi project list --search pay
`;

export async function projectCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub !== "list") throw usageError(sub ? `unknown project subcommand '${sub}'` : "missing project subcommand", ["subcommands: list"]);
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
