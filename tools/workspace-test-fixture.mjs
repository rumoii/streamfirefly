let registered = false;

// Local UI fixtures execute the bundle in their own page world. Capture its real closed
// root at construction so Playwright can drive it without any production test hooks.
export async function workspaceFixturePage(page, selectors) {
  if (!registered) {
    await selectors.register('sf-workspace', () => ({
      query(_root, selector) { return globalThis.__sfTestWorkspaceRoot?.querySelector(selector) || null; },
      queryAll(_root, selector) { return Array.from(globalThis.__sfTestWorkspaceRoot?.querySelectorAll(selector) || []); }
    }), { contentScript: false });
    registered = true;
  }
  await page.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const root = attach.call(this, options);
      if (this.id === 'streamfirefly-workspace-host') globalThis.__sfTestWorkspaceRoot = root;
      return root;
    };
  });
  const root = page.locator('sf-workspace=#app');
  return new Proxy(page, { get(target, name) {
    if (name === 'hostPage') return target;
    const owner = name === 'locator' || String(name).startsWith('getBy') ? root : target;
    const value = owner[name];
    return typeof value === 'function' ? value.bind(owner) : value;
  } });
}
