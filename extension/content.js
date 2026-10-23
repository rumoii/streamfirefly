(() => {
  const api = globalThis.browser ?? globalThis.chrome;
  const documentToken = crypto.randomUUID();
  const seen = new Set();
  const bound = new WeakSet();
  let active = false;
  let installing = true;
  let revision = 0;
  let pending = [];
  const pagePoster = () => { const value = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]')?.content; if (!value) return null; try { return new URL(value, location.href).href; } catch (_) { return value; } };
  const report = (element, force = false) => {
    if (!active) return;
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
  // Manifests requested before sniffing started survive only in the page's resource timeline.
  const timedMedia = /\.(?:m3u8?|mpd|mp4|webm|mov|mkv|flv|f4v|m4v|mp3|m4a|aac|wav|flac|ogg|opus|weba)(?:$|[?#&])/i;
  const withoutHash = value => String(value).split("#", 1)[0];
  const reportedTimings = new Set();
  let timingUrl = withoutHash(location.href);
  let timingFloor = 0;
  let navigationStartedAt = null;
  // Same-document navigations keep the old page's entries; only requests after the latest one belong to this page.
  try { globalThis.navigation?.addEventListener?.("navigate", event => { if (!event.hashChange) navigationStartedAt = performance.now(); }); } catch (_) {}
  const reportTimedResources = () => {
    if (withoutHash(location.href) !== timingUrl) {
      timingUrl = withoutHash(location.href);
      timingFloor = navigationStartedAt ?? performance.now();
    }
    let entries = [];
    try { entries = performance.getEntriesByType("resource"); } catch (_) { return; }
    let sent = 0;
    for (const entry of entries) {
      const url = entry.name;
      if (sent >= 200) break;
      if (entry.startTime < timingFloor || !/^https?:/i.test(url) || reportedTimings.has(`${url}|${entry.startTime}`) || !timedMedia.test(url)) continue;
      reportedTimings.add(`${url}|${entry.startTime}`);
      sent += 1;
      api.runtime.sendMessage({ type: "media.add", candidate: { url, mime: "", title: document.title, pageTitle: document.title, pageUrl: location.href, source: "timing" } }).catch?.(() => {});
    }
  };
  const scan = () => document.querySelectorAll("video, audio, source").forEach(element => {
    if (!active) return;
    report(element);
    const media = element.tagName === "SOURCE" ? element.parentElement : element;
    if (media && !bound.has(media) && (media.tagName === "VIDEO" || media.tagName === "AUDIO")) {
      bound.add(media);
      media.addEventListener("loadedmetadata", () => report(media, true), { once: true });
    }
  });
  // The video the user is watching: one that keeps playing for a moment while mostly on screen.
  // Only a settled play changes it, so scrolling past autoplaying previews does not reorder the list.
  let focusTimer = 0;
  let focusedUrl = "";
  const visibleArea = video => {
    const rect = video.getBoundingClientRect();
    const width = Math.min(rect.right, innerWidth) - Math.max(rect.left, 0);
    const height = Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0);
    const mostlyVisible = rect.width >= 160 && rect.height >= 90 && width > 0 && height > 0 && width * height >= rect.width * rect.height * 0.5;
    return mostlyVisible ? width * height : 0;
  };
  const focusable = video => video?.tagName === "VIDEO" && !video.paused && !video.ended && Boolean(video.currentSrc || video.src) && visibleArea(video) > 0;
  const reportFocus = video => {
    const url = video.currentSrc || video.src;
    if (!active || url === focusedUrl) return;
    const send = () => {
      if (!active || url === focusedUrl) return;
      focusedUrl = url;
      api.runtime.sendMessage({ type: "media.focus", focus: { url, poster: video.poster || null, duration: Number.isFinite(video.duration) ? video.duration : null } }).catch?.(() => {});
    };
    if (window === window.top) { send(); return; }
    // A frame only knows its own viewport; the observer's default root is the top-level page, so an
    // off-screen embed (often an autoplaying ad) cannot take the focus from the video the user watches.
    const observer = new IntersectionObserver(entries => {
      observer.disconnect();
      if ((entries[0]?.intersectionRatio || 0) >= 0.5) send();
    });
    observer.observe(video);
  };
  // StreamFirefly is often opened while a video is already playing; that video is the focus right away.
  const focusPlayingVideo = () => {
    const playing = [...document.querySelectorAll("video")].filter(focusable).sort((a, b) => visibleArea(b) - visibleArea(a))[0];
    if (playing) reportFocus(playing);
  };
  document.addEventListener("playing", event => {
    const video = event.target;
    // An off-screen player starting must not cancel a visible one that is still settling.
    if (!active || !focusable(video)) return;
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => { if (active && focusable(video)) reportFocus(video); }, 1500);
  }, true);
  // The media picker works like the browser's element inspector: the user clicks a video, audio or image
  // and the resource list pins it with its other resolutions. Each frame picks inside its own document.
  const pickableTags = new Set(["VIDEO", "AUDIO", "IMG"]);
  const swallowedEvents = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"];
  let picker = null;
  // A pick sent while the probe is still installing starts as soon as the document is ready.
  let pendingPickId = null;
  // Capture listeners are installed once at document_start, ahead of every page script, so a page hook
  // or stopImmediatePropagation cannot take picking away; they idle until a pick is running.
  for (const type of ["pointermove", "scroll", "keydown", ...swallowedEvents]) window.addEventListener(type, event => { picker?.handlers.get(event.type)?.(event); }, true);
  // Players often cover the video with a control layer, so the whole stack at the point is searched,
  // including open shadow roots; a video that ignores pointer events is still found by its box.
  const mediaAt = (x, y) => {
    const stack = document.elementsFromPoint?.(x, y) || [];
    // Only the host the workspace registered shields what lies under it; a page copy of its id does not.
    if (globalThis.__streamFireflyWorkspaceHost && stack[0] === globalThis.__streamFireflyWorkspaceHost) return null;
    const seen = new Set();
    const search = (elements, depth) => {
      for (const element of elements) {
        if (seen.has(element)) continue;
        seen.add(element);
        if (pickableTags.has(element.tagName)) return element;
        if (element.shadowRoot && depth < 4) { const found = search(element.shadowRoot.elementsFromPoint?.(x, y) || [], depth + 1); if (found) return found; }
      }
      return null;
    };
    return search(stack, 0) || [...document.querySelectorAll("video")].find(video => { const rect = video.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom; }) || null;
  };
  const mediaSize = element => ({ width: element.videoWidth || element.naturalWidth || null, height: element.videoHeight || element.naturalHeight || null });
  const clock = seconds => { const whole = Math.round(seconds), hours = Math.floor(whole / 3600), rest = `${String(Math.floor(whole / 60) % 60).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`; return hours ? `${hours}:${rest}` : rest; };
  const pickLabel = element => {
    const { width, height } = mediaSize(element);
    const duration = element.duration === Infinity ? "直播" : Number.isFinite(element.duration) && element.duration > 0 ? clock(element.duration) : "";
    return [element.tagName.toLowerCase(), [width && height ? `${width}×${height}` : "", duration].filter(Boolean).join(" · ")];
  };
  const pickOf = element => {
    const urls = [];
    const add = value => {
      if (typeof value !== "string" || !value.trim() || urls.length >= 32) return;
      let url;
      try { url = new URL(value.trim(), document.baseURI).href; } catch (_) { return; }
      if (/^(?:https?|blob):/i.test(url) && url.length <= 4096 && !urls.includes(url)) urls.push(url);
    };
    // Parse srcset like HTML does: skip whitespace and commas, the URL runs to the next whitespace,
    // a trailing comma ends the candidate, otherwise descriptors run to the next comma outside parentheses.
    const addSrcset = value => {
      const input = String(value || "");
      let i = 0;
      while (i < input.length) {
        while (i < input.length && /[\s,]/.test(input[i])) i += 1;
        const start = i;
        while (i < input.length && !/\s/.test(input[i])) i += 1;
        const url = input.slice(start, i);
        if (/,$/.test(url)) { add(url.replace(/,+$/, "")); continue; }
        let parens = 0;
        while (i < input.length && (input[i] !== "," || parens > 0)) { if (input[i] === "(") parens += 1; else if (input[i] === ")") parens -= 1; i += 1; }
        i += 1;
        add(url);
      }
    };
    add(element.currentSrc);
    add(element.src);
    if (element.tagName === "IMG") {
      addSrcset(element.srcset);
      if (element.parentElement?.tagName === "PICTURE") element.parentElement.querySelectorAll("source").forEach(source => addSrcset(source.srcset));
    } else element.querySelectorAll("source").forEach(source => add(source.src));
    const kind = element.tagName === "IMG" ? "image" : element.tagName === "AUDIO" ? "audio" : "video";
    return { kind, urls, poster: kind === "video" ? element.poster || null : null, duration: Number.isFinite(element.duration) && element.duration > 0 ? element.duration : null, ...mediaSize(element) };
  };
  function stopPicker() {
    if (!picker) return;
    const { host, cursor } = picker;
    picker = null;
    host.remove();
    cursor.remove();
  }
  function startPicker(pickId) {
    stopPicker();
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>:host{all:initial;position:fixed;inset:0;z-index:2147483645;pointer-events:none}.box{position:fixed;display:none;box-sizing:border-box;border:2px solid #2a8b76;border-radius:3px;background:rgba(42,139,118,.2)}.label{position:fixed;display:none;padding:3px 7px;border-radius:4px;background:#2a8b76;color:#fff;font:600 11px/1.4 "Segoe UI",system-ui,sans-serif;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.25)}.label span{font-weight:400;opacity:.85;margin-left:6px}</style><div class="box"></div><div class="label"></div>`;
    const box = shadow.querySelector(".box"), label = shadow.querySelector(".label");
    // The crosshair must win over the page's own cursors, which only a page-level rule can do.
    const cursor = document.createElement("style");
    cursor.textContent = "*,*::before,*::after{cursor:crosshair!important}";
    let point = null;
    const highlight = () => {
      const element = point && mediaAt(point.x, point.y);
      if (!element) { box.style.display = label.style.display = "none"; return; }
      const rect = element.getBoundingClientRect();
      Object.assign(box.style, { display: "block", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      const [tag, detail] = pickLabel(element);
      label.textContent = tag;
      if (detail) { const span = document.createElement("span"); span.textContent = detail; label.append(span); }
      Object.assign(label.style, { display: "block", left: `${Math.max(4, rect.left)}px`, top: `${rect.top > 30 ? rect.top - 26 : Math.min(rect.bottom + 6, innerHeight - 26)}px` });
    };
    const finish = element => {
      stopPicker();
      api.runtime.sendMessage({ type: "media.pick.result", pickId, pick: pickOf(element) }).catch?.(() => {});
    };
    // Clicks on the page are swallowed so picking does not pause the video or follow a link; the panel stays usable.
    const swallow = event => {
      // Synthetic events go back to the page untouched; only the user's own clicks pick.
      if (!event.isTrusted) return;
      if (globalThis.__streamFireflyWorkspaceHost && event.target === globalThis.__streamFireflyWorkspaceHost) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.type !== "click") return;
      const element = mediaAt(event.clientX, event.clientY);
      if (element) finish(element);
    };
    const handlers = new Map([
      ["pointermove", event => { if (!event.isTrusted) return; point ={ x: event.clientX, y: event.clientY }; highlight(); }],
      ["scroll", highlight],
      ["keydown", event => {
        if (!event.isTrusted) return;
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopImmediatePropagation();
        stopPicker();
        api.runtime.sendMessage({ type: "media.pick.cancel", pickId }).catch?.(() => {});
      }],
      ...swallowedEvents.map(type => [type, swallow])
    ]);
    document.documentElement.append(host, cursor);
    picker = { host, cursor, handlers };
  }
  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== "streamfirefly") return;
    const message = event.data.type === "key" ? { type: "deep.key.add", payload: { hex: event.data.hex, source: event.data.foundBy, documentToken } } : event.data.type === "media" ? { type: "media.add", candidate: event.data.candidate } : null;
    if (!message) return;
    if (active) api.runtime.sendMessage(message).catch?.(() => {});
    else if (installing && pending.length < 1000) pending.push(message);
  });
  api.runtime.onMessage?.addListener((message, _sender, respond) => {
    if (message?.type === "probe.identity") { respond({ documentToken }); return false; }
    if (message?.type === "media.sniffing.control") { void setActive(Boolean(message.active)); respond({ ok: true }); return false; }
    if (message?.type === "media.rescan") { if (active) { seen.clear(); focusedUrl = ""; scan(); focusPlayingVideo(); } return { ok: true }; }
    if (message?.type === "media.pick.control") { if (message.active && typeof message.pickId === "string") { if (active) startPicker(message.pickId); else if (installing) pendingPickId = message.pickId; } else { stopPicker(); pendingPickId = null; } respond({ ok: true }); return false; }
    if (window !== window.top) return false;
    if (message?.type === "workspace.unmount") {
      window.dispatchEvent(new CustomEvent("streamfirefly-workspace-unmount"));
      return { ok: true };
    }
    if (message?.type === "workspace.navigate") {
      window.dispatchEvent(new CustomEvent("streamfirefly-workspace-navigate", { detail: { view: message.view, candidateId: message.candidateId || "", displayMode: message.displayMode || "workspace", attemptId: message.attemptId } }));
      return { ok: true };
    }
    return false;
  });
  const observer = new MutationObserver(scan);
  function activate() {
    active = true;
    installing = false;
    const buffered = pending;
    pending = [];
    for (const message of buffered) api.runtime.sendMessage(message).catch?.(() => {});
    seen.clear();
    focusedUrl = "";
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scan();
    focusPlayingVideo();
    reportTimedResources();
    if (pendingPickId) { const pickId = pendingPickId; pendingPickId = null; startPicker(pickId); }
  }
  async function setActive(next) {
    const current = ++revision;
    if (!next) { active = false; installing = false; pending = []; pendingPickId = null; observer.disconnect(); stopPicker(); return; }
    installing = true;
    // Concurrent installation requests share this document's buffered discoveries.
    const result = await api.runtime.sendMessage({ type: "probe.install", documentToken }).catch(() => null);
    if (current !== revision) return;
    if (!result?.ok || !result.active) { installing = false; pending = []; pendingPickId = null; return; }
    activate();
  }
  api.runtime.sendMessage({ type: "probe.install", documentToken }).then(result => { if (revision !== 0) return; if (result?.ok && result.active) activate(); else { installing = false; pending = []; pendingPickId = null; } }).catch(() => { installing = false; pending = []; pendingPickId = null; });
})();
