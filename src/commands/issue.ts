import { adfToText, textToAdf } from "../adf.js";
import { bool, expectPositionals, flag, flags, intFlag, parseArgs, type ParsedArgs } from "../args.js";
import { jiraJson } from "../client.js";
import { usageError, axiError } from "../errors.js";
import {
  coerceValue,
  displayValue,
  fieldCatalog,
  findField,
  formatValue,
  onScreen,
  pointsFields,
  sprintFields,
  sprintRefs,
  type FieldDef,
} from "../fields.js";
import { fetchIssue, fields, issueKey, issuePath, jqlString, projectKey, searchJql, statusName, userName } from "../issue-api.js";
import { currentUser } from "../me.js";
import { arr, block, dig, helpBlock, num, obj, out, relTime, str, truncate, type Obj } from "../render.js";
import { readText } from "../text-input.js";
import { linkCommand, linkRows } from "./link.js";

export const ISSUE_HELP = `usage: atl-axi issue <subcommand> [args] [flags]
subcommands[8]:
  view <KEY>, comments <KEY>, comment <KEY>, create, edit <KEY>, transition <KEY> [<status-or-transition>], link <KEY> <relation> <KEY>, unlink <KEY> <relation> <KEY>
flags{view}:
  --full (whole description), --fields <name-or-id,...> (extra fields by name, e.g. 'Fix versions,customfield_10050')
flags{comments}:
  --limit <1-100> (default 10, newest last), --full
flags{comment}:
  --body <text> | --body-file <path|-> (plain text; blank-line paragraphs, '- ' lists, fenced code)
flags{create}:
  --project <KEY> --type <name> --summary <text> (required), --description[-file], --parent <KEY>, --points <n>, --sprint <id>, --labels <a,b>, --assignee <me|account-id>, --set '<field>=<value>' (repeatable)
flags{edit}:
  --summary, --description[-file], --assignee <me|none|account-id>, --points <n|none>, --sprint <id|none>, --parent <KEY|none>, --labels <a,b> (replace), --add-label, --remove-label (repeatable), --priority <name>, --set '<field>=<value>' (repeatable)
flags{transition}:
  --resolution <name> (when the transition screen asks for one). No target = list available transitions
notes:
  link relations come from the site's link types, e.g. 'blocks', 'is blocked by', 'relates to', 'duplicates'
examples[6]:
  atl-axi issue view PROJ-123
  atl-axi issue edit PROJ-123 --points 3 --sprint 578
  atl-axi issue transition PROJ-123 'In Progress'
  atl-axi issue comment PROJ-123 --body "Fixed in the latest build"
  atl-axi issue link PROJ-1 blocks PROJ-2
  atl-axi issue create --project PROJ --type Task --summary "Retry the sync worker"
`;

const SUBCOMMANDS = ["view", "comments", "comment", "create", "edit", "transition", "link", "unlink"] as const;
const DESCRIPTION_LIMIT = 2_000;
const COMMENT_LIMIT = 1_500;
const BASE_FIELDS = ["summary", "status", "issuetype", "priority", "assignee", "parent", "labels", "updated"];

export async function issueCommand(args: string[]): Promise<string> {
  const [sub, ...rest] = args;
  switch (sub as (typeof SUBCOMMANDS)[number]) {
    case "view":
      return issueView(rest);
    case "comments":
      return issueComments(rest);
    case "comment":
      return issueComment(rest);
    case "create":
      return issueCreate(rest);
    case "edit":
      return issueEdit(rest);
    case "transition":
      return issueTransition(rest);
    case "link":
    case "unlink":
      return linkCommand(sub!, rest);
  }
  throw usageError(sub ? `unknown issue subcommand '${sub}'` : "missing issue subcommand", [
    `subcommands: ${SUBCOMMANDS.join(", ")}`,
    "Run `atl-axi issue --help` for flags",
  ]);
}

