import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
export async function atomic(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + "." + randomUUID() + ".tmp";
  try {
    await fs.writeFile(tmp, content);
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
export async function safePath(root, relative = "") {
  if (
    typeof relative !== "string" ||
    relative.includes("\\") ||
    relative
      .split("/")
      .some((s) => s === ".." || s === "." || s.startsWith(".")) ||
    relative.includes("\0") ||
    path.isAbsolute(relative)
  )
    throw Error("无效路径");
  const base = await fs.realpath(root),
    target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep))
    throw Error("无效路径");
  let cursor = base;
  for (const part of relative.split("/").filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw Error("不允许符号链接");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return target;
}
export async function scan(root, dir = "", options = {}) {
  const result = [];
  for (const entry of await fs.readdir(await safePath(root, dir), {
    withFileTypes: true,
  })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const key = dir ? dir + "/" + entry.name : entry.name;
    const access = options.describe?.(key) || {};
    if (entry.isDirectory()) {
      result.push({ path: key, type: "folder", ...access });
      if (!access.locked) result.push(...(await scan(root, key, options)));
    } else if (entry.name.endsWith(".md")) {
      const file = await safePath(root, key),
        stat = await fs.stat(file);
      result.push({
        path: key,
        type: "note",
        modified: stat.mtimeMs,
        created: options.createdAt?.(key, stat.birthtimeMs || stat.ctimeMs) ?? (stat.birthtimeMs || stat.ctimeMs),
        size: stat.size,
        ...access,
        ...(!access.locked ? { content: await fs.readFile(file, "utf8") } : {}),
      });
    }
  }
  return result;
}
