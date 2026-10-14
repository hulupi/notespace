import fs from "node:fs/promises";
import path from "node:path";
import { safePath } from "./store.mjs";

const key = (value) =>
  process.platform === "linux" ? value : value.toLowerCase();
export const within = (resource, parent) =>
  !parent ||
  key(resource) === key(parent) ||
  key(resource).startsWith(key(parent) + "/");
export function validateResource(
  value,
  { root = false, internal = false } = {},
) {
  if (
    typeof value !== "string" ||
    (!value && !root) ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value
      .split("/")
      .some(
        (part) =>
          part === "." ||
          part === ".." ||
          part.startsWith(".") ||
          part.trim() !== part ||
          part.endsWith(".") ||
          (!part && value) ||
          /[\\:*?"<>|\x00-\x1f]/.test(part),
      ) ||
    (!internal && value.split("/")[0] === "@trash")
  )
    throw Error("无效路径");
  return value;
}
export async function canonicalNotePath(
  notes,
  raw,
  { root = false, keepLeaf = false } = {},
) {
  validateResource(raw, { root });
  const base = await fs.realpath(notes),
    target = await safePath(notes, raw);
  let cursor = keepLeaf ? path.dirname(target) : target,
    tail = keepLeaf ? [path.basename(target)] : [];
  while (true) {
    try {
      const real = await fs.realpath(cursor);
      const relative = path.relative(base, real);
      if (relative === ".." || relative.startsWith(".." + path.sep))
        throw Error("无效路径");
      return [...relative.split(path.sep).filter(Boolean), ...tail].join("/");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      tail.unshift(path.basename(cursor));
      cursor = path.dirname(cursor);
    }
  }
}
export function createAccess(database, token) {
  const locks = database.listLocks(),
    grants = new Set(database.grantedLocks(token));
  const affecting = (resource) =>
    locks
      .filter((lock) => within(resource, lock.path))
      .sort((a, b) => a.path.length - b.path.length);
  const missing = (resource, tree = false) =>
    locks
      .filter(
        (lock) =>
          (within(resource, lock.path) ||
            (tree && within(lock.path, resource))) &&
          !grants.has(lock.path),
      )
      .sort((a, b) => a.path.length - b.path.length);
  const requireAccess = (
    resource,
    { tree = false, excludeExact = false } = {},
  ) => {
    const lock = missing(resource, tree).find(
      (lock) => !excludeExact || key(lock.path) !== key(resource),
    );
    if (lock)
      throw Object.assign(Error("请输入访问密码解锁内容"), {
        status: 423,
        code: "LOCKED",
        lockPath: lock.path,
      });
  };
  return {
    require: requireAccess,
    canRead: (resource) => missing(resource).length === 0,
    protected: (resource) => affecting(resource).length > 0,
    paths: (resource) => affecting(resource).map((lock) => lock.path),
    describe(resource, { tree = false } = {}) {
      const affected = affecting(resource),
        blocked = missing(resource, tree);
      return {
        protected:
          affected.length > 0 ||
          (tree && locks.some((lock) => within(lock.path, resource))),
        locked: blocked.length > 0,
        ownLock: locks.some((lock) => key(lock.path) === key(resource)),
        lockPath: blocked[0]?.path || affected.at(-1)?.path || null,
      };
    },
  };
}
