import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { deflateSync, gunzipSync, gzipSync } from "node:zlib";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fpk = path.join(root, "fpk");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败，退出码 ${result.status}`);
  return result;
}

function crc32(data) {
  let c = 0xffffffff;
  for (const byte of data) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const t = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([size, t, data, crc]);
}
function icon(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * (size * 4 + 1) + 1 + x * 4;
    const paper = x > size * .28 && x < size * .72 && y > size * .2 && y < size * .8;
    const line = paper && x > size * .36 && x < size * .64 && [.38, .5, .62].some(v => Math.abs(y - size * v) < size * .017);
    pixels.set(line ? [66, 107, 81, 255] : paper ? [239, 244, 230, 255] : [66, 107, 81, 255], i);
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk("IHDR", header), pngChunk("IDAT", deflateSync(pixels)), pngChunk("IEND", Buffer.alloc(0))]);
}

function normalizeShellScript(file) {
  const content = fsSync.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  fsSync.writeFileSync(file, content);
  fsSync.chmodSync(file, 0o755);
}

function tarName(header) {
  const read = (start, length) => header.subarray(start, start + length).toString().replace(/\0.*$/, "");
  const name = read(0, 100), prefix = read(345, 155);
  return (prefix ? `${prefix}/${name}` : name).replace(/^\.\//, "");
}

function setTarMode(header, mode) {
  header.write(mode.toString(8).padStart(6, "0") + "\0", 100, 8, "ascii");
  header.fill(32, 148, 156);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
}

function rewriteTar(tar, transform) {
  const parts = [];
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = Buffer.from(tar.subarray(offset, offset + 512));
    if (header.every(byte => byte === 0)) {
      parts.push(tar.subarray(offset));
      break;
    }
    const name = tarName(header);
    const oldSize = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, "").trim(), 8) || 0;
    const start = offset + 512, end = start + oldSize;
    if (end > tar.length) throw new Error(`FPK TAR 条目损坏：${name}`);
    const original = tar.subarray(start, end);
    transform(name, header);
    parts.push(header, original);
    const paddedSize = Math.ceil(oldSize / 512) * 512;
    if (paddedSize > oldSize) parts.push(tar.subarray(end, end + paddedSize - oldSize));
    offset = start + Math.ceil(oldSize / 512) * 512;
  }
  return Buffer.concat(parts);
}

function repairFpkPermissions(file) {
  const outer = rewriteTar(gunzipSync(fsSync.readFileSync(file)), (name, header) => {
    // Lifecycle helpers run as root: their directories must never be writable
    // by the application account. Leave app.tgz untouched to retain its checksum.
    setTarMode(header, header[156] === 53 || name.startsWith("cmd/") ? 0o755 : 0o644);
  });
  fsSync.writeFileSync(file, gzipSync(outer));
}

run(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", path.join(root, "frontend", "vite.config.js")], {
  env: { ...process.env, VITE_BASE_PATH: "/app/node-space/" },
});

const serverDir = path.join(fpk, "app", "server");
const publicDir = path.join(fpk, "app", "public");
await fs.rm(serverDir, { recursive: true, force: true });
await fs.rm(publicDir, { recursive: true, force: true });
await fs.cp(path.join(root, "backend"), serverDir, {
  recursive: true,
  filter: source => !source.endsWith(".test.mjs"),
});
await fs.cp(path.join(root, "dist"), publicDir, { recursive: true });
await fs.rm(path.join(fpk, "app", "runtime"), { recursive: true, force: true });

// Use the project's supplied icons; never regenerate or overwrite the logo.
const icon64 = await fs.readFile(path.join(fpk, "ICON.PNG"));
const icon256 = await fs.readFile(path.join(fpk, "ICON_256.PNG"));
await fs.mkdir(path.join(fpk, "app", "ui", "images"), { recursive: true });
await fs.writeFile(path.join(fpk, "app", "ui", "images", "icon_64.png"), icon64);
await fs.writeFile(path.join(fpk, "app", "ui", "images", "icon_256.png"), icon256);
// Change the desktop icon URL whenever its contents change to avoid reusing
// an older cached image. Preserve the four original icon filenames as well.
const iconRevision = createHash("sha256").update(icon64).update(icon256).digest("hex").slice(0, 12);
const revisionDirectory = path.join(fpk, "app", "ui", "images", `v-${iconRevision}`);
await fs.mkdir(revisionDirectory, { recursive: true });
await fs.writeFile(path.join(revisionDirectory, "icon_64.png"), icon64);
await fs.writeFile(path.join(revisionDirectory, "icon_256.png"), icon256);
const uiConfigPath = path.join(fpk, "app", "ui", "config");
const uiConfig = JSON.parse(await fs.readFile(uiConfigPath, "utf8"));
const iconLaunchName = (await fs.readFile(path.join(fpk, "manifest"), "utf8")).match(/^desktop_applaunchname\s*=\s*(\S+)/m)?.[1];
if (!uiConfig[".url"]?.[iconLaunchName]) throw new Error("找不到桌面图标对应的应用入口。");
uiConfig[".url"][iconLaunchName].icon = `images/v-${iconRevision}/icon_{0}.png`;
await fs.writeFile(uiConfigPath, JSON.stringify(uiConfig, null, 4) + "\n");
for (const name of await fs.readdir(path.join(fpk, "cmd"))) normalizeShellScript(path.join(fpk, "cmd", name));
normalizeShellScript(path.join(fpk, "app", "check-data-directory"));

const fnpack = process.env.FNPACK || "fnpack";
const manifest = fsSync.readFileSync(path.join(fpk, "manifest"), "utf8");
const appName = manifest.match(/^appname\s*=\s*(\S+)/m)?.[1];
const version = manifest.match(/^version\s*=\s*(\S+)/m)?.[1];
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version || ""))
  throw new Error("fpk/manifest 中的版本号无效，请使用例如 1.2.1 的格式。");
const launchName = manifest.match(/^desktop_applaunchname\s*=\s*(\S+)/m)?.[1];
const entry = JSON.parse(fsSync.readFileSync(path.join(fpk, "app", "ui", "config"), "utf8"))[".url"]?.[launchName];
if (appName !== "node-space" || entry?.gatewayPrefix !== `/app/${appName}` || entry?.gatewaySocket !== "app.sock")
  throw new Error("FPK 应用标识、桌面入口和统一网关路径不一致。");
const artifact = path.join(fpk, "node-space.fpk");
await fs.rm(artifact, { force: true });
await fs.rm(path.join(fpk, "notespace.fpk"), { force: true });
run(fnpack, ["build"], { cwd: fpk });
const packed = await fs.stat(artifact).catch(() => null);
if (!packed?.size) throw new Error("fnpack 没有生成 fpk/node-space.fpk，请检查 fnpack 输出中的错误信息。");
repairFpkPermissions(artifact);
const versionedArtifact = path.join(fpk, `${appName}-${version}.fpk`);
await fs.rm(versionedArtifact, { force: true });
await fs.rename(artifact, versionedArtifact);
console.log(`FPK 构建完成：${versionedArtifact}\n应用通过 fnOS 统一网关 /app/node-space 和 Unix Socket 访问，无需暴露服务端口。`);