function pointsValue(issue: Obj, catalog: FieldDef[]): unknown {
  for (const f of pointsFields(catalog)) {
    const v = fields(issue)[f.id];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function sprintValue(issue: Obj, catalog: FieldDef[]): string {
  for (const f of sprintFields(catalog)) {
    const refs = sprintRefs(fields(issue)[f.id]);
    if (refs.length > 0) {
      const current = refs.filter((s) => s.state !== "closed");
      return (current.length > 0 ? current : refs.slice(-1)).map((s) => `${s.name} (${s.state}; id ${s.id})`).join("; ");
    }
  }
  return "none";
}

async function issueView(args: string[]): Promise<string> {
  const command = "atl-axi issue view";
  const parsed = parseArgs(args, [{ name: "--full", boolean: true }, { name: "--fields" }], command);
  const [raw] = expectPositionals(parsed, 1, `${command} <KEY> [--full] [--fields a,b]`);
  const key = issueKey(raw);
  const extraNames = (flag(parsed, "--fields") ?? "").split(",").map((f) => f.trim()).filter(Boolean);

  const catalog = await fieldCatalog();
  const extras = extraNames.map((name) => findField(catalog, name));
  const wanted = [
    ...BASE_FIELDS,
    "description",
    "issuelinks",
    "subtasks",
    "comment",
    ...pointsFields(catalog).map((f) => f.id),
    ...sprintFields(catalog).map((f) => f.id),
    ...extras.map((f) => f.id),
  ];
  const issue = await fetchIssue(key, [...new Set(wanted)]);
  const f = fields(issue);
  const parent = obj(f["parent"]);

  const summary: Obj = {
    key,
    summary: str(f["summary"]),
    type: str(obj(f["issuetype"])["name"]) || "unknown",
    status: statusName(issue),
    assignee: userName(f["assignee"]),
    priority: formatValue(f["priority"]),
    points: displayValue(pointsValue(issue, catalog)),
    sprint: sprintValue(issue, catalog),
    parent: str(parent["key"]) ? `${str(parent["key"])} ${str(dig(parent, "fields", "summary"))}`.trim() : "none",
    labels: formatValue(f["labels"]),
    updated: relTime(f["updated"]),
  };
  for (const extra of extras) summary[extra.name] = typeof f[extra.id] === "number" ? (f[extra.id] as number) : formatValue(f[extra.id], 500);

  const links = linkRows(issue);
  const subtasks = arr(f["subtasks"]).map((s) => ({
    key: str(obj(s)["key"]),
    status: str(dig(s, "fields", "status", "name")),
    summary: str(dig(s, "fields", "summary")),
  }));
  if (links.length > 0) summary["links"] = links;
  if (subtasks.length > 0) summary["subtasks"] = subtasks;
  const commentTotal = num(obj(f["comment"])["total"]) ?? arr(obj(f["comment"])["comments"]).length;
  summary["comments"] = commentTotal;

  const description = adfToText(f["description"]);
  const text = bool(parsed, "--full") ? { text: description, truncated: false } : truncate(description, DESCRIPTION_LIMIT);

  const help: string[] = [];
  if (text.truncated) help.push(`Run \`atl-axi issue view ${key} --full\` for the whole description`);
  if (commentTotal > 0) help.push(`Run \`atl-axi issue comments ${key}\` to read ${commentTotal === 1 ? "the comment" : `the ${commentTotal} comments`}`);
  help.push(`Run \`atl-axi issue transition ${key}\` to list status transitions`);

  return out(block({ issue: summary }), description ? "---" : "", description ? text.text : "", description ? "---" : "", helpBlock(help));
}

async function issueComments(args: string[]): Promise<string> {
  const command = "atl-axi issue comments";
  const parsed = parseArgs(args, [{ name: "--limit" }, { name: "--full", boolean: true }], command);
  const [raw] = expectPositionals(parsed, 1, `${command} <KEY> [--limit n] [--full]`);
  const key = issueKey(raw);
  const limit = intFlag(parsed, "--limit", 10, { min: 1, max: 100 });

  const page = obj(await jiraJson(`${issuePath(key)}/comment`, { query: { orderBy: "-created", maxResults: limit } }));
  const comments = arr(page["comments"]).map(obj).reverse();
  const total = num(page["total"]) ?? comments.length;
  if (comments.length === 0) {
    return out(block({ issue: key, comments: 0 }), helpBlock([`Run \`atl-axi issue comment ${key} --body "<text>"\` to add one`]));
  }

  const parts: string[] = [block({ issue: key, comments: total === comments.length ? total : `${comments.length} of ${total}` })];
  let truncated = false;
  for (const c of comments) {
    const body = adfToText(c["body"]);
    const text = bool(parsed, "--full") ? { text: body, truncated: false } : truncate(body, COMMENT_LIMIT);
    truncated ||= text.truncated;
    parts.push(`--- ${str(c["id"])} ${userName(c["author"])} ${relTime(c["created"])}`, text.text || "(empty)");
  }
  parts.push("---");
  const help: string[] = [];
  if (total > comments.length) help.push(`Run \`atl-axi issue comments ${key} --limit ${Math.min(100, total)}\` for older comments`);
  if (truncated) help.push(`Run \`atl-axi issue comments ${key} --full\` for whole comment bodies`);
  help.push(`Run \`atl-axi issue comment ${key} --body "<text>"\` to reply`);
  return out(...parts, helpBlock(help));
}

async function issueComment(args: string[]): Promise<string> {
  const command = "atl-axi issue comment";
  const usage = `${command} <KEY> --body "<text>" | --body-file <path|->`;
  const parsed = parseArgs(args, [{ name: "--body" }, { name: "--body-file" }], command);
  const [raw] = expectPositionals(parsed, 1, usage);
  const key = issueKey(raw);
  const text = readText(parsed, "--body", usage)?.trim();
  if (!text) throw usageError("comment body is required", [usage]);

  // Duplicate guard: an identical recent comment means a retried command.
  const recent = obj(await jiraJson(`${issuePath(key)}/comment`, { query: { orderBy: "-created", maxResults: 20 } }));
  const me = await currentUser().catch(() => undefined);
  const dup = arr(recent["comments"])
    .map(obj)
    .find((c) => adfToText(c["body"]).trim() === text && (!me || str(obj(c["author"])["accountId"]) === me.accountId));
  if (dup) return block({ issue: key, result: `identical comment ${str(dup["id"])} already posted (no-op)` });

  const created = obj(await jiraJson(`${issuePath(key)}/comment`, { method: "POST", body: { body: textToAdf(text) } }));
  return out(block({ issue: key, result: "commented", comment: Number(created["id"]) || str(created["id"]) }), helpBlock([`Run \`atl-axi issue comments ${key}\` to read the thread`]));
}

// --- edit / create -------------------------------------------------------------

async function resolveAssignee(raw: string): Promise<string | null> {
  const value = raw.trim();
  if (value.toLowerCase() === "none") return null;
  if (value.toLowerCase() === "me") {
    const me = await currentUser();
    if (!me) throw axiError("could not resolve your account id", "AUTH_REQUIRED", ["Pass --assignee <account-id> instead"]);
    return me.accountId;
  }
  if (/[:]/.test(value) || /^[0-9a-f]{24}$/i.test(value)) return value;
  const users = arr(await jiraJson("/rest/api/3/user/search", { query: { query: value, maxResults: 5 } })).map(obj);
  const active = users.filter((u) => u["active"] !== false && u["accountType"] === "atlassian");
  if (active.length === 1) return str(active[0]!["accountId"]);
  throw usageError(active.length === 0 ? `no user matches '${value}'` : `'${value}' matches ${active.length} users`, [
    ...active.map((u) => `${str(u["displayName"])} - ${str(u["accountId"])}`),
    "Pass --assignee <account-id> or me",
  ]);
}

interface FieldChange {
  field: FieldDef | { id: string; name: string };
  value: unknown;
  /** Display form for the result table. */
  shown: string | number;
}

function setPairs(parsed: ParsedArgs): Array<[string, string]> {
  return flags(parsed, "--set").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 1) throw usageError(`--set expects '<field>=<value>', got '${pair}'`);
    return [pair.slice(0, eq).trim(), pair.slice(eq + 1)];
  });
}

