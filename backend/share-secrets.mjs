import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export async function openShareSecrets(meta) {
  const file = path.join(meta, "share-password.key");
  let key;
  try { key = await fs.readFile(file); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const fresh = randomBytes(32);
    try { await fs.writeFile(file, fresh, { flag: "wx", mode: 0o600 }); }
    catch (writeError) { if (writeError.code !== "EEXIST") throw writeError; }
    key = await fs.readFile(file);
  }
  if (key.length !== 32) throw Error("分享密码密钥文件无效");
  return {
    file,
    encrypt(password) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
    },
    decrypt(secret) {
      if (!secret) return null;
      try {
        const bytes = Buffer.from(secret, "base64");
        if (bytes.length < 28) return null;
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
      } catch { return null; }
    },
  };
}
