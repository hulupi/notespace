export function extractAttachments(markdown, assets = []) {
  const base = (import.meta.env?.BASE_URL || "/").replace(/\/$/, "");
  const escapedBase = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = escapedBase ? `(?:${escapedBase})?` : "";
  const pattern = new RegExp(
    `(!?)\\[([^\\]]*)\\]\\((${prefix}\\/api\\/attachments\\/[a-f0-9-]+\\.[a-z0-9]+)(?:\\s+(?:"[^"]*"|'[^']*'|\\([^)]*\\)))?\\)`,
    "gi",
  );
  const matches = markdown.matchAll(pattern);
  return [
    ...new Map(
      [...matches].map((match) => {
        const asset = assets.find((item) => item.url === match[3]);
        return [
          match[3],
          {
            url: match[3],
            name: asset?.name || match[2] || "附件",
            image: !!match[1],
            size: asset?.size,
          },
        ];
      }),
    ).values(),
  ];
}
