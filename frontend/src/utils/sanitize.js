import DOMPurify from "dompurify";

export function sanitizeMarkdown(html) {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    // These are SVG drawing data, not URLs. Preserve the editor's native path
    // icons without allowing event handlers or bypassing href/src validation.
    ADD_URI_SAFE_ATTR: ["d", "viewBox", "points", "transform"],
    // Authorized share attachments are rendered through local object URLs.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|blob:https?:|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
  });
}
