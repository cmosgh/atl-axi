import { readFileSync } from "node:fs";
import { flag, type ParsedArgs } from "./args.js";
import { usageError } from "./errors.js";

/**
 * Read a text value from `--<name>` or `--<name>-file <path|->`. Returns
 * undefined when neither is given; giving both is a usage error.
 */
export function readText(parsed: ParsedArgs, name: string, usage: string): string | undefined {
  const inline = flag(parsed, name);
  const file = flag(parsed, `${name}-file`);
  if (inline !== undefined && file !== undefined) throw usageError(`give only one of ${name} or ${name}-file`, [usage]);
  if (file === undefined) return inline;
  try {
    return readFileSync(file === "-" ? 0 : file, "utf-8");
  } catch {
    throw usageError(`could not read ${name}-file ${file === "-" ? "(stdin)" : file}`);
  }
}
