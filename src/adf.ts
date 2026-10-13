import { arr, num, obj, str, type Obj } from "./render.js";

// Atlassian Document Format <-> plain text. Lossy by design: agents read and
// write text, Jira stores ADF.

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
          if (arr(node["marks"]).map(obj).some((m) => m["type"] === "code")) return `\`${text}\``;
          return href && href !== text ? `${text} (${href})` : text;
        }
        case "hardBreak":
          return "\n";
        case "mention":
          return str(attrs["text"]) || "@user";
        case "emoji":
          return str(attrs["text"]) || str(attrs["shortName"]);
        case "inlineCard":
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

const URL_RE = /(https?:\/\/[^\s)]+)/g;

function textNodes(line: string): Obj[] {
  const nodes: Obj[] = [];
  // Split on inline code first, then linkify plain segments.
  line.split(/(`[^`]+`)/).forEach((segment) => {
    if (segment === "") return;
    if (/^`[^`]+`$/.test(segment)) {
      nodes.push({ type: "text", text: segment.slice(1, -1), marks: [{ type: "code" }] });
      return;
    }
    segment.split(URL_RE).forEach((part, i) => {
      if (part === "") return;
      nodes.push(i % 2 === 1 ? { type: "text", text: part, marks: [{ type: "link", attrs: { href: part } }] } : { type: "text", text: part });
    });
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

function list(lines: string[], ordered: boolean): Obj {
  return {
    type: ordered ? "orderedList" : "bulletList",
    content: lines.map((line) => ({
      type: "listItem",
      content: [paragraph([line.replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*]\s+/, "")])],
    })),
  };
}

/** Plain text (blank-line paragraphs, `- ` lists, `#` headings, fenced code) to ADF. */
export function textToAdf(text: string): Obj {
  const content: Obj[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    if (buffer.every((l) => /^\s*[-*]\s+/.test(l))) content.push(list(buffer, false));
    else if (buffer.every((l) => /^\s*\d+[.)]\s+/.test(l))) content.push(list(buffer, true));
    else if (buffer.length === 1 && /^#{1,6}\s/.test(buffer[0]!)) {
      const level = buffer[0]!.match(/^#+/)![0].length;
      content.push({ type: "heading", attrs: { level }, content: textNodes(buffer[0]!.replace(/^#+\s+/, "")) });
    } else content.push(paragraph(buffer));
    buffer = [];
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
      continue;
    }
    if (line.trim() === "") flush();
    else buffer.push(line);
  }
  flush();
  return { type: "doc", version: 1, content };
}
