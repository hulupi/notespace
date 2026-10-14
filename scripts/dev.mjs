import { spawn } from "node:child_process";
import net from "node:net";
const port = Number(process.env.PORT || 3210),
  host = process.env.HOST || "127.0.0.1";
// Watch mode remains alive after startup failures; reject an occupied port first
// so Vite cannot silently connect to a different, older backend process.
const probe = net.createServer();
try {
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, host, resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
} catch (error) {
  console.error(
    error.code === "EADDRINUSE"
      ? `NoteSpace 开发启动失败：${host}:${port} 已被占用。请先在旧服务终端按 Ctrl+C 停止，再运行 npm run dev。`
      : error.message,
  );
  process.exit(1);
}
const children = [
  spawn(process.execPath, ["--watch", "backend/server.mjs"], {
    stdio: "inherit",
  }),
  spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "--config", "frontend/vite.config.js"],
    { stdio: "inherit" },
  ),
];
for (const child of children)
  child.on("exit", (code) => {
    children.forEach((c) => c.kill());
    process.exit(code || 0);
  });
process.on("SIGINT", () => {
  children.forEach((c) => c.kill());
  process.exit(0);
});
