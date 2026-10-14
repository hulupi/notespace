import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "./database.mjs";
import { NoteResources } from "./resources.mjs";
import { openShareSecrets } from "./share-secrets.mjs";

const validUid = (uid) => typeof uid === "string" && /^(0|[1-9]\d{0,9})$/.test(uid);
const problem = (message, status) => Object.assign(Error(message), { status });
export const isPublicShareRoute = (route) => /^\/api\/public\/[a-f0-9]{48}(?:\/attachment)?$/.test(route);

export class Workspaces {
  constructor(root, gateway) {
    this.root = root;
    this.gateway = gateway;
    this.pending = new Map();
    this.opened = new Map();
  }
  async initialize() {
    if (!this.gateway) {
      await this.get("local");
      return;
    }
    await fs.mkdir(path.join(this.root, ".notespace"), { recursive: true });
    this.shares = new DatabaseSync(path.join(this.root, ".notespace", "share-index.sqlite"), { timeout: 5000 });
    this.shares.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS share_owners (token TEXT PRIMARY KEY, uid TEXT NOT NULL, expires INTEGER NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS share_owners_uid ON share_owners(uid);`);
  }
  index(uid, shares) {
    if (!this.gateway) return;
    this.shares.exec("BEGIN IMMEDIATE");
    try {
      this.shares.prepare("DELETE FROM share_owners WHERE uid=? OR (expires<>0 AND expires<=?)").run(uid, Date.now());
      const insert = this.shares.prepare("INSERT INTO share_owners(token,uid,expires) VALUES(?,?,?)");
      for (const share of shares) if (share.expires === 0 || share.expires > Date.now()) insert.run(share.token, uid, share.expires);
      this.shares.exec("COMMIT");
    } catch (error) {
      this.shares.exec("ROLLBACK");
      throw error;
    }
  }
  async get(uid) {
    if (this.gateway && !validUid(uid)) throw problem("飞牛用户身份无效", 401);
    if (this.pending.has(uid)) return this.pending.get(uid);
    const pending = this.open(uid).catch((error) => {
      this.pending.delete(uid);
      throw error;
    });
    this.pending.set(uid, pending);
    return pending;
  }
  async open(uid) {
    // Gateway users never see the unscoped development/legacy workspace.
    const root = this.gateway ? path.join(this.root, "users", uid) : this.root;
    const notes = path.join(root, "notes"), meta = path.join(root, ".notespace"),
      trash = path.join(root, "trash"), assets = path.join(root, "attachments");
    for (const folder of [notes, meta, trash, assets, path.join(root, "backups")])
      await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const database = await openDatabase(meta);
    try {
      const config = database.loadState();
      const shareSecrets = await openShareSecrets(meta);
      const save = async () => {
        database.saveState(config);
        this.index(uid, config.shares);
      };
      const resources = new NoteResources({ notes, trash, database, config, save });
      await resources.indexAll();
      this.index(uid, config.shares);
      const context = { uid, root, notes, meta, trash, assets, database, config, resources, save, shareSecrets };
      this.opened.set(uid, context);
      return context;
    } catch (error) {
      database.close();
      throw error;
    }
  }
  async forRequest(req, route) {
    if (!route.startsWith("/api/")) return {};
    if (!this.gateway) return this.get("local");
    if (isPublicShareRoute(route)) {
      const token = route.split("/")[3];
      const row = /^[a-f0-9]{48}$/.test(token || "") && this.shares.prepare(
        "SELECT uid FROM share_owners WHERE token=? AND (expires=0 OR expires>?)",
      ).get(token, Date.now());
      if (!row) throw problem("分享不存在或已过期", 404);
      return this.get(row.uid);
    }
    return this.get(this.requireUser(req));
  }
  requireUser(req) {
    if (!this.gateway) return "local";
    const uid = req.headers["x-trim-userid"];
    if (!validUid(uid)) throw problem("缺少有效的飞牛用户身份，请从飞牛桌面重新登录应用", 401);
    return uid;
  }
  close() {
    for (const context of this.opened.values()) context.database.close();
    if (this.shares?.isOpen) this.shares.close();
  }
}