function parsePoints(raw: string): number | null {
  if (raw.trim().toLowerCase() === "none") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw usageError(`--points expects a number, got '${raw}'`);
  return n;
}

function parseSprint(raw: string): number | null {
  if (raw.trim().toLowerCase() === "none") return null;
  if (!/^\d+$/.test(raw.trim())) throw usageError(`--sprint expects a sprint id, got '${raw}'`, ["Run `atl-axi sprint list --project <KEY>` for ids"]);
  return Number(raw);
}

function pick(candidates: FieldDef[], screen: Obj, label: string, key: string, current: Obj = {}): FieldDef {
  const field = onScreen(candidates, screen, current);
  const holder = candidates.find((c) => current[c.id] !== null && current[c.id] !== undefined);
  // Never fill an empty parallel field while the value lives in one we cannot edit.
  if (field && holder && holder.id !== field.id) {
    throw axiError(`${holder.name} (${holder.id}) holds ${formatValue(current[holder.id])} on ${key} but is not on its edit screen`, "VALIDATION_ERROR", [
      `Writing ${field.name} (${field.id}) instead would leave two ${label} values; add ${holder.name} to the screen in Jira`,
      `Or write the other field deliberately: \`atl-axi issue edit ${key} --set '${field.name}=<value>'\``,
    ]);
  }
  if (!field) {
    throw axiError(`no ${label} field is on the screen for ${key}`, "VALIDATION_ERROR", [
      candidates.length > 0 ? `candidates: ${candidates.map((f) => `${f.name} (${f.id})`).join("; ")}` : `this site has no ${label} field`,
    ]);
  }
  return field;
}

