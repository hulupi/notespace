import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseSfc } from "@vue/compiler-sfc";
import { parse as parseTemplate } from "@vue/compiler-dom";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = path.join(root, "frontend", "src");
const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const inlineTags = new Set(["span", "i", "b", "em", "strong", "small", "code", "kbd", "a", "time", "p", "el-icon", "el-tag","el-button","button"]);

function meaningfulChildren(node) {
  return node.children.filter((child) => child.type !== 2 || child.loc.source.trim());
}

function canInline(node) {
  if (node.type === 2) return true;
  if (node.type === 5) return !node.loc.source.includes("\n") || !/`|\/\/|\/\*|\\\r?\n/.test(node.content.content);
  if (node.type !== 1) return false;
  if (node.isSelfClosing || voidTags.has(node.tag)) return true;
  const children = meaningfulChildren(node);
  if (!children.every(canInline)) return false;
  if (node.tag === "template") return !node.props.some((prop) => prop.type === 7 && prop.name === "slot");
  if (inlineTags.has(node.tag)) return true;
  const storageStatus = node.tag === "div" && node.props.some((prop) => prop.name === "class" && prop.value?.content.split(/\s+/).includes("storage-status"));
  return storageStatus || children.length > 0 && children.every((child) => child.type === 2 || child.type === 5);
}

function inline(node) {
  if (node.type !== 1) return node.loc.source.trim().replace(/\s*\r?\n\s*/g, " ");
  const attributes = node.props.map(attribute).join(" ");
  const start = `<${node.tag}${attributes ? " " + attributes : ""}`;
  if (node.isSelfClosing || voidTags.has(node.tag)) return start + " />";
  return start + ">" + meaningfulChildren(node).map(inline).join(" ") + `</${node.tag}>`;
}

function attribute(prop) {
  const source = prop.loc.source;
  // Flatten ordinary multiline binding expressions without touching literal
  // multiline values, template strings, comments or escaped line continuations.
  if (prop.type === 7 && !/`|\/\/|\/\*|\\\r?\n/.test(prop.exp?.content || ""))
    return source.replace(/\s*\r?\n\s*/g, " ");
  return source;
}

function render(node, depth = 0) {
  const indent = "\t".repeat(depth);
  if (node.type === 1) {
    const attributes = node.props.map(attribute).join(" ");
    const start = `<${node.tag}${attributes ? " " + attributes : ""}`;
    if (node.isSelfClosing || voidTags.has(node.tag)) return [indent + start + " />"];
    const children = meaningfulChildren(node);
    const end = `</${node.tag}>`;
    if (canInline(node)) {
      const line = inline(node);
      if (!line.includes("\n") && line.length <= 600) return [indent + line];
    }
    return [indent + start + ">", ...children.flatMap((child) => render(child, depth + 1)), indent + end];
  }
  const source = node.loc.source.trim();
  return source ? source.split(/\r?\n/).map((line) => indent + line.trim()) : [];
}

async function format(file) {
  const source = await fs.readFile(file, "utf8");
  const { descriptor, errors } = parseSfc(source, { filename: file });
  if (errors.length) throw errors[0];
  const block = descriptor.template;
  if (!block || block.lang && block.lang !== "html") return;
  const template = parseTemplate(block.content, { comments: true });
  const body = "\n" + template.children.flatMap((node) => render(node, 1)).join("\n") + "\n";
  const formatted = source.slice(0, block.loc.start.offset) + body + source.slice(block.loc.end.offset);
  if (formatted !== source) {
    await fs.writeFile(file, formatted);
    process.stdout.write(`已整理模板：${path.relative(root, file)}\n`);
  }
}

async function visit(folder) {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) await visit(file);
    else if (entry.name.endsWith(".vue")) await format(file);
  }
}
await visit(directory);
