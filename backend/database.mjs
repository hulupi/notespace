import { DatabaseSync, backup } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { within } from "./access.mjs";

const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
const passwordFrom = (row) =>
  row?.password_hash
    ? { salt: row.password_salt, hash: row.password_hash }
    : undefined;
export class NoteDatabase {
  constructor(file) {
    this.file = file;
    this.connection = new DatabaseSync(file, { timeout: 5000 });
    this.connection
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created INTEGER NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL) STRICT;
   CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
   CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, path TEXT NOT NULL, expires INTEGER NOT NULL, password_salt TEXT, password_hash TEXT) STRICT;
   CREATE INDEX IF NOT EXISTS shares_expiry ON shares(expires);
   CREATE TABLE IF NOT EXISTS note_share_ids (path TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE) STRICT;
   CREATE TABLE IF NOT EXISTS note_metadata (path TEXT PRIMARY KEY, created INTEGER NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS favorites (path TEXT PRIMARY KEY) STRICT;
   CREATE TABLE IF NOT EXISTS trash (id TEXT PRIMARY KEY, path TEXT NOT NULL, deleted INTEGER NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS attachments (url TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS note_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, content TEXT NOT NULL, created INTEGER NOT NULL, reason TEXT NOT NULL) STRICT;
   CREATE INDEX IF NOT EXISTS versions_path ON note_versions(path,id DESC);
   CREATE TABLE IF NOT EXISTS attachment_refs (url TEXT NOT NULL, resource TEXT NOT NULL, PRIMARY KEY(url,resource)) STRICT;
   CREATE TABLE IF NOT EXISTS upload_owners (url TEXT PRIMARY KEY, token_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE, resource TEXT NOT NULL, expires INTEGER NOT NULL) STRICT;
   CREATE TABLE IF NOT EXISTS access_passwords (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL) STRICT;`);
    if (!this.connection.prepare("PRAGMA table_info(shares)").all().some((column) => column.name === "password_secret"))
      this.connection.exec("ALTER TABLE shares ADD COLUMN password_secret TEXT");
    // Preserve the first existing link for each note when introducing stable IDs.
    this.connection.exec(`INSERT OR IGNORE INTO note_share_ids(path,token)
      SELECT s.path,s.token FROM shares s
      WHERE s.rowid=(SELECT MIN(other.rowid) FROM shares other WHERE other.path=s.path)`);
    // Replace per-resource secrets with account-owned lock flags; preserve only paths.
    if (
      this.connection
        .prepare("PRAGMA table_info(locks)")
        .all()
        .some((column) => column.name === "password_hash")
    ) {
      this.transaction(() =>
        this.connection.exec(`DROP TABLE IF EXISTS lock_grants;
        ALTER TABLE locks RENAME TO old_resource_locks;
        CREATE TABLE locks (path TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE) STRICT;
        INSERT INTO locks SELECT path,1 FROM old_resource_locks WHERE EXISTS(SELECT 1 FROM users WHERE id=1);
        DROP TABLE old_resource_locks;`),
      );
    }
    this.connection
      .exec(`CREATE TABLE IF NOT EXISTS locks (path TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE) STRICT;
      CREATE TABLE IF NOT EXISTS lock_grants (token_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE, path TEXT NOT NULL REFERENCES locks(path) ON UPDATE CASCADE ON DELETE CASCADE, expires INTEGER NOT NULL, PRIMARY KEY(token_hash,path)) STRICT;
      PRAGMA user_version=3;`);
  }
  transaction(fn) {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.connection.exec("COMMIT");
      return value;
    } catch (error) {
      this.connection.exec("ROLLBACK");
      throw error;
    }
  }
  getUser(username) {
    const row =
      username === undefined
        ? this.connection.prepare("SELECT * FROM users WHERE id=1").get()
        : this.connection
            .prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE")
            .get(username);
    return row
      ? { id: row.id, username: row.username, password: passwordFrom(row) }
      : null;
  }
  createUser(username, password) {
    this.connection
      .prepare(
        "INSERT INTO users (id,username,password_salt,password_hash,created) VALUES (1,?,?,?,?)",
      )
      .run(username, password.salt, password.hash, Date.now());
  }
  changePassword(password) {
    this.transaction(() => {
      this.connection
        .prepare("UPDATE users SET password_salt=?,password_hash=? WHERE id=1")
        .run(password.salt, password.hash);
      this.connection.exec("DELETE FROM sessions");
    });
  }
  createSession(token, expires) {
    this.connection
      .prepare("DELETE FROM sessions WHERE expires<=?")
      .run(Date.now());
    this.connection
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,expires) VALUES (?,1,?)",
      )
      .run(tokenHash(token), expires);
  }
  session(token) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
    return (
      this.connection
        .prepare(
          "SELECT u.username,u.id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?",
        )
        .get(tokenHash(token), Date.now()) || null
    );
  }
  revokeSession(token) {
    this.connection
      .prepare("DELETE FROM sessions WHERE token_hash=?")
      .run(tokenHash(token));
  }
  noteCreated(path, observed) {
    const row = this.connection.prepare("SELECT created FROM note_metadata WHERE path=?").get(path);
    if (row) return row.created;
    const created = Math.trunc(Number.isFinite(observed) && observed > 0 ? observed : Date.now());
    this.connection.prepare("INSERT INTO note_metadata(path,created) VALUES(?,?)").run(path, created);
    return created;
  }
  shareToken(path) {
    const existing = this.connection.prepare("SELECT token FROM note_share_ids WHERE path=?").get(path);
    if (existing) return existing.token;
    const token = randomBytes(24).toString("hex");
    this.connection.prepare("INSERT INTO note_share_ids(path,token) VALUES(?,?)").run(path, token);
    return token;
  }
  findShare(token) {
    const row = this.connection
      .prepare("SELECT * FROM shares WHERE token=? AND (expires=0 OR expires>?)")
      .get(token, Date.now());
    return row
      ? {
          token: row.token,
          path: row.path,
          expires: row.expires,
          password: passwordFrom(row),
        }
      : null;
  }
  loadState() {
    return {
      favorites: this.connection
        .prepare("SELECT path FROM favorites ORDER BY rowid")
        .all()
        .map((row) => row.path),
      trash: this.connection
        .prepare("SELECT * FROM trash ORDER BY deleted DESC")
        .all(),
      attachments: this.connection
        .prepare("SELECT * FROM attachments ORDER BY created")
        .all(),
      shares: this.connection
        .prepare("SELECT * FROM shares ORDER BY rowid")
        .all()
        .map((row) => ({
          token: row.token,
          path: row.path,
          expires: row.expires,
          ...(row.password_secret ? { passwordSecret: row.password_secret } : {}),
          ...(row.password_hash ? { password: passwordFrom(row) } : {}),
        })),
    };
  }
  replaceState(state) {
    this.connection.exec(
      "DELETE FROM favorites; DELETE FROM trash; DELETE FROM attachments; DELETE FROM shares;",
    );
    const favorite = this.connection.prepare(
      "INSERT OR IGNORE INTO favorites(path) VALUES (?)",
    );
    for (const item of state.favorites || []) favorite.run(item);
    const trash = this.connection.prepare(
      "INSERT INTO trash(id,path,deleted) VALUES (?,?,?)",
    );
    for (const item of state.trash || [])
      trash.run(item.id, item.path, Math.trunc(item.deleted));
    const attachment = this.connection.prepare(
      "INSERT OR REPLACE INTO attachments(url,name,size,created) VALUES (?,?,?,?)",
    );
    for (const item of state.attachments || [])
      attachment.run(
        item.url,
        item.name,
        Math.trunc(item.size || 0),
        Math.trunc(item.created || Date.now()),
      );
    const share = this.connection.prepare(
      "INSERT INTO shares(token,path,expires,password_salt,password_hash,password_secret) VALUES (?,?,?,?,?,?)",
    );
    for (const item of state.shares || [])
      share.run(
        item.token,
        item.path,
        Math.trunc(item.expires),
        item.password?.salt ?? null,
        item.password?.hash ?? null,
        item.passwordSecret ?? null,
      );
  }
  saveState(state) {
    this.transaction(() => this.replaceState(state));
  }
  listLocks() {
    return this.connection
      .prepare("SELECT path FROM locks ORDER BY path")
      .all();
  }
  getLock(path) {
    const row = this.connection
      .prepare("SELECT * FROM locks WHERE path=?")
      .get(path);
    return row ? { path: row.path, userId: row.user_id } : null;
  }
  getAccessPassword(userId = 1) {
    return passwordFrom(
      this.connection
        .prepare("SELECT * FROM access_passwords WHERE user_id=?")
        .get(userId),
    );
  }
  setAccessPassword(password, userId = 1) {
    this.transaction(() => {
      this.connection
        .prepare(
          "INSERT INTO access_passwords(user_id,password_salt,password_hash) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET password_salt=excluded.password_salt,password_hash=excluded.password_hash",
        )
        .run(userId, password.salt, password.hash);
      this.connection
        .prepare(
          "DELETE FROM lock_grants WHERE token_hash IN (SELECT token_hash FROM sessions WHERE user_id=?)",
        )
        .run(userId);
    });
  }
  setLock(path, userId = 1) {
    this.transaction(() => {
      this.connection.prepare("DELETE FROM lock_grants WHERE path=?").run(path);
      this.connection
        .prepare(
          "INSERT INTO locks(path,user_id) VALUES (?,?) ON CONFLICT(path) DO UPDATE SET user_id=excluded.user_id",
        )
        .run(path, userId);
    });
  }
  removeLock(path) {
    this.connection.prepare("DELETE FROM locks WHERE path=?").run(path);
  }
  grantedLocks(token) {
    if (typeof token !== "string") return [];
    return this.connection
      .prepare("SELECT path FROM lock_grants WHERE token_hash=? AND expires>?")
      .all(tokenHash(token), Date.now())
      .map((row) => row.path);
  }
  unlock(token, path) {
    this.connection
      .prepare(
        "INSERT INTO lock_grants(token_hash,path,expires) VALUES (?,?,?) ON CONFLICT(token_hash,path) DO UPDATE SET expires=excluded.expires",
      )
      .run(tokenHash(token), path, Date.now() + 30 * 60000);
  }
  relock(token, paths) {
    const remove = this.connection.prepare(
      "DELETE FROM lock_grants WHERE token_hash=? AND path=?",
    );
    for (const path of paths) remove.run(tokenHash(token), path);
  }
  addVersion(path, content, reason = "自动保存前", { force = false } = {}) {
    const latest = this.connection
      .prepare(
        "SELECT * FROM note_versions WHERE path=? ORDER BY id DESC LIMIT 1",
      )
      .get(path);
    if (latest?.content === content) return;
    if (
      !force &&
      reason === "自动保存前" &&
      latest?.reason === "自动保存前" &&
      latest.created > Date.now() - 60000
    )
      return;
    this.transaction(() => {
      this.connection
        .prepare(
          "INSERT INTO note_versions(path,content,created,reason) VALUES (?,?,?,?)",
        )
        .run(path, content, Date.now(), reason);
      this.connection
        .prepare(
          "DELETE FROM note_versions WHERE path=? AND id NOT IN (SELECT id FROM note_versions WHERE path=? ORDER BY id DESC LIMIT 50)",
        )
        .run(path, path);
    });
  }
  versions(path) {
    return this.connection
      .prepare(
        "SELECT id,created,reason,length(content) AS characters FROM note_versions WHERE path=? ORDER BY id DESC",
      )
      .all(path);
  }
  version(path, id) {
    return (
      this.connection
        .prepare("SELECT * FROM note_versions WHERE path=? AND id=?")
        .get(path, id) || null
    );
  }
  indexReferences(resource, currentContent) {
    const texts = [
      currentContent,
      ...this.connection
        .prepare("SELECT content FROM note_versions WHERE path=?")
        .all(resource)
        .map((row) => row.content),
    ];
    const urls = new Set(
      texts.flatMap(
        (text) =>
          text.match(/\/api\/attachments\/[a-f0-9-]+\.[a-z0-9]+/gi) || [],
      ),
    );
    this.transaction(() => {
      this.connection
        .prepare("DELETE FROM attachment_refs WHERE resource=?")
        .run(resource);
      const insert = this.connection.prepare(
        "INSERT OR IGNORE INTO attachment_refs(url,resource) VALUES (?,?)",
      );
      for (const url of urls) insert.run(url, resource);
    });
  }
  ownUpload(url, token, resource) {
    this.connection
      .prepare(
        "INSERT INTO upload_owners(url,token_hash,resource,expires) VALUES (?,?,?,?)",
      )
      .run(url, tokenHash(token), resource, Date.now() + 30 * 60000);
  }
  references(url, token) {
    return [
      ...new Set(
        [
          ...this.connection
            .prepare("SELECT resource FROM attachment_refs WHERE url=?")
            .all(url),
          ...(typeof token === "string"
            ? this.connection
                .prepare(
                  "SELECT resource FROM upload_owners WHERE url=? AND token_hash=? AND expires>?",
                )
                .all(url, tokenHash(token), Date.now())
            : []),
        ].map((row) => row.resource),
      ),
    ];
  }
  moveResources(from, to) {
    this.transaction(() => {
      for (const table of [
        "locks",
        "note_versions",
        "note_share_ids",
        "note_metadata",
        "attachment_refs",
        "upload_owners",
      ]) {
        const column =
          ["locks", "note_versions", "note_share_ids", "note_metadata"].includes(table) ? "path" : "resource";
        const rows = this.connection
          .prepare(`SELECT DISTINCT ${column} AS path FROM ${table}`)
          .all();
        const update = this.connection.prepare(
          `UPDATE ${table} SET ${column}=? WHERE ${column}=?`,
        );
        for (const row of rows
          .filter((row) => within(row.path, from))
          .sort((a, b) => b.path.length - a.path.length))
          update.run(to + row.path.slice(from.length), row.path);
      }
    });
  }
  deleteResources(resource) {
    this.transaction(() => {
      for (const table of [
        "locks",
        "note_versions",
        "note_share_ids",
        "note_metadata",
        "attachment_refs",
        "upload_owners",
      ]) {
        const column =
          ["locks", "note_versions", "note_share_ids", "note_metadata"].includes(table) ? "path" : "resource";
        const rows = this.connection
          .prepare(`SELECT DISTINCT ${column} AS path FROM ${table}`)
          .all();
        const remove = this.connection.prepare(
          `DELETE FROM ${table} WHERE ${column}=?`,
        );
        for (const row of rows)
          if (within(row.path, resource)) remove.run(row.path);
      }
    });
  }
  async backupTo(file) {
    await backup(this.connection, file);
    const snapshot = new DatabaseSync(file);
    try {
      snapshot.exec(
        "PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; DELETE FROM sessions;",
      );
    } finally {
      snapshot.close();
    }
  }
  close() {
    if (this.connection.isOpen) this.connection.close();
  }
}

export async function openDatabase(meta) {
  await fs.mkdir(meta, { recursive: true });
  const db = new NoteDatabase(path.join(meta, "notespace.sqlite"));
  return db;
}
