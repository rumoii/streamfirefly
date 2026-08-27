(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const seen = new Set();
  const report = element => {
    const url = element.currentSrc || element.src;
    if (!url || seen.has(url)) return;
    seen.add(url);
    api.runtime.sendMessage({ type: "media.add", candidate: {
      url,
      mime: element.getAttribute("type") || (element.tagName === "VIDEO" ? "video/unknown" : "audio/unknown"),
      title: document.title,
      source: "dom"
    }}).catch?.(() => {});
  };
  const scan = () => document.querySelectorAll("video, audio, source").forEach(report);
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
})();
