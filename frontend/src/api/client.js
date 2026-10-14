const appBase = (import.meta.env?.BASE_URL || "/").replace(/\/$/, "");
const apiBase = `${appBase}/api`;

export async function api(url, method = "GET", data, headers = {}) {
  const response = await fetch(apiBase + url, {
    method,
    headers: { "Content-Type": "application/json", "X-NoteSpace-Request": "1", ...headers },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 404 && url === "/account/access-password") {
      const statusResponse = await fetch(`${apiBase}/status`);
      const status = await statusResponse.json();
      if (!status.capabilities?.includes("account-reading-password"))
        throw Object.assign(
          new Error(
            "当前连接的是旧版后端。请在启动后端的终端按 Ctrl+C 停止旧服务，再运行 npm run dev（或 npm start）并刷新页面。",
          ),
          { status: 404, code: "BACKEND_OUTDATED" },
        );
    }
    const error = new Error(result.error || "请求失败");
    error.status = response.status;
    error.code = result.code;
    error.lockPath = result.lockPath;
    throw error;
  }
  return result;
}
export async function uploadFile(file, onProgress = () => {}, path) {
  if (file.size > 500 * 1024 * 1024) throw Error("单个附件不能超过 500MB");
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${apiBase}/attachment`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-NoteSpace-Filename", encodeURIComponent(file.name));
    xhr.setRequestHeader("X-NoteSpace-Path", encodeURIComponent(path));
    xhr.setRequestHeader("X-NoteSpace-Request", "1");
    xhr.timeout = 30 * 60 * 1000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        onProgress(Math.min(95, Math.round((e.loaded / e.total) * 95)));
    };
    xhr.onload = () => {
      let result;
      try {
        result = JSON.parse(xhr.responseText);
      } catch {
        reject(Error("服务器返回异常"));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve(result);
      } else {
        const error = Error(result.error || "上传失败");
        error.status = xhr.status;
        error.code = result.code;
        error.lockPath = result.lockPath;
        reject(error);
      }
    };
    xhr.onerror = () => reject(Error("网络中断，请重新上传"));
    xhr.ontimeout = () => reject(Error("上传超时，请重试"));
    xhr.send(file);
  });
}
