import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { atomic, safePath } from "./store.mjs";
import { createAccess, validateResource, within } from "./access.mjs";
import { Workspaces, isPublicShareRoute } from "./workspaces.mjs";
import { acceptsOrigin } from "./request-origin.mjs";
const dataRoot = path.resolve(process.env.NOTESPACE_DATA_DIR || "data");
await fs.mkdir(dataRoot, { recursive: true });
let initialization;
const attempts = new Map();
let queue = Promise.resolve();
const hash = (value, salt = randomBytes(16).toString("hex")) => ({
  salt,
  hash: scryptSync(value, salt, 64).toString("hex"),
});
const verify = (value, record) => {
  if (!record || typeof value !== "string" || value.length > 128) return false;
  return timingSafeEqual(
    Buffer.from(record.hash, "hex"),
    scryptSync(value, record.salt, 64),
  );
};
const json = (res, status, value) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
};
const MAX_ATTACHMENT_SIZE = 500 * 1024 * 1024;
async function receiveAttachment(req, target) {
  if (Number(req.headers["content-length"]) > MAX_ATTACHMENT_SIZE) throw Error("附件不能超过 500MB");
  const temporary = target + "." + randomUUID() + ".tmp";
  let handle, size = 0;
  try {
    handle = await fs.open(temporary, "wx");
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_ATTACHMENT_SIZE) throw Error("附件不能超过 500MB");
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw Error("附件写入失败");
        offset += bytesWritten;
      }
    }
    await handle.close();
    handle = null;
    await fs.rename(temporary, target);
    return size;
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
}
async function body(req) {
  let size = 0,
    chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 24 * 1024 * 1024) throw Error("请求超过 24MB");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}
const publicDir = path.resolve(
  process.env.NOTESPACE_PUBLIC_DIR ||
    fileURLToPath(new URL("../dist", import.meta.url)),
);
const basePath = (process.env.NOTESPACE_BASE_PATH || "").replace(/\/+$/, "");
const socketPath = process.env.NOTESPACE_SOCKET_PATH || "";
const publicSocketPath = process.env.NOTESPACE_PUBLIC_SOCKET_PATH || "";
if (publicSocketPath && (!socketPath || publicSocketPath === socketPath))
  throw Error("分享 Socket 必须与飞牛管理 Socket 分开配置");
if ((process.env.NOTESPACE_REQUIRE_NAS_USER === "1" || process.env.TRIM_APPDEST) && !socketPath)
  throw Error("飞牛部署必须配置 NOTESPACE_SOCKET_PATH，禁止回退到本地 TCP 调试模式");
const workspaces = new Workspaces(dataRoot, !!socketPath);
const clientUrl = (value) => basePath && value?.startsWith("/") ? basePath + value : value;
const clientContent = (value) => typeof value === "string" && basePath
  ? value.replaceAll("/api/attachments/", basePath + "/api/attachments/")
  : value;
const storedContent = (value) => typeof value === "string" && basePath
  ? value.replaceAll(basePath + "/api/attachments/", "/api/attachments/")
  : value;
