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

/** Read an ADF document from `--<name>-adf <path|->`; it must be a JSON `doc` node. */
export function readAdf(parsed: ParsedArgs, name: string): Record<string, unknown> | undefined {
  const file = flag(parsed, `${name}-adf`);
  if (file === undefined) return undefined;
  let raw: string;
  try {
    raw = readFileSync(file === "-" ? 0 : file, "utf-8");
  } catch {
    throw usageError(`could not read ${name}-adf ${file === "-" ? "(stdin)" : file}`);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw usageError(`${name}-adf is not valid JSON`);
  }
  if (doc === null || typeof doc !== "object" || (doc as Record<string, unknown>)["type"] !== "doc") {
    throw usageError(`${name}-adf must be an ADF document ({"type":"doc","version":1,"content":[...]})`, [
      "Fetch the current one with `atl-axi api GET /rest/api/3/issue/<KEY> --query fields=description --raw`",
    ]);
  }
  return doc as Record<string, unknown>;
}
