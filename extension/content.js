(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const documentToken = crypto.randomUUID();
  const seen = new Set();
  const bound = new WeakSet();
  const pagePoster = () => { const value = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.content; if (!value) return null; try { return new URL(value, location.href).href; } catch (_) { return value; } };
  const report = (element, force = false) => {
    const url = element.currentSrc || element.src;
    if (!url || (!force && seen.has(url))) return;
    seen.add(url);
    const media = element.tagName === "SOURCE" ? element.parentElement : element;
    const isVideo = media?.tagName === "VIDEO";
    api.runtime.sendMessage({ type: "media.add", candidate: {
      url,
      mime: element.getAttribute("type") || media?.getAttribute("type") || (isVideo ? "video/unknown" : "audio/unknown"),
      title: document.title,
      pageTitle: document.title,
      pageUrl: location.href,
      faviconUrl: document.querySelector('link[rel~="icon"]')?.href || `${location.origin}/favicon.ico`,
      poster: isVideo ? media.poster || pagePoster() : null,
      width: isVideo ? media.videoWidth || null : null,
      height: isVideo ? media.videoHeight || null : null,
      duration: Number.isFinite(media?.duration) ? media.duration : null,
      source: "dom"
    }}).catch?.(() => {});
  };
  const scan = () => document.querySelectorAll("video, audio, source").forEach(element => {
    report(element);
    const media = element.tagName === "SOURCE" ? element.parentElement : element;
    if (media && !bound.has(media) && (media.tagName === "VIDEO" || media.tagName === "AUDIO")) {
      bound.add(media);
      media.addEventListener("loadedmetadata", () => report(media, true), { once: true });
    }
  });
  window.addEventListener("message", event => {
    if (event.source === window && event.data?.source === "streamfirefly" && event.data.type === "key") { api.runtime.sendMessage({ type: "deep.key.add", payload: { hex: event.data.hex, source: event.data.foundBy, documentToken } }).catch?.(() => {}); return; }
    if (event.source !== window || event.data?.source !== "streamfirefly" || event.data.type !== "media") return;
    api.runtime.sendMessage({ type: "media.add", candidate: event.data.candidate }).catch?.(() => {});
  });
  api.runtime.onMessage?.addListener((message, _sender, respond) => {
    if (message?.type === "probe.identity") { respond({ documentToken }); return false; }
    if (message?.type === "media.rescan") { seen.clear(); scan(); return { ok: true }; }
    if (window !== window.top) return false;
    if (message?.type === "workspace.unmount") {
      window.dispatchEvent(new CustomEvent("streamfirefly-workspace-unmount"));
      return { ok: true };
    }
    if (message?.type === "workspace.navigate") {
      window.dispatchEvent(new CustomEvent("streamfirefly-workspace-navigate", { detail: { view: message.view, candidateId: message.candidateId || "" } }));
      return { ok: true };
    }
    return false;
  });
  api.runtime.sendMessage({ type: "probe.install", documentToken }).catch?.(() => {});
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
