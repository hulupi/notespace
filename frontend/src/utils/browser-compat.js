// These IDs identify UI upload tasks; authentication tokens are generated on the server.
export function createUploadId(cryptoProvider = globalThis.crypto) {
  if (typeof cryptoProvider?.randomUUID === "function")
    return cryptoProvider.randomUUID();
  // crypto.randomUUID is unavailable on ordinary HTTP NAS addresses.
  return `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
