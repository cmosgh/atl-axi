import { arr, num, obj, str, type Obj } from "./render.js";

// Atlassian Document Format <-> Markdown-style text. Headings, lists (nested),
// code, quotes, rules, bold and links round-trip; other nodes are rendered lossily.

function inline(nodes: unknown[]): string {
  return nodes
    .map((raw) => {
      const node = obj(raw);
      const attrs = obj(node["attrs"]);
      switch (str(node["type"])) {
        case "text": {
          const text = str(node["text"]);
          const link = arr(node["marks"]).map(obj).find((m) => m["type"] === "link");
          const href = str(obj(link?.["attrs"])["href"]);
          const marks = arr(node["marks"]).map(obj);
          if (marks.some((m) => m["type"] === "code")) return `\`${text}\``;
          const shown = marks.some((m) => m["type"] === "strong") ? `**${text}**` : text;
          return href && href !== text ? `[${shown}](${href})` : shown;
        }
        case "hardBreak":
          return "\n";
        case "mention":
          return str(attrs["text"]) || "@user";
        case "emoji":
          return str(attrs["text"]) || str(attrs["shortName"]);
        case "inlineCard":
          return `<${str(attrs["url"])}>`;
        case "blockCard":
          return str(attrs["url"]);
        case "status":
          return `[${str(attrs["text"])}]`;
        case "date": {
          const ts = Number(str(attrs["timestamp"]) || num(attrs["timestamp"]));
          return Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString().slice(0, 10) : "";
        }
        default:
          return inline(arr(node["content"]));
      }
    })
    .join("");
}

function indent(text: string, prefix: string, rest: string): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 ? prefix : rest) + line)
    .join("\n");
}

function block(raw: unknown): string {
  const node = obj(raw);
  const attrs = obj(node["attrs"]);
  const content = arr(node["content"]);
  switch (str(node["type"])) {
    case "paragraph":
      return inline(content);
    case "heading":
      return `${"#".repeat(num(attrs["level"]) ?? 1)} ${inline(content)}`;
    case "bulletList":
      return content.map((item) => indent(blocks(arr(obj(item)["content"]), "\n"), "- ", "  ")).join("\n");
    case "orderedList": {
      const start = num(attrs["order"]) ?? 1;
      return content
        .map((item, i) => {
          const marker = `${start + i}. `;
          return indent(blocks(arr(obj(item)["content"]), "\n"), marker, " ".repeat(marker.length));
        })
        .join("\n");
    }
    case "taskList":
      return content
        .map((item) => indent(inline(arr(obj(item)["content"])), obj(item)["attrs"] && obj(obj(item)["attrs"])["state"] === "DONE" ? "[x] " : "[ ] ", "    "))
        .join("\n");
    case "codeBlock":
      return `\`\`\`${str(attrs["language"])}\n${inline(content)}\n\`\`\``;
    case "blockquote":
      return indent(blocks(content), "> ", "> ");
    case "rule":
      return "----";
    case "table":
      return content
        .map((row) => `| ${arr(obj(row)["content"]).map((cell) => blocks(arr(obj(cell)["content"]), " ").replace(/\n/g, " ")).join(" | ")} |`)
        .join("\n");
    case "mediaSingle":
    case "mediaGroup":
    case "media":
      return "[attachment]";
    case "expand":
    case "nestedExpand":
      return [str(attrs["title"]) ? `${str(attrs["title"])}:` : "", blocks(content)].filter(Boolean).join("\n");
    default:
      return content.length > 0 ? blocks(content) : inline([node]);
  }
}

function blocks(nodes: unknown[], separator = "\n\n"): string {
  return nodes.map(block).filter((b) => b !== "").join(separator);
}

/** Render an ADF document (or a legacy plain string) as text. */
export function adfToText(doc: unknown): string {
  if (typeof doc === "string") return doc;
  return blocks(arr(obj(doc)["content"])).trim();
}