const EDIT_FLAGS = [
  { name: "--summary" },
  { name: "--description" },
  { name: "--description-file" },
  { name: "--assignee" },
  { name: "--points" },
  { name: "--sprint" },
  { name: "--parent" },
  { name: "--labels" },
  { name: "--add-label", repeatable: true },
  { name: "--remove-label", repeatable: true },
  { name: "--priority" },
  { name: "--set", repeatable: true },
];

async function issueEdit(args: string[]): Promise<string> {
  const command = "atl-axi issue edit";
  const usage = `${command} <KEY> [--summary <text>] [--points <n>] [--sprint <id>] [--parent <KEY>] [--assignee <me|id>] [--set '<field>=<value>']`;
  const parsed = parseArgs(args, EDIT_FLAGS, command);
  const [raw] = expectPositionals(parsed, 1, usage);
  const key = issueKey(raw);

  // Validate every value before the first request.
  const summary = flag(parsed, "--summary");
  const description = readText(parsed, "--description", usage);
  const points = flag(parsed, "--points") === undefined ? undefined : parsePoints(flag(parsed, "--points")!);
  const sprint = flag(parsed, "--sprint") === undefined ? undefined : parseSprint(flag(parsed, "--sprint")!);
  const parentRaw = flag(parsed, "--parent");
  const parent = parentRaw === undefined ? undefined : parentRaw.toLowerCase() === "none" ? null : issueKey(parentRaw, "--parent");
  const labelsRaw = flag(parsed, "--labels");
  const addLabels = flags(parsed, "--add-label");
  const removeLabels = flags(parsed, "--remove-label");
  if (labelsRaw !== undefined && (addLabels.length > 0 || removeLabels.length > 0)) {
    throw usageError("--labels replaces all labels; do not combine it with --add-label/--remove-label");
  }
  for (const label of [...addLabels, ...(labelsRaw ?? "").split(",")]) {
    if (/\s/.test(label.trim())) throw usageError(`labels cannot contain spaces: '${label.trim()}'`);
  }
  const priority = flag(parsed, "--priority");
  const assigneeRaw = flag(parsed, "--assignee");
  const sets = setPairs(parsed);
  const nothing =
    [summary, description, points, sprint, parent, labelsRaw, priority, assigneeRaw].every((v) => v === undefined) &&
    addLabels.length + removeLabels.length + sets.length === 0;
  if (nothing) throw usageError("nothing to edit", [usage]);

  const catalog = await fieldCatalog();
  const setFields = sets.map(([name, value]) => [findField(catalog, name), value] as const);
  const [issue, meta] = await Promise.all([
    fetchIssue(key, [
      ...BASE_FIELDS,
      "description",
      ...pointsFields(catalog).map((f) => f.id),
      ...sprintFields(catalog).map((f) => f.id),
      ...setFields.map(([f]) => f.id),
    ]),
    jiraJson(`${issuePath(key)}/editmeta`),
  ]);
  const screen = obj(obj(meta)["fields"]);
  const f = fields(issue);
  const changes: FieldChange[] = [];
  const unchanged: string[] = [];
  const consider = (field: FieldChange["field"], value: unknown, same: boolean, shown: string | number): void => {
    if (same) unchanged.push(field.name);
    else changes.push({ field, value, shown });
  };

  if (summary !== undefined) consider({ id: "summary", name: "summary" }, summary, str(f["summary"]) === summary, summary);
  if (description !== undefined) {
    consider({ id: "description", name: "description" }, textToAdf(description), adfToText(f["description"]).trim() === description.trim(), `${description.trim().length} chars`);
  }
  if (points !== undefined) {
    const field = pick(pointsFields(catalog), screen, "story points", key, f);
    consider(field, points, (num(f[field.id]) ?? null) === points, points ?? "none");
  }
  if (sprint !== undefined) {
    const field = pick(sprintFields(catalog), screen, "sprint", key, f);
    const open = sprintRefs(f[field.id]).filter((s) => s.state !== "closed");
    const same = sprint === null ? open.length === 0 : open.some((s) => s.id === sprint);
    consider(field, sprint, same, sprint ?? "none");
  }
  if (parent !== undefined) {
    consider({ id: "parent", name: "parent" }, parent === null ? null : { key: parent }, (str(obj(f["parent"])["key"]) || null) === parent, parent ?? "none");
  }
  const currentLabels = arr(f["labels"]).map(str);
  if (labelsRaw !== undefined || addLabels.length > 0 || removeLabels.length > 0) {
    const base = labelsRaw !== undefined ? labelsRaw.split(",").map((l) => l.trim()).filter(Boolean) : currentLabels;
    const next = [...new Set([...base, ...addLabels])].filter((l) => !removeLabels.includes(l));
    const same = next.length === currentLabels.length && next.every((l) => currentLabels.includes(l));
    consider({ id: "labels", name: "labels" }, next, same, next.join("; ") || "none");
  }
  if (priority !== undefined) {
    consider({ id: "priority", name: "priority" }, { name: priority }, str(obj(f["priority"])["name"]).toLowerCase() === priority.toLowerCase(), priority);
  }
  for (const [field, value] of setFields) {
    if (!(field.id in screen)) throw axiError(`${field.name} (${field.id}) is not on the edit screen for ${key}`, "VALIDATION_ERROR");
    const coerced = coerceValue(field, value);
    consider(field, coerced, formatValue(f[field.id]) === formatValue(coerced), formatValue(coerced));
  }

  let assignee: string | null | undefined;
  if (assigneeRaw !== undefined) {
    assignee = await resolveAssignee(assigneeRaw);
    const current = str(obj(f["assignee"])["accountId"]) || null;
    if (current === assignee) unchanged.push("assignee");
  }
  const assigneeChanges = assignee !== undefined && !unchanged.includes("assignee");

  if (changes.length === 0 && !assigneeChanges) {
    return block({ issue: key, result: `already up to date (no-op)`, unchanged: unchanged.join("; ") });
  }
  if (changes.length > 0) {
    const payload: Obj = {};
    for (const c of changes) payload[c.field.id] = c.value;
    await jiraJson(issuePath(key), { method: "PUT", body: { fields: payload } });
  }
  if (assigneeChanges) await jiraJson(`${issuePath(key)}/assignee`, { method: "PUT", body: { accountId: assignee } });

  const rows: Array<{ field: string; value: string | number }> = changes.map((c) => ({ field: c.field.name, value: c.shown }));
  if (assigneeChanges) {
    const label = assigneeRaw!.trim().toLowerCase() === "me" ? ((await currentUser())?.displayName ?? "me") : assigneeRaw!.trim();
    rows.push({ field: "assignee", value: assignee === null ? "none" : label });
  }
  return out(
    block({ issue: key, result: "updated", changed: rows, ...(unchanged.length > 0 ? { unchanged: unchanged.join("; ") } : {}) }),
    helpBlock([`Run \`atl-axi issue view ${key}\` to confirm`]),
  );
}

