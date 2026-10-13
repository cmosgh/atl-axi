import { expectPositionals, parseArgs } from "../args.js";
import { jiraJson } from "../client.js";
import { axiError, usageError } from "../errors.js";
import { fetchIssue, fields, issueKey } from "../issue-api.js";
import { arr, block, dig, helpBlock, obj, out, str, type Obj } from "../render.js";

interface LinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

export interface LinkRow {
  relation: string;
  key: string;
  status: string;
  summary: string;
}

/** Issue links as read from the issue: `outwardIssue` = this issue <outward> it. */
export function linkRows(issue: Obj): LinkRow[] {
  return arr(fields(issue)["issuelinks"]).map((raw) => {
    const link = obj(raw);
    const outward = obj(link["outwardIssue"]);
    const other = str(outward["key"]) ? outward : obj(link["inwardIssue"]);
    return {
      relation: str(dig(link, "type", str(outward["key"]) ? "outward" : "inward")) || "relates to",
      key: str(other["key"]),
      status: str(dig(other, "fields", "status", "name")),
      summary: str(dig(other, "fields", "summary")),
    };
  });
}

async function linkTypes(): Promise<LinkType[]> {
  return arr(obj(await jiraJson("/rest/api/3/issueLinkType"))["issueLinkTypes"]).map((raw) => {
    const t = obj(raw);
    return { id: str(t["id"]), name: str(t["name"]), inward: str(t["inward"]), outward: str(t["outward"]) };
  });
}

/**
 * Resolve `A <relation> B` into Jira's POST shape. Jira stores
 * `{inwardIssue: X, outwardIssue: Y}` as "X <outward> Y" (X blocks Y), which
 * is the reverse of what the field names suggest.
 */
export function resolveRelation(types: LinkType[], relation: string, a: string, b: string): { type: LinkType; inwardIssue: string; outwardIssue: string; phrase: string } {
  const needle = relation.trim().toLowerCase().replace(/[-_]/g, " ");
  for (const type of types) {
    if (type.outward.toLowerCase() === needle || type.name.toLowerCase() === needle) {
      return { type, inwardIssue: a, outwardIssue: b, phrase: type.outward };
    }
  }
  for (const type of types) {
    if (type.inward.toLowerCase() === needle) return { type, inwardIssue: b, outwardIssue: a, phrase: type.inward };
  }
  const phrases = [...new Set(types.flatMap((t) => [t.outward, t.inward]))];
  throw usageError(`unknown link relation '${relation}'`, [`relations: ${phrases.map((p) => `'${p}'`).join(", ")}`]);
}

/** Find the existing link on `a` that reads "a <phrase> b". */
function findLink(issue: Obj, typeName: string, phrase: string, b: string): Obj | undefined {
  return arr(fields(issue)["issuelinks"])
    .map(obj)
    .find((link) => {
      if (str(dig(link, "type", "name")) !== typeName) return false;
      const outward = str(dig(link, "outwardIssue", "key"));
      const inward = str(dig(link, "inwardIssue", "key"));
      if (outward === b) return str(dig(link, "type", "outward")) === phrase;
      if (inward === b) return str(dig(link, "type", "inward")) === phrase;
      return false;
    });
}

export async function linkCommand(sub: string, args: string[]): Promise<string> {
  const command = `atl-axi issue ${sub}`;
  const parsed = parseArgs(args, [], command);
  const [rawA, relation, rawB] = expectPositionals(parsed, 3, `${command} <KEY> <relation> <KEY> (quote multi-word relations: 'is blocked by')`);
  const a = issueKey(rawA);
  const b = issueKey(rawB);
  if (a === b) throw usageError("an issue cannot be linked to itself");

  const [types, issue] = await Promise.all([linkTypes(), fetchIssue(a, ["issuelinks"])]);
  const resolved = resolveRelation(types, relation!, a, b);
  const existing = findLink(issue, resolved.type.name, resolved.phrase, b);
  const sentence = `${a} ${resolved.phrase} ${b}`;

  if (sub === "unlink") {
    if (!existing) return block({ link: sentence, result: "no such link (no-op)" });
    await jiraJson(`/rest/api/3/issueLink/${encodeURIComponent(str(existing["id"]))}`, { method: "DELETE" });
    return block({ link: sentence, result: "removed" });
  }

  if (existing) return block({ link: sentence, result: "already linked (no-op)" });
  await jiraJson("/rest/api/3/issueLink", {
    method: "POST",
    body: {
      type: { name: resolved.type.name },
      inwardIssue: { key: resolved.inwardIssue },
      outwardIssue: { key: resolved.outwardIssue },
    },
  });

  // Read back: a reversed link is the classic failure mode here.
  const after = await fetchIssue(a, ["issuelinks"]);
  if (!findLink(after, resolved.type.name, resolved.phrase, b)) {
    throw axiError(`link created but ${a} does not read '${resolved.phrase} ${b}' - check it`, "API_ERROR", [
      `Run \`atl-axi issue view ${a}\` to inspect its links`,
    ]);
  }
  return out(block({ link: sentence, result: "linked" }), helpBlock([`Run \`atl-axi issue view ${a}\` to see all its links`]));
}