// Inline tokens: `code`, <url> (smart link), [text](url), **bold**, bare URLs.
const INLINE_RE = /(`[^`]+`|<https?:\/\/[^\s>]+>|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*\n]+\*\*|https?:\/\/[^\s)]+)/g;

function textNodes(line: string): Obj[] {
  const nodes: Obj[] = [];
  line.split(INLINE_RE).forEach((part, i) => {
    if (part === "") return;
    if (i % 2 === 0) nodes.push({ type: "text", text: part });
    else if (part.startsWith("`")) nodes.push({ type: "text", text: part.slice(1, -1), marks: [{ type: "code" }] });
    else if (part.startsWith("<")) nodes.push({ type: "inlineCard", attrs: { url: part.slice(1, -1) } });
    else if (part.startsWith("**")) nodes.push(...textNodes(part.slice(2, -2)).map((n) => ({ ...n, marks: [...arr(n["marks"]), { type: "strong" }] })));
    else if (part.startsWith("[")) {
      const m = part.match(/^\[(.+)\]\((.+)\)$/)!;
      const link = { type: "link", attrs: { href: m[2] } };
      nodes.push(...textNodes(m[1]!).map((n) => ({ ...n, marks: [...arr(n["marks"]), link] })));
    } else nodes.push({ type: "text", text: part, marks: [{ type: "link", attrs: { href: part } }] });
  });
  return nodes;
}

function paragraph(lines: string[]): Obj {
  const content: Obj[] = [];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: "hardBreak" });
    content.push(...textNodes(line));
  });
  return { type: "paragraph", content };
}

const BULLET = /^(\s*)[-*]\s+/;
const ORDERED = /^(\s*)(\d+)[.)]\s+/;
const width = (line: string): number => line.length - line.trimStart().length;

/** A run of list lines; deeper-indented lines nest under the previous item. */
function list(lines: string[]): Obj {
  const ordered = ORDERED.test(lines[0]!);
  const base = width(lines[0]!);
  const items: Array<{ first: string; rest: string[] }> = [];
  for (const line of lines) {
    if (width(line) <= base && (BULLET.test(line) || ORDERED.test(line))) items.push({ first: line.replace(ordered ? ORDERED : BULLET, ""), rest: [] });
    else items[items.length - 1]!.rest.push(line);
  }
  const start = ordered ? Number(lines[0]!.match(ORDERED)![2]) : 1;
  return {
    type: ordered ? "orderedList" : "bulletList",
    ...(ordered && start !== 1 ? { attrs: { order: start } } : {}),
    content: items.map((item) => {
      const nested = item.rest.length > 0 ? arr(textToAdf(dedent(item.rest)).content) : [];
      return { type: "listItem", content: [paragraph([item.first]), ...nested] };
    }),
  };
}

function dedent(lines: string[]): string {
  const cut = Math.min(...lines.filter((l) => l.trim() !== "").map(width));
  return lines.map((l) => l.slice(cut)).join("\n");
}

/** Markdown-style text (paragraphs, #-headings, nested -/1. lists, fences, > quotes, ----) to ADF. */
export function textToAdf(text: string): Obj & { content: Obj[] } {
  const content: Obj[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) content.push(paragraph(para));
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(/^```(\S*)\s*$/);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]!); i++) code.push(lines[i]!);
      content.push({
        type: "codeBlock",
        ...(fence[1] ? { attrs: { language: fence[1] } } : {}),
        content: code.length > 0 ? [{ type: "text", text: code.join("\n") }] : [],
      });
    } else if (line.trim() === "") {
      flush();
    } else if (/^#{1,6}\s/.test(line)) {
      flush();
      content.push({ type: "heading", attrs: { level: line.match(/^#+/)![0].length }, content: textNodes(line.replace(/^#+\s+/, "")) });
    } else if (/^-{3,}\s*$/.test(line)) {
      flush();
      content.push({ type: "rule" });
    } else if (/^>\s?/.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]!); i++) quoted.push(lines[i]!.replace(/^>\s?/, ""));
      i--;
      content.push({ type: "blockquote", content: textToAdf(quoted.join("\n")).content });
    } else if (BULLET.test(line) || ORDERED.test(line)) {
      flush();
      const run = [line];
      // Continue while lines are list items or indented continuations.
      for (i++; i < lines.length && lines[i]!.trim() !== "" && (BULLET.test(lines[i]!) || ORDERED.test(lines[i]!) || width(lines[i]!) > width(line)); i++) {
        const same = ORDERED.test(line) ? ORDERED.test(lines[i]!) : BULLET.test(lines[i]!);
        if (width(lines[i]!) <= width(line) && !same) break;
        run.push(lines[i]!);
      }
      i--;
      content.push(list(run));
    } else {
      para.push(line);
    }
  }
  flush();
  return { type: "doc", version: 1, content };
}
