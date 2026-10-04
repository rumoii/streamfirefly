export const INLINE_MANIFEST_MAX_BYTES = 512 * 1024;
export function newId() { return crypto.randomUUID(); }
export function supportedPage(url) { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } }
export function cleanPageTitle(value) { return String(value || '').replace(/^(?:(?:流萤(?:\s+StreamFirefly)?)[\s·|\-–—:：]+)+/i, '').trim() || '未命名页面'; }
export function pageTitleFor(tab) { try { return cleanPageTitle(tab?.title || new URL(tab?.url || '').hostname); } catch { return cleanPageTitle(tab?.title); } }
/** Identifies the page a document shows; fragment-only changes stay on the same page. */
export function pageKey(url) { return String(url || '').split('#', 1)[0]; }
export function normalizeSortMode(value) { return ['detected', 'size', 'duration'].includes(value) ? value : 'detected'; }
