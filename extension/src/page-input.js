// These fields are produced by the background, never by a page or DOM probe.
const BACKGROUND_FIELDS = new Set(["requestHeaders", "referer", "size", "sizeSource", "sizeKind", "contentDisposition", "requestId", "resourceType", "extraction", "parents", "userPicked", "sourceContextId", "capturedAt"]);

export function sanitizePageCandidate(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.url !== "string" || /[\x00-\x1f\x7f]/.test(value.url)) return null;
  try { if (!["http:", "https:", "blob:"].includes(new URL(value.url).protocol)) return null; }
  catch (_) { return null; }
  const candidate = Object.fromEntries(Object.entries(value).filter(([name]) => !BACKGROUND_FIELDS.has(name)));
  if (candidate.source === "network") candidate.source = "page-probe";
  return candidate;
}
