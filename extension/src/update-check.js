import { EDITION } from './platform.js';

const LATEST_RELEASE_API = 'https://api.github.com/repos/rumoii/streamfirefly/releases/latest';
const RELEASE_PAGE_PREFIX = 'https://github.com/rumoii/streamfirefly/releases/';
export const RELEASES_URL = `${RELEASE_PAGE_PREFIX}latest`;

export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  return match ? match.slice(1).map(Number) : null;
}

export function isNewerVersion(latest, current) {
  const next = parseVersion(latest), installed = parseVersion(current);
  if (!next || !installed) return false;
  const index = next.findIndex((part, position) => part !== installed[position]);
  return index >= 0 && next[index] > installed[index];
}

function localDay(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Looks up the latest GitHub release. The Chrome Web Store edition is updated by the store and never contacts GitHub. */
export function createUpdateCheck(api, { fetch = (...args) => globalThis.fetch(...args), now = () => new Date(), timeoutMs = 8000 } = {}) {
  const enabled = EDITION !== 'chrome-store';
  const currentVersion = () => String(api.runtime.getManifest().version || '');
  let pendingAuto = null;

  async function read() {
    const stored = await api.storage.local.get(['updateState', 'autoCheckUpdates']);
    const state = stored.updateState && typeof stored.updateState === 'object' ? stored.updateState : {};
    return { state, autoCheck: stored.autoCheckUpdates !== false };
  }
  async function write(patch) {
    const { state } = await read();
    const next = { ...state, ...patch };
    await api.storage.local.set({ updateState: next });
    return next;
  }
  function view(state, { ignoreDismissed = false, notify = true } = {}) {
    const latestVersion = typeof state.latestVersion === 'string' ? state.latestVersion : '';
    const installed = currentVersion();
    const newer = enabled && isNewerVersion(latestVersion, installed);
    return { enabled, currentVersion: installed, latestVersion, releaseUrl: typeof state.releaseUrl === 'string' ? state.releaseUrl : RELEASES_URL, hasUpdate: newer && notify && (ignoreDismissed || state.dismissedVersion !== latestVersion) };
  }

  async function request() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      try { response = await fetch(LATEST_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store', credentials: 'omit', signal: controller.signal }); }
      catch { throw new Error('update_unreachable'); }
      // Rate limits (403/429) and gateway errors look the same to the user: GitHub could not be reached.
      if (!response.ok) throw new Error('update_unreachable');
      let body;
      try { body = await response.json(); } catch { throw new Error(controller.signal.aborted ? 'update_unreachable' : 'update_invalid'); }
      const latestVersion = String(body?.tag_name ?? '').trim().replace(/^v/, '');
      if (!parseVersion(latestVersion)) throw new Error('update_invalid');
      const releaseUrl = typeof body.html_url === 'string' && body.html_url.startsWith(RELEASE_PAGE_PREFIX) ? body.html_url : RELEASES_URL;
      return { latestVersion, releaseUrl, checkedAt: now().getTime() };
    } finally { clearTimeout(timer); }
  }

  async function check() {
    if (!enabled) throw new Error('update_unavailable');
    return view(await write(await request()), { ignoreDismissed: true });
  }

  /** At most one silent check per local day; failures keep the previous result and wait for the next day. */
  function auto() {
    if (!enabled) return Promise.resolve(view({}));
    pendingAuto ??= (async () => {
      const { state, autoCheck } = await read();
      if (!autoCheck) return view(state, { notify: false });
      const today = localDay(now());
      if (state.lastAutoCheckDay === today) return view(state);
      // Record the day before requesting so that a second surface opened meanwhile does not repeat the request.
      const marked = await write({ lastAutoCheckDay: today });
      try { return view(await write(await request())); } catch { return view(marked); }
    })().finally(() => { pendingAuto = null; });
    return pendingAuto;
  }

  async function dismiss(version) {
    if (!parseVersion(version)) throw new Error('update_invalid');
    return view(await write({ dismissedVersion: String(version) }));
  }

  return { check, auto, dismiss };
}
