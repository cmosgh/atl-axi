import { adfToText, textToAdf } from "./adf.js";
import { jiraJson, resolveCloudId } from "./client.js";
import { readCache, writeCache } from "./config.js";
import { usageError } from "./errors.js";
import { arr, num, obj, str, type Obj } from "./render.js";

export interface FieldDef {
  id: string;
  name: string;
  custom: boolean;
  /** schema.type, e.g. string, number, array, option, user, sprint-ish */
  type: string;
  /** schema.items for arrays */
  items: string;
  /** schema.custom plugin key for custom fields */
  plugin: string;
}

const CACHE_TTL_MS = 24 * 3_600_000;
const SPRINT_PLUGIN = "com.pyxis.greenhopper.jira:gh-sprint";
const POINTS_NAMES = ["story points", "story point estimate"];

interface FieldCache {
  cloudId: string;
  at: number;
  fields: FieldDef[];
}

export function toFieldDef(raw: unknown): FieldDef {
  const f = obj(raw);
  const schema = obj(f["schema"]);
  return {
    id: str(f["id"]),
    name: str(f["name"]),
    custom: f["custom"] === true,
    type: str(schema["type"]),
    items: str(schema["items"]),
    plugin: str(schema["custom"]),
  };
}

/** The site's field catalog, cached for a day per cloud id. */
export async function fieldCatalog(options: { refresh?: boolean } = {}): Promise<FieldDef[]> {
  const cloudId = await resolveCloudId();
  const cached = readCache<FieldCache>("fields");
  if (!options.refresh && cached && cached.cloudId === cloudId && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.fields;
  }
  const fields = arr(await jiraJson("/rest/api/3/field")).map(toFieldDef).filter((f) => f.id);
  writeCache("fields", { cloudId, at: Date.now(), fields } satisfies FieldCache);
  return fields;
}

export function sprintFields(catalog: FieldDef[]): FieldDef[] {
  return catalog.filter((f) => f.plugin === SPRINT_PLUGIN);
}

/** Ordered by preference: the classic "Story Points" before "Story point estimate". */
export function pointsFields(catalog: FieldDef[]): FieldDef[] {
  return POINTS_NAMES.flatMap((name) => catalog.filter((f) => f.name.toLowerCase() === name && (f.type === "number" || f.type === "")));
}

/** Resolve a user-supplied field name or id; ambiguity is a usage error. */
export function findField(catalog: FieldDef[], nameOrId: string): FieldDef {
  const needle = nameOrId.trim().toLowerCase();
  const byId = catalog.find((f) => f.id.toLowerCase() === needle);
  if (byId) return byId;
  const byName = catalog.filter((f) => f.name.toLowerCase() === needle);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw usageError(`field name '${nameOrId}' is ambiguous`, [
      `use one of the ids: ${byName.map((f) => f.id).join(", ")}`,
    ]);
  }
  const near = catalog.filter((f) => f.name.toLowerCase().includes(needle)).slice(0, 5);
  throw usageError(`unknown field '${nameOrId}'`, [
    near.length > 0 ? `did you mean: ${near.map((f) => `${f.name} (${f.id})`).join("; ")}` : "Run `atl-axi field list --search <text>` to find it",
  ]);
}

/**
 * Pick the candidate on the issue's screen. When several are, the one already
 * holding a value wins, so an edit never fills a parallel empty field.
 */
export function onScreen(candidates: FieldDef[], editable: Obj, current: Obj = {}): FieldDef | undefined {
  const shown = candidates.filter((f) => f.id in editable);
  return shown.find((f) => current[f.id] !== null && current[f.id] !== undefined) ?? shown[0];
}

export interface SprintRef {
  id: number;
  name: string;
  state: string;
  boardId?: number;
}

export function sprintRefs(value: unknown): SprintRef[] {
  return arr(value)
    .map(obj)
    .filter((s) => num(s["id"]) !== undefined)
    .map((s) => ({ id: num(s["id"])!, name: str(s["name"]), state: str(s["state"]).toLowerCase(), boardId: num(s["boardId"]) }));
}

/** Numbers pass through (TOON quotes numeric-looking strings); everything else via formatValue. */
export function displayValue(value: unknown): string | number {
  return typeof value === "number" && Number.isFinite(value) ? value : formatValue(value);
}

/** One-line rendering of any Jira field value. */
export function formatValue(value: unknown, limit = 200): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "string") return value.length > limit ? `${value.slice(0, limit)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    const sprints = sprintRefs(value);
    if (sprints.length === value.length) return sprints.map((s) => `${s.name} (${s.state})`).join("; ");
    return value.map((v) => formatValue(v, limit)).join("; ");
  }
  const o = obj(value);
  if (o["type"] === "doc") return formatValue(adfToText(o).replace(/\s+/g, " "), limit);
  for (const key of ["displayName", "name", "value", "key"]) {
    if (typeof o[key] === "string" && o[key] !== "") return o[key] as string;
  }
  return JSON.stringify(value).slice(0, limit);
}

/** Coerce a CLI string into the JSON shape the field's schema expects. */
export function coerceValue(field: FieldDef, raw: string): unknown {
  const value = raw.trim();
  if (value === "" || value.toLowerCase() === "none") return null;
  const list = (): string[] => value.split(",").map((v) => v.trim()).filter(Boolean);
  switch (field.type) {
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw usageError(`${field.name} expects a number, got '${raw}'`);
      return n;
    }
    case "string":
      return field.plugin.endsWith(":textarea") ? textToAdf(value) : value;
    case "date":
    case "datetime":
      return value;
    case "option":
      return { value };
    case "priority":
      return { name: value };
    case "user":
      return { accountId: value };
    case "issuelink":
      return { key: value.toUpperCase() };
    case "array":
      if (field.plugin === SPRINT_PLUGIN) {
        const id = Number(value);
        if (!Number.isInteger(id)) throw usageError(`${field.name} expects a sprint id, got '${raw}'`, ["Run `atl-axi sprint list --project <KEY>` for ids"]);
        return id;
      }
      if (field.items === "string") return list();
      if (field.items === "option") return list().map((v) => ({ value: v }));
      if (field.items === "version" || field.items === "component") return list().map((v) => ({ name: v }));
      if (field.items === "user") return list().map((v) => ({ accountId: v }));
      break;
  }
  throw usageError(`setting ${field.name} (${field.type}${field.items ? ` of ${field.items}` : ""}) is not supported by --set`, [
    `Use \`atl-axi api PUT /rest/api/3/issue/<KEY> --data '{"fields":{"${field.id}":...}}'\``,
  ]);
}
