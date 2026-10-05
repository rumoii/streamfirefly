/** Build edition shared by every extension bundle: `general` sniffs all sites, `chrome-store` keeps the Chrome Web Store site restrictions. */
export const EDITIONS = Object.freeze(['general', 'chrome-store']);

export function resolveEdition(value = process.env.STREAMFIREFLY_EDITION) {
  const edition = value || 'general';
  if (!EDITIONS.includes(edition)) throw new Error(`Unknown STREAMFIREFLY_EDITION: ${edition}`);
  return edition;
}

export function editionDefine(value) {
  return { __STREAMFIREFLY_EDITION__: JSON.stringify(resolveEdition(value)) };
}
