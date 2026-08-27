(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const seen = new Set();
  const bound = new WeakSet();
  const report = (element, force = false) => {
    const url = element.currentSrc || element.src;
    if (!url || (!force && seen.has(url))) return;
    seen.add(url);
    const isVideo = element.tagName === "VIDEO";
    api.runtime.sendMessage({ type: "media.add", candidate: {
      url,
      mime: element.getAttribute("type") || (isVideo ? "video/unknown" : "audio/unknown"),
      title: document.title,
      pageTitle: document.title,
      pageUrl: location.href,
      faviconUrl: document.querySelector('link[rel~="icon"]')?.href || `${location.origin}/favicon.ico`,
      poster: isVideo ? element.poster || null : null,
      width: isVideo ? element.videoWidth || null : null,
      height: isVideo ? element.videoHeight || null : null,
      duration: Number.isFinite(element.duration) ? element.duration : null,
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
    if (event.source !== window || event.data?.source !== "streamfirefly" || event.data.type !== "media") return;
    api.runtime.sendMessage({ type: "media.add", candidate: event.data.candidate }).catch?.(() => {});
  });
  api.runtime.sendMessage({ type: "probe.install" }).catch?.(() => {});
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
