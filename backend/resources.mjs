import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomic, safePath, scan } from "./store.mjs";
import {
  canonicalNotePath,
  createAccess,
  validateResource,
  within,
} from "./access.mjs";

const problem = (message, status = 400) =>
  Object.assign(Error(message), { status });
const titleOf = (key) => key.split("/").at(-1).replace(/\.md$/i, "");
export class NoteResources {
  constructor({ notes, trash, database, config, save }) {
    Object.assign(this, { notes, trash, database, config, save });
  }
  access(token) {
    return createAccess(this.database, token);
  }
  async key(value, options) {
    return canonicalNotePath(this.notes, value, options);
  }
  async indexAll() {
    for (const entry of await scan(this.notes, "", {
      createdAt: (key, observed) => this.database.noteCreated(key, observed),
    }))
      if (entry.type === "note")
        this.database.indexReferences(entry.path, entry.content);
  }
  async state(token) {
    const access = this.access(token),
      entries = await scan(this.notes, "", {
        createdAt: (key, observed) => this.database.noteCreated(key, observed),
        describe: (key) => access.describe(key),
      }),
      visible = new Set(entries.map((entry) => entry.path));
    for (const entry of entries)
      if (entry.type === "note" && !entry.locked)
        this.database.indexReferences(entry.path, entry.content);
    return {
      entries,
      favorites: this.config.favorites.filter((key) => visible.has(key)),
      trash: this.config.trash.map((item) => ({
        ...item,
        resource: "@trash/" + item.id,
        ...access.describe("@trash/" + item.id, { tree: true }),
      })),
      attachments: this.config.attachments.filter((item) =>
        this.database
          .references(item.url, token)
          .some((resource) => access.canRead(resource)),
      ),
      shares: this.config.shares
        .filter((item) => !access.protected(item.path))
        .map(({ password, passwordSecret, ...share }) => ({ ...share, protected: !!password })),
    };
  }
  async check(raw, token, { tree = false, note = false } = {}) {
    const key = await this.key(raw, { root: true });
    this.access(token).require(key, { tree });
    const stat = await fs.stat(await safePath(this.notes, key));
    if (note && (!stat.isFile() || !key.endsWith(".md")))
      throw problem("无效笔记");
    return { key, stat };
  }
  async getNote(raw, token) {
    const { key, stat } = await this.check(raw, token, { note: true });
    return {
      path: key,
      type: "note",
      title: titleOf(key),
      content: await fs.readFile(await safePath(this.notes, key), "utf8"),
      modified: stat.mtimeMs,
      ...this.access(token).describe(key),
    };
  }
  async getTrash(id, token) {
    const item = this.config.trash.find((entry) => entry.id === id);
    if (!item) throw problem("回收记录不存在", 404);
    this.access(token).require("@trash/" + item.id, { tree: true });
    const target = await safePath(this.trash, item.id);
    const stat = await fs.stat(target);
    return {
      ...item,
      type: stat.isDirectory() ? "folder" : "note",
      content: stat.isDirectory() ? "" : await fs.readFile(target, "utf8"),
      entries: stat.isDirectory() ? (await scan(target)).map(({ content, ...entry }) => entry) : [],
    };
  }
  requireAttachment(url, token) {
    const references = this.database.references(url, token),
      access = this.access(token);
    if (references.some((resource) => access.canRead(resource))) return;
    if (!references.length) throw problem("附件没有可访问的笔记引用", 403);
    access.require(references[0]);
    throw problem("附件未授权", 403);
  }
  async moveMetadata(from, to) {
    this.database.moveResources(from, to);
    const change = (resource) =>
      within(resource, from) ? to + resource.slice(from.length) : resource;
    this.config.favorites = this.config.favorites.map(change);
    this.config.shares.forEach((share) => (share.path = change(share.path)));
    await this.save();
  }
  async writeNote(body, token) {
    if (typeof body.content !== "string") throw problem("无效笔记正文");
    const from = await this.key(body.path);
    if (!from.endsWith(".md")) throw problem("笔记必须使用 .md 扩展名");
    const access = this.access(token);
    access.require(from);
    let to = from;
    if (body.title !== undefined) {
      if (typeof body.title !== "string") throw problem("请输入标题");
      const name = body.title.trim().replace(/\.md$/i, "");
      if (!name || name.includes("/") || Buffer.byteLength(name + ".md") > 255)
        throw problem("标题不能为空或过长");
      validateResource(name);
      to = await this.key(
        (path.posix.dirname(from) === "."
          ? ""
          : path.posix.dirname(from) + "/") +
          name +
          ".md",
        { keepLeaf: true },
      );
      access.require(to);
    }
    const source = await safePath(this.notes, from),
      target = await safePath(this.notes, to);
    let old = null,
      previous;
    try {
      old = (await fs.stat(source)).mtimeMs;
      previous = await fs.readFile(source, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (body.modified !== old)
      throw problem("笔记已被其他窗口或外部程序修改，请重新加载", 409);
    if (to !== from) {
      try {
        const real = await fs.realpath(target);
        if (real !== (await fs.realpath(source)))
          throw problem("同名笔记已存在，标题尚未保存", 409);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (previous !== undefined && previous !== body.content)
      this.database.addVersion(from, previous);
    if (previous !== body.content) await atomic(source, body.content);
    if (to !== from) {
      await fs.rename(source, target);
      await this.moveMetadata(from, to);
    }
    if (old === null)
      this.database.addVersion(to, body.content, "初始内容", { force: true });
    this.database.indexReferences(to, body.content);
    return {
      path: to,
      title: titleOf(to),
      modified: (await fs.stat(target)).mtimeMs,
      ...this.access(token).describe(to),
    };
  }
  async move(body, token) {
    const from = await this.key(body.from),
      to = await this.key(body.to, { keepLeaf: true });
    if (!from || !to) throw problem("路径不能为空");
    if (within(to, from)) throw problem("不能移动到自身或子目录");
    if (from.endsWith(".md") && !to.endsWith(".md"))
      throw problem("笔记必须保留 .md 扩展名");
    const access = this.access(token);
    access.require(from, { tree: true });
    access.require(to);
    const source = await safePath(this.notes, from),
      target = await safePath(this.notes, to);
    try {
      await fs.access(target);
      throw problem("目标已存在", 409);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.rename(source, target);
    await this.moveMetadata(from, to);
  }
  async remove(raw, token) {
    const key = await this.key(raw);
    if (!key) throw problem("不能删除根目录");
    const access = this.access(token);
    access.require(key, { tree: true });
    const inherited =
      !this.database.getLock(key) && access.paths(key).length
        ? this.database.getLock(access.paths(key).at(-1))
        : null;
    const id = randomUUID();
    await fs.rename(await safePath(this.notes, key), path.join(this.trash, id));
    this.database.moveResources(key, "@trash/" + id);
    // Retain the parent password when a deleted child leaves its folder.
    if (inherited) {
      this.database.setLock("@trash/" + id, inherited.userId);
      this.database.unlock(token, "@trash/" + id);
    }
    this.config.trash.push({ id, path: key, deleted: Date.now() });
    this.config.favorites = this.config.favorites.filter(
      (item) => !within(item, key),
    );
    this.config.shares = this.config.shares.filter(
      (item) => !within(item.path, key),
    );
    await this.save();
  }
  async recycle(body, token, purge = false) {
    const item = this.config.trash.find((item) => item.id === body.id);
    if (!item) throw problem("回收记录不存在", 404);
    const resource = "@trash/" + item.id;
    this.access(token).require(resource, { tree: true });
    if (purge) {
      await fs.rm(path.join(this.trash, item.id), {
        recursive: true,
        force: true,
      });
      this.database.deleteResources(resource);
    } else {
      const targetKey = await this.key(item.path, { keepLeaf: true });
      this.access(token).require(targetKey);
      const target = await safePath(this.notes, targetKey);
      try {
        await fs.access(target);
        throw problem("原路径已存在，请先移动同名内容", 409);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(path.join(this.trash, item.id), target);
      this.database.moveResources(resource, targetKey);
    }
    this.config.trash = this.config.trash.filter(
      (entry) => entry.id !== item.id,
    );
    await this.save();
  }
  async versions(raw, token) {
    const { key } = await this.check(raw, token, { note: true });
    return this.database.versions(key);
  }
  async version(raw, id, token) {
    const { key } = await this.check(raw, token, { note: true });
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1)
      throw problem("无效版本");
    const version = this.database.version(key, Number(id));
    if (!version) throw problem("版本不存在或已清理", 404);
    return version;
  }
  async snapshot(body, token) {
    const note = await this.getNote(body.path, token);
    if (body.modified !== note.modified)
      throw problem("笔记已更新，请刷新后再创建快照", 409);
    this.database.addVersion(note.path, note.content, "手动快照", {
      force: true,
    });
    this.database.indexReferences(note.path, note.content);
  }
  async restore(body, token) {
    const version = await this.version(body.path, body.id, token),
      current = await this.getNote(body.path, token);
    if (body.modified !== current.modified)
      throw problem("笔记已更新，请重新加载后再恢复", 409);
    this.database.addVersion(current.path, current.content, "恢复前", {
      force: true,
    });
    return this.writeNote(
      {
        path: current.path,
        content: version.content,
        modified: current.modified,
      },
      token,
    );
  }
}