async function file(res, target, type = "application/octet-stream", download) {
  const data = await fs.readFile(target);
  res.writeHead(200, {
    "Content-Type": type,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    ...(download
      ? {
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(download)}`,
        }
      : {}),
  });
  res.end(data);
}
function limited(req, bucket = "login", limit = 15) {
  const key = bucket + ":" + (socketPath ? (req.headers["x-trim-userid"] || "public") : req.socket.remoteAddress),
    now = Date.now();
  let v = attempts.get(key);
  if (!v || v.until < now) {
    v = { count: 0, until: now + 60000 };
    attempts.set(key, v);
  }
  if (++v.count > limit) {
    const error = Error("尝试过于频繁，请一分钟后重试");
    error.status = 429;
    throw error;
  }
  if (attempts.size > 1000)
    for (const [key, value] of attempts)
      if (value.until < now) attempts.delete(key);
}
async function handle(req, res, publicOnly = false) {
  const url = new URL(req.url, "http://localhost");
  let route = url.pathname;
  if (basePath) {
    if (route !== basePath && !route.startsWith(basePath + "/"))
      return json(res, 404, { error: "页面不存在" });
    route = route.slice(basePath.length) || "/";
  }
  if (publicOnly) {
    const allowed = /^\/s\/[a-f0-9]{48}\/?$/.test(route) || isPublicShareRoute(route) || /^\/assets\/[A-Za-z0-9_.-]+$/.test(route);
    if (!allowed) return json(res, 404, { error: "分享入口不提供此功能" });
    if (req.method !== "GET") return json(res, 405, { error: "分享入口仅允许只读访问" });
    for (const name of Object.keys(req.headers))
      if (name.startsWith("x-trim-") || ["cookie", "authorization", "x-notespace-health"].includes(name)) delete req.headers[name];
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (!acceptsOrigin(req, !!socketPath))
    return json(res, 403, { error: "跨站请求被拒绝" });
  if (route === "/health" && req.method === "GET") {
    if (socketPath && !(process.env.NOTESPACE_HEALTH_TOKEN && req.headers["x-notespace-health"] === process.env.NOTESPACE_HEALTH_TOKEN))
      workspaces.requireUser(req);
    return json(res, 200, { ok: true });
  }
  // Share pages need their compiled assets without a NAS login. All other
  // application pages and APIs require the gateway's trusted user identity.
  if (socketPath && !route.startsWith("/api/")) {
    const sharePage = /^\/s\/[a-f0-9]{48}\/?$/.test(route);
    const staticAsset = route.startsWith("/assets/");
    if (!sharePage && !staticAsset) workspaces.requireUser(req);
  }
  if (isPublicShareRoute(route) && req.method !== "GET")
    return json(res, 405, { error: "分享接口仅允许只读访问" });
  const { uid, root, notes, meta, trash, assets, database, config, resources, save, shareSecrets } =
    await workspaces.forRequest(req, route);
  if (route === "/api/status")
    return json(res, 200, {
      initialized: !!database.getUser(),
      registrationOpen: !database.getUser(),
      apiVersion: 4,
      capabilities: ["account-reading-password", "nas-user-isolation"],
      ...(socketPath ? { nasUserId: uid } : {}),
    });
  if (
    (route === "/api/setup" || route === "/api/register") &&
    req.method === "POST"
  ) {
    limited(req, "register");
    if (database.getUser())
      return json(res, 409, { error: "登录密码已设置，请直接登录" });
    const b = await body(req);
    if (
      typeof b.password !== "string" ||
      b.password.length < 6 ||
      b.password.length > 20
    )
      throw Error("登录密码须为 6 至 20 位");
    // The trusted workspace UID identifies the account. Keep the existing
    // database column as an internal identifier, without accepting a username.
    database.createUser(uid === "local" ? "local" : `nas-${uid}`, hash(b.password));
    return json(res, 200, { ok: true });
  }
  if (route === "/api/login" && req.method === "POST") {
    limited(req);
    const b = await body(req);
    // Resolve only the account in the current UID's workspace. A client-supplied
    // username cannot select another account or another NAS user's data.
    const user = database.getUser();
    if (
      typeof b.password !== "string" ||
      b.password.length < 6 ||
      b.password.length > 20 ||
      !verify(b.password, user?.password)
    )
      return json(res, 401, { error: "登录密码错误" });
    const token = randomBytes(32).toString("hex");
    database.createSession(token, Date.now() + 12 * 3600000);
    res.setHeader(
      "Set-Cookie",
      `notespace=${token}; HttpOnly; SameSite=Strict; Path=${basePath ? basePath + "/" : "/"}; Max-Age=43200${process.env.NOTESPACE_SECURE_COOKIE === "1" ? "; Secure" : ""}`,
    );
    return json(res, 200, { ok: true });
  }
  if (isPublicShareRoute(route)) {
    const token = route.split("/")[3],
      share = database.findShare(token);
    if (!share) {
      limited(req, "public-invalid", 60);
      return json(res, 404, { error: "分享不存在或已过期" });
    }
    if (
      share.password &&
      !verify(req.headers["x-share-password"] || "", share.password)
    ) {
      limited(req, "share-password:" + token, 10);
      return json(res, 401, { error: "请输入分享密码" });
    }
    if (createAccess(database).protected(share.path))
      return json(res, 404, { error: "分享已关闭" });
    const content = await fs.readFile(
      await safePath(notes, share.path),
      "utf8",
    );
    if (route.endsWith("/attachment")) {
      const name = url.searchParams.get("name");
      if (
        !/^[a-f0-9-]+\.[a-z0-9]+$/i.test(name || "") ||
        !content.includes(`/api/attachments/${name}`)
      )
        return json(res, 403, { error: "附件未授权" });
      const original =
        config.attachments.find((a) => a.url === "/api/attachments/" + name)
          ?.name || name;
      return file(res, await safePath(assets, name), mime(name), original);
    }
    return json(res, 200, { path: share.path, content: clientContent(content) });
  }
  if (route.startsWith("/api/")) {
    const token = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("notespace="))
      ?.slice(10);
    const user = database.session(token);
    if (!user) return json(res, 401, { error: "请先登录" });
    if (route === "/api/shares" && req.method === "GET") {
      const access = resources.access(token);
      return json(res, 200, {
        shares: config.shares.filter((share) => !access.protected(share.path)).map((share) => ({
          token: share.token,
          path: share.path,
          expires: share.expires,
          hasPassword: !!share.password,
          password: share.password ? shareSecrets.decrypt(share.passwordSecret) : null,
        })),
      });
    }
    if (route === "/api/logout" && req.method === "POST") {
      database.revokeSession(token);
      res.setHeader(
        "Set-Cookie",
        `notespace=; HttpOnly; SameSite=Strict; Path=${basePath ? basePath + "/" : "/"}; Max-Age=0`,
      );
      return json(res, 200, { ok: true });
    }
    if (route === "/api/state") {
      const state = await resources.state(token);
      return json(res, 200, {
        ...state,
        attachments: (state.attachments || []).map((item) => ({ ...item, url: clientUrl(item.url) })),
        dataDir: root,
        ...(socketPath ? { nasUserId: uid } : {}),
        user: {
          username: user.username,
          accessPasswordConfigured: !!database.getAccessPassword(user.id),
        },
      });
    }
    if (route === "/api/trash-preview" && req.method === "GET") {
      const item = await resources.getTrash(url.searchParams.get("id"), token);
      return json(res, 200, { ...item, content: clientContent(item.content) });
    }
    if (route === "/api/account/access-password" && req.method === "GET")
      return json(res, 200, {
        configured: !!database.getAccessPassword(user.id),
      });
    if (route === "/api/note" && req.method === "GET") {
      const note = await resources.getNote(url.searchParams.get("path"), token);
      return json(res, 200, { ...note, content: clientContent(note.content) });
    }
    if (route === "/api/access" && req.method === "GET") {
      const { key, stat } = await resources.check(
        url.searchParams.get("path") || "",
        token,
      );
      return json(res, 200, {
        path: key,
        type: stat.isDirectory() ? "folder" : "note",
        ...resources.access(token).describe(key),
      });
    }
    if (route === "/api/versions" && req.method === "GET")
      return json(res, 200, {
        versions: await resources.versions(url.searchParams.get("path"), token),
      });
    if (/^\/api\/versions\/\d+$/.test(route) && req.method === "GET") {
      const version = await resources.version(
          url.searchParams.get("path"),
          Number(route.split("/").at(-1)),
          token,
        );
      return json(res, 200, { ...version, content: clientContent(version.content) });
    }
    if (route.startsWith("/api/attachments/") && req.method === "GET") {
      const name = decodeURIComponent(route.split("/").at(-1));
      resources.requireAttachment("/api/attachments/" + name, token);
      const original =
        config.attachments.find((a) => a.url === "/api/attachments/" + name)
          ?.name || name;
      return file(
        res,
        await safePath(assets, name),
        mime(name),
        url.searchParams.get("download") === "1" ? original : undefined,
      );
    }
    const binaryUpload = route === "/api/attachment" && req.method === "POST" && req.headers["content-type"] === "application/octet-stream";
    const b = binaryUpload ? {
      name: decodeURIComponent(req.headers["x-notespace-filename"] || ""),
      path: decodeURIComponent(req.headers["x-notespace-path"] || ""),
    } : await body(req);
    if (route === "/api/account/access-password" && req.method === "POST") {
      const existing = database.getAccessPassword(user.id);
      if (existing) {
        limited(req, "access-password-update", 10);
        const valid =
          b.reset === true
            ? verify(b.loginPassword, database.getUser(user.username)?.password)
            : verify(b.currentPassword, existing);
        if (!valid)
          return json(res, 403, {
            error: b.reset === true ? "登录密码错误" : "当前阅读密码错误",
          });
      }
      if (
        typeof b.newPassword !== "string" ||
        b.newPassword.length < 6 ||
        b.newPassword.length > 20
      )
        throw Error("阅读密码须为 6 至 20 位");
      database.setAccessPassword(hash(b.newPassword), user.id);
      return json(res, 200, { ok: true });
    }
    if (route.startsWith("/api/locks/") && req.method === "POST") {
      let key;
      if (typeof b.path === "string" && b.path.startsWith("@trash/")) {
        validateResource(b.path, { internal: true });
        if (
          !config.trash.some(
            (item) =>
              b.path === "@trash/" + item.id ||
              b.path.startsWith("@trash/" + item.id + "/"),
          )
        )
          throw Object.assign(Error("回收记录不存在"), { status: 404 });
        key = b.path;
      } else key = await resources.key(b.path);
      const access = resources.access(token);
      if (route === "/api/locks/unlock") {
        const scopes = access.paths(key);
        if (!scopes.length)
          throw Object.assign(Error("锁不存在"), { status: 404 });
        if (!verify(b.password, database.getAccessPassword(user.id))) {
          limited(req, "reading-password:" + user.id, 10);
          return json(res, 403, { error: "阅读密码错误" });
        }
        // One account password also unlocks all ancestors of the selected resource.
        for (const scope of scopes) database.unlock(token, scope);
        return json(res, 200, { ok: true, expires: Date.now() + 30 * 60000 });
      }
      if (route === "/api/locks/relock") {
        const scopes = access.paths(key);
        database.relock(token, scopes);
        return json(res, 200, { ok: true, scopes });
      }
      if (route === "/api/locks/remove") {
        access.require(key);
        if (!database.getLock(key)) throw Error("该内容没有独立加锁标记");
        database.removeLock(key);
        return json(res, 200, { ok: true });
      }
      if (route === "/api/locks/set") {
        if (key.startsWith("@trash/")) throw Error("请恢复内容后再设置密码");
        await resources.check(key, token, { tree: true });
        if (!database.getAccessPassword(user.id))
          return json(res, 409, {
            error: "请先为当前账号设置阅读密码",
            code: "ACCESS_PASSWORD_REQUIRED",
          });
        if (b.password !== undefined)
          throw Error("加锁仅设置标记，阅读密码请在账号设置中管理");
        // Refresh references before hiding the subtree, including externally edited notes.
        await resources.indexAll();
        database.setLock(key, user.id);
        config.shares = config.shares.filter(
          (share) => !within(share.path, key),
        );
        await save();
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: "接口不存在" });
    }
    if (route === "/api/versions/snapshot" && req.method === "POST") {
      await resources.snapshot(b, token);
      return json(res, 200, { ok: true });
    }
    if (route === "/api/versions/restore" && req.method === "POST")
      return json(res, 200, await resources.restore(b, token));
    if (route === "/api/account/password" && req.method === "POST") {
      limited(req, "change-password", 10);
      if (!verify(b.currentPassword, database.getUser()?.password))
        return json(res, 400, { error: "当前密码错误" });
      if (
        typeof b.newPassword !== "string" ||
        b.newPassword.length < 6 ||
        b.newPassword.length > 20
      )
        throw Error("新登录密码须为 6 至 20 位");
      database.changePassword(hash(b.newPassword));
      res.setHeader(
        "Set-Cookie",
        `notespace=; HttpOnly; SameSite=Strict; Path=${basePath ? basePath + "/" : "/"}; Max-Age=0`,
      );
      return json(res, 200, { ok: true });
    }
    if (route === "/api/note" && req.method === "PUT") {
      b.content = storedContent(b.content);
      return json(res, 200, await resources.writeNote(b, token));
    }
    if (route === "/api/folder" && req.method === "POST") {
      const key = await resources.key(b.path, { keepLeaf: true });
      resources.access(token).require(key);
      await fs.mkdir(await safePath(notes, key), { recursive: true });
    } else if (route === "/api/move" && req.method === "POST") {
      await resources.move(b, token);
    } else if (route === "/api/delete" && req.method === "POST") {
      await resources.remove(b.path, token);
    } else if (route === "/api/restore" && req.method === "POST") {
      await resources.recycle(b, token);
    } else if (route === "/api/purge" && req.method === "POST") {
      await resources.recycle(b, token, true);
    } else if (route === "/api/favorite" && req.method === "POST") {
      const { key } = await resources.check(b.path, token, { note: true });
      config.favorites = config.favorites.includes(key)
        ? config.favorites.filter((path) => path !== key)
        : [...config.favorites, key];
      await save();
    } else if (route === "/api/attachment" && req.method === "POST") {
      const { key } = await resources.check(b.path, token, { note: true });
      if (
        (!binaryUpload && typeof b.data !== "string") ||
        typeof b.name !== "string" ||
        !b.name ||
        b.name.length > 255 ||
        /[\r\n\0]/.test(b.name)
      )
        throw Error("无效附件");
      const ext =
          path
            .extname(b.name)
            .slice(1)
            .replace(/[^a-z0-9]/gi, "")
            .slice(0, 12)
            .toLowerCase() || "bin",
        name = randomUUID() + "." + ext;
      let size;
      if (binaryUpload) {
        size = await receiveAttachment(req, path.join(assets, name));
      } else {
        const data = Buffer.from(b.data, "base64");
        if (data.length > MAX_ATTACHMENT_SIZE) throw Error("附件不能超过 500MB");
        await atomic(path.join(assets, name), data);
        size = data.length;
      }
      const record = {
        url: "/api/attachments/" + name,
        name: b.name,
        size,
        created: Date.now(),
      };
      config.attachments.push(record);
      await save();
      database.ownUpload(record.url, token, key);
      return json(res, 200, { ...record, url: clientUrl(record.url) });
    } else if (route === "/api/share" && req.method === "POST") {
      if (
        b.password !== undefined &&
        (typeof b.password !== "string" || b.password.length > 128)
      )
        throw Error("分享密码不能超过 128 位");
      const { key } = await resources.check(b.path, token, { note: true });
      if (resources.access(token).protected(key))
        throw Error("加锁内容不能分享，请先取消笔记及上级文件夹的访问密码");
      const hours = Number(b.hours);
      if (b.hours === null || b.hours === undefined || b.hours === "" || !Number.isInteger(hours) || hours < 0 || hours > 8760)
        throw Error("有效期须为 0 至 8760 的整数小时，0 表示长期有效");
      const share = {
        // The note's permanent share ID is independent of active share settings.
        // Revocation, expiration and password changes never replace this ID.
        token: database.shareToken(key),
        path: key,
        expires: hours === 0 ? 0 : Date.now() + hours * 3600000,
        ...(b.password ? { password: hash(b.password), passwordSecret: shareSecrets.encrypt(b.password) } : {}),
      };
      // Replace rather than append; also collapse older duplicate shares.
      config.shares = config.shares.filter((item) => item.path !== key);
      config.shares.push(share);
      await save();
      return json(res, 200, { token: share.token });
    } else if (route === "/api/revoke" && req.method === "POST") {
      config.shares = config.shares.filter((s) => s.token !== b.token);
      await save();
    } else if (route === "/api/backup" && req.method === "POST") {
      resources.access(token).require("", { tree: true });
      const id = new Date().toISOString().replace(/[:.]/g, "-"),
        to = path.join(root, "backups", id);
      await fs.mkdir(to, { recursive: true });
      for (const dir of ["notes", "attachments", "trash"])
        await fs.cp(path.join(root, dir), path.join(to, dir), {
          recursive: true,
          dereference: false,
        });
      await fs.mkdir(path.join(to, ".notespace"), { recursive: true });
      // SQLite online backup includes committed WAL data in a consistent database snapshot.
      await database.backupTo(path.join(to, ".notespace", "notespace.sqlite"));
      await fs.copyFile(shareSecrets.file, path.join(to, ".notespace", "share-password.key"));
      return json(res, 200, { path: to });
    } else if (!(route === "/api/folder" && req.method === "POST"))
      return json(res, 404, { error: "接口不存在" });
    return json(res, 200, { ok: true });
  }
  const relative = decodeURIComponent(route).replace(/^\/+/, ""),
    target = await safePath(publicDir, relative || "index.html");
  try {
    return await file(res, target, mime(target));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    if (path.extname(relative)) return json(res, 404, { error: "文件不存在" });
    return file(
      res,
      path.join(publicDir, "index.html"),
      "text/html; charset=utf-8",
    );
  }
}
function mime(name) {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript",
      ".css": "text/css",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".ico": "image/x-icon",
    }[path.extname(name)] || "application/octet-stream"
  );
}
function createServer(publicOnly = false) {
  return http.createServer((req, res) => {
  const run = () =>
    Promise.resolve(initialization)
      .then(() => handle(req, res, publicOnly))
      .catch((e) => {
        if (!res.headersSent)
          json(res, e.status || (e.code === "ENOENT" ? 404 : 400), {
            error: e.code === "ENOENT" ? "内容不存在" : e.message,
            ...(e.code === "LOCKED"
              ? { code: "LOCKED", lockPath: e.lockPath }
              : {}),
          });
        else res.end();
      });
  queue = queue.then(run, run);
  });
}
const server = createServer();
const publicServer = publicSocketPath ? createServer(true) : null;
function closeServers(done) {
  let remaining = publicServer ? 2 : 1;
  const closed = () => { if (--remaining === 0) done(); };
  server.close(closed);
  publicServer?.close(closed);
}
server.requestTimeout = 30 * 60 * 1000;
const port = Number(process.env.PORT || 3210);
const host = process.env.HOST || "127.0.0.1";
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`NoteSpace 启动失败：${host}:${port} 已被其他进程占用。`);
    console.error(
      "若已有 NoteSpace 实例，请直接访问其地址，或停止旧服务后重启。若端口被其他应用占用，可使用其他端口：",
    );
    console.error(`$env:PORT = '${port + 1}'; npm start`);
  } else console.error(`NoteSpace 启动失败：${error.message}`);
  process.exitCode = 1;
});
const onListening = () => {
  // Open SQLite only after acquiring the socket/port, so a second instance cannot touch it.
  initialization = (async () => {
    if (socketPath && process.platform !== "win32") await fs.chmod(socketPath, 0o660);
    await workspaces.initialize();
    if (publicServer) {
      await fs.rm(publicSocketPath, { force: true });
      await new Promise((resolve, reject) => {
        publicServer.once("error", reject);
        publicServer.listen(publicSocketPath, resolve);
      });
      if (process.platform !== "win32") await fs.chmod(publicSocketPath, 0o660);
    }
    const address = server.address();
    const listenTarget = socketPath || `${typeof address === "object" ? address.port : port}`;
    console.log(`NoteSpace listening on ${listenTarget}; base: ${basePath || "/"}; data: ${dataRoot}`);
  })();
  initialization.catch((error) => {
    console.error("NoteSpace 数据初始化失败：" + error.message);
    process.exitCode = 1;
    closeServers(() => {
      workspaces.close();
      if (socketPath) fs.rm(socketPath, { force: true }).catch(() => {});
      if (publicSocketPath) fs.rm(publicSocketPath, { force: true }).catch(() => {});
    });
  });
};
if (socketPath) {
  await fs.rm(socketPath, { force: true });
  server.listen(socketPath, onListening);
} else server.listen(port, host, onListening);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    closeServers(() => {
      workspaces.close();
      if (socketPath) fs.rm(socketPath, { force: true }).catch(() => {});
      if (publicSocketPath) fs.rm(publicSocketPath, { force: true }).catch(() => {});
      process.exit(0);
    });
  });
process.on("exit", () => workspaces.close());
