import { bool, expectPositionals, flag, parseArgs } from "../args.js";
import { usageError } from "../errors.js";
import { fieldCatalog } from "../fields.js";
import { block, helpBlock, out } from "../render.js";

export const FIELD_HELP = `usage: atl-axi field list [flags]
List the site's fields - ids for --fields and --set. Cached for a day.
flags:
  --search <text> (name or id contains), --custom (custom fields only), --refresh (re-read the catalog)
examples[2]:
  atl-axi field list --search points
  atl-axi field list --custom
`;

export async function fieldCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  if (sub !== "list") throw usageError(sub ? `unknown field subcommand '${sub}'` : "missing field subcommand", ["subcommands: list"]);
  const command = "atl-axi field list";
  const parsed = parseArgs(rest, [{ name: "--search" }, { name: "--custom", boolean: true }, { name: "--refresh", boolean: true }], command);
  expectPositionals(parsed, 0, `${command} [--search <text>] [--custom]`);
  const needle = flag(parsed, "--search")?.toLowerCase();

  const catalog = await fieldCatalog({ refresh: bool(parsed, "--refresh") });
  const rows = catalog
    .filter((f) => !bool(parsed, "--custom") || f.custom)
    .filter((f) => !needle || f.name.toLowerCase().includes(needle) || f.id.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => ({ id: f.id, name: f.name, type: f.items ? `${f.type} of ${f.items}` : f.type || "unknown" }));
  if (rows.length === 0) return block({ fields: `0 fields match${needle ? ` '${needle}'` : ""}` });
  return out(
    block({ count: rows.length, fields: rows }),
    helpBlock(["Run `atl-axi issue view <KEY> --fields '<name>'` to read one", "Run `atl-axi issue edit <KEY> --set '<name>=<value>'` to set one"]),
  );
}
