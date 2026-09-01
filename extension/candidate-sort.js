(() => {
  const typeGroups = [
    { key: "video", label: "视频", types: new Set(["video", "hls", "dash"]) },
    { key: "audio", label: "音频", types: new Set(["audio"]) },
    { key: "image", label: "图片", types: new Set(["image"]) },
    { key: "segment", label: "分片", types: new Set(["segment"]) }
  ];

  function detectedValue(item) {
    const value = Number(item?.detectedAt);
    return Number.isFinite(value) ? value : 0;
  }

  function sizeValue(item) {
    if (item?.sizeKind === "manifest") return null;
    const value = Number(item?.size);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  function compareDetected(a, b) {
    return detectedValue(b) - detectedValue(a);
  }

  function compareCandidates(a, b, mode = "detected") {
    if (mode === "size") {
      const aSize = sizeValue(a);
      const bSize = sizeValue(b);
      if (aSize == null && bSize != null) return 1;
      if (aSize != null && bSize == null) return -1;
      if (aSize != null && bSize != null && aSize !== bSize) return bSize - aSize;
    }
    if (mode === "duration") {
      const aDuration = Number.isFinite(Number(a?.duration)) && Number(a.duration) > 0 ? Number(a.duration) : null;
      const bDuration = Number.isFinite(Number(b?.duration)) && Number(b.duration) > 0 ? Number(b.duration) : null;
      if (aDuration == null && bDuration != null) return 1;
      if (aDuration != null && bDuration == null) return -1;
      if (aDuration != null && bDuration != null && aDuration !== bDuration) return bDuration - aDuration;
    }
    return compareDetected(a, b);
  }

  function sortCandidates(items, mode = "detected") {
    return [...items].sort((a, b) => compareCandidates(a, b, mode));
  }

  function groupCandidates(items) {
    return typeGroups.map(group => ({
      key: group.key,
      label: group.label,
      items: sortCandidates(items.filter(item => group.types.has(item.type)), "detected")
    })).filter(group => group.items.length);
  }

  function filterCandidates(items, criteria = {}) {
    const pattern = String(criteria.pattern || "").trim();
    const type = String(criteria.type || "all");
    const minBytes = Number.isFinite(criteria.minBytes) && criteria.minBytes > 0 ? criteria.minBytes : null;
    const maxBytes = Number.isFinite(criteria.maxBytes) && criteria.maxBytes > 0 ? criteria.maxBytes : null;
    const active = Boolean(pattern || type !== "all" || minBytes != null || maxBytes != null);
    if (minBytes != null && maxBytes != null && minBytes > maxBytes) {
      return { items: [], active: true, error: "最大文件大小不能小于最小文件大小" };
    }
    let regex = null;
    if (pattern) {
      try { regex = new RegExp(pattern, "i"); }
      catch (error) { return { items: [], active: true, error: `正则表达式无效：${error.message}` }; }
    }
    const filtered = items.filter(item => {
      if (regex && !regex.test([item?.title, item?.pageTitle, item?.url, item?.mime].filter(Boolean).join("\n"))) return false;
      if (type !== "all") {
        if (type === "video" && !["video", "hls", "dash"].includes(item?.type)) return false;
        if (type !== "video" && item?.type !== type) return false;
      }
      const size = sizeValue(item);
      if (minBytes != null && (size == null || size < minBytes)) return false;
      if (maxBytes != null && (size == null || size > maxBytes)) return false;
      return true;
    });
    return { items: filtered, active, error: "" };
  }

  globalThis.StreamFireflyCandidateSort = { sortCandidates, groupCandidates, filterCandidates, sizeValue };
})();