async function issueCreate(args: string[]): Promise<string> {
  const command = "atl-axi issue create";
  const usage = `${command} --project <KEY> --type <name> --summary <text> [--description <text>] [--parent <KEY>] [--points <n>] [--sprint <id>]`;
  const parsed = parseArgs(
    args,
    [
      { name: "--project" },
      { name: "--type" },
      { name: "--summary" },
      { name: "--description" },
      { name: "--description-file" },
      { name: "--parent" },
      { name: "--points" },
      { name: "--sprint" },
      { name: "--labels" },
      { name: "--assignee" },
      { name: "--set", repeatable: true },
    ],
    command,
  );
  expectPositionals(parsed, 0, usage);
  const missing = ["--project", "--type", "--summary"].filter((n) => flag(parsed, n) === undefined);
  if (missing.length > 0) throw usageError(`missing ${missing.join(", ")}`, [usage]);
  const project = projectKey(flag(parsed, "--project"));
  const typeName = flag(parsed, "--type")!;
  const summary = flag(parsed, "--summary")!.trim();
  const description = readText(parsed, "--description", usage);
  const parent = flag(parsed, "--parent") === undefined ? undefined : issueKey(flag(parsed, "--parent"), "--parent");
  const points = flag(parsed, "--points") === undefined ? undefined : parsePoints(flag(parsed, "--points")!);
  const sprint = flag(parsed, "--sprint") === undefined ? undefined : parseSprint(flag(parsed, "--sprint")!);
  const labels = (flag(parsed, "--labels") ?? "").split(",").map((l) => l.trim()).filter(Boolean);
  const sets = setPairs(parsed);

  const types = arr(obj(await jiraJson(`/rest/api/3/issue/createmeta/${project}/issuetypes`, { query: { maxResults: 100 } }))["issueTypes"]).map(obj);
  const type = types.find((t) => str(t["name"]).toLowerCase() === typeName.toLowerCase());
  if (!type) {
    throw usageError(`unknown issue type '${typeName}' in ${project}`, [`types: ${types.map((t) => str(t["name"])).join(", ")}`]);
  }

  // Duplicate guard: same summary created in the last day means a retried command.
  const existing = await searchJql(`project = ${project} AND summary ~ ${jqlString(summary)} AND created >= -1d`, ["summary"], 20).catch(() => undefined);
  const dup = existing?.issues.find((i) => str(fields(i)["summary"]) === summary);
  if (dup) {
    return out(block({ issue: str(dup["key"]), result: "an issue with this summary was created in the last day (no-op)" }), helpBlock([`Run \`atl-axi issue view ${str(dup["key"])}\``]));
  }

  const payload: Obj = { project: { key: project }, issuetype: { id: str(type["id"]) }, summary };
  if (description) payload["description"] = textToAdf(description);
  if (parent) payload["parent"] = { key: parent };
  if (labels.length > 0) payload["labels"] = labels;
  if (flag(parsed, "--assignee") !== undefined) payload["assignee"] = { accountId: await resolveAssignee(flag(parsed, "--assignee")!) };

  if (points !== undefined || sprint !== undefined || sets.length > 0) {
    const catalog = await fieldCatalog();
    const createFields = arr(
      obj(await jiraJson(`/rest/api/3/issue/createmeta/${project}/issuetypes/${str(type["id"])}`, { query: { maxResults: 200 } }))["fields"],
    ).map(obj);
    const screen: Obj = Object.fromEntries(createFields.map((cf) => [str(cf["fieldId"]), true]));
    if (points !== undefined) payload[pick(pointsFields(catalog), screen, "story points", `${project} ${typeName}`).id] = points;
    if (sprint !== undefined) payload[pick(sprintFields(catalog), screen, "sprint", `${project} ${typeName}`).id] = sprint;
    for (const [name, value] of sets) {
      const field = findField(catalog, name);
      payload[field.id] = coerceValue(field, value);
    }
  }

  const created = obj(await jiraJson("/rest/api/3/issue", { method: "POST", body: { fields: payload } }));
  const key = str(created["key"]);
  return out(block({ issue: key, result: "created", type: str(type["name"]), summary }), helpBlock([`Run \`atl-axi issue view ${key}\``]));
}

