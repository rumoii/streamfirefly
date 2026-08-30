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

  globalThis.StreamFireflyCandidateSort = { sortCandidates, groupCandidates, sizeValue };
})();
