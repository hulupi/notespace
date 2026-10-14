function origin(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
      return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

// Proxy headers and browser fetch metadata are trusted only behind the local
// Unix Socket gateway, never on the development TCP listener.
export function acceptsOrigin(req, gateway = false) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !req.headers.origin) return true;
  const source = origin(req.headers.origin);
  if (!source || req.headers.origin.replace(/\/$/, "") !== source) return false;
  const site = req.headers["sec-fetch-site"];
  if (site === "cross-site" || site === "same-site") return false;
  const host = req.headers.host;
  if (source === origin(`http://${host}`) || source === origin(`https://${host}`)) return true;
  if (!gateway) return false;
  const forwardedHost = req.headers["x-forwarded-host"]?.split(",")[0].trim();
  const protocol = req.headers["x-forwarded-proto"]?.split(",")[0].trim();
  const port = req.headers["x-forwarded-port"]?.split(",")[0].trim();
  if (forwardedHost && ["http", "https"].includes(protocol)) {
    let target = origin(`${protocol}://${forwardedHost}`);
    if (target && /^\d{1,5}$/.test(port || "")) {
      const parsed = new URL(target);
      if (!parsed.port) {
        parsed.port = port;
        target = parsed.origin;
      }
    }
    if (target === source) return true;
  }
  // Some fnOS gateway versions rewrite Host without forwarding the public
  // authority. Sec-Fetch-Site describes the browser request before that rewrite
  // and cannot be set by page JavaScript. Only exact same-origin requests pass.
  if (site === "same-origin") {
    const referer = req.headers.referer;
    return !referer || origin(referer) === source;
  }
  // Plain HTTP on a private NAS IP can omit Sec-Fetch-Site entirely. This
  // non-safelisted header is sent by our SPA; a foreign website would first
  // need a CORS preflight, which this service never authorizes. Do not use this
  // fallback on the TCP listener or start adding permissive CORS headers.
  if (!site && req.headers["x-notespace-request"] === "1")
    return ["application/json", "application/octet-stream"].includes(
      req.headers["content-type"]?.split(";")[0].trim().toLowerCase(),
    );
  return false;
}