// --- transitions ---------------------------------------------------------------

async function issueTransition(args: string[]): Promise<string> {
  const command = "atl-axi issue transition";
  const parsed = parseArgs(args, [{ name: "--resolution" }], command);
  if (parsed.positionals.length < 1 || parsed.positionals.length > 2) {
    expectPositionals(parsed, parsed.positionals.length < 1 ? 1 : 2, `${command} <KEY> [<status-or-transition>] [--resolution <name>]`);
  }
  const [raw, target] = parsed.positionals;
  const key = issueKey(raw);

  const [issue, page] = await Promise.all([fetchIssue(key, ["status"]), jiraJson(`${issuePath(key)}/transitions`)]);
  const transitions = arr(obj(page)["transitions"]).map((t) => ({
    id: Number(str(obj(t)["id"])) || str(obj(t)["id"]),
    name: str(obj(t)["name"]),
    to: str(dig(t, "to", "name")),
  }));
  const status = statusName(issue);

  if (target === undefined) {
    return out(
      block({ issue: key, status, transitions: transitions.length > 0 ? transitions : "none available" }),
      helpBlock(transitions.length > 0 ? [`Run \`atl-axi issue transition ${key} '<name>'\` to move it`] : []),
    );
  }

  const needle = target.trim().toLowerCase();
  if (status.toLowerCase() === needle) return block({ issue: key, result: `already in ${status} (no-op)` });
  const match =
    transitions.find((t) => t.name.toLowerCase() === needle) ??
    transitions.find((t) => t.to.toLowerCase() === needle) ??
    transitions.find((t) => String(t.id) === target.trim());
  if (!match) {
    throw usageError(`no transition '${target}' from ${status} for ${key}`, [
      `available: ${transitions.map((t) => `${t.name} -> ${t.to}`).join("; ") || "none"}`,
    ]);
  }
  const body: Obj = { transition: { id: String(match.id) } };
  const resolution = flag(parsed, "--resolution");
  if (resolution) body["fields"] = { resolution: { name: resolution } };
  await jiraJson(`${issuePath(key)}/transitions`, { method: "POST", body });
  return block({ issue: key, result: `moved ${status} -> ${match.to}`, transition: match.name });
}
