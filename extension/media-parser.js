(() => {
  function attributes(value = "") {
    const result = {};
    const pattern = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi;
    for (const match of value.matchAll(pattern)) result[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, "");
    return result;
  }

  function absolute(value, baseUrl) {
    try { return new URL(value, baseUrl).href; } catch (_) { return value; }
  }

  function parseHls(text, baseUrl) {
    const lines = String(text || "").replace(/\r/g, "").split("\n").map(line => line.trim()).filter(Boolean);
    if (lines[0] !== "#EXTM3U") throw new Error("不是有效的 M3U8 清单");
    const variants = [];
    const tracks = [];
    const segments = [];
    const keys = [];
    let pendingVariant = null;
    let pendingDuration = null;
    let pendingByteRange = null;
    let currentKey = null;
    let initSegment = null;
    let discontinuity = false;
    let totalDuration = 0;
    let mediaSequence = 0;
    let targetDuration = null;
    let endList = false;
    for (const line of lines) {
      if (line.startsWith("#EXT-X-STREAM-INF:")) { pendingVariant = attributes(line.slice(line.indexOf(":") + 1)); continue; }
      if (line.startsWith("#EXT-X-MEDIA:")) { const item = attributes(line.slice(line.indexOf(":") + 1)); tracks.push({ ...item, uri: item.URI ? absolute(item.URI, baseUrl) : null }); continue; }
      if (line.startsWith("#EXTINF:")) { pendingDuration = Number.parseFloat(line.slice(8).split(",", 1)[0]); continue; }
      if (line.startsWith("#EXT-X-BYTERANGE:")) { pendingByteRange = line.slice(line.indexOf(":") + 1); continue; }
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) { mediaSequence = Number.parseInt(line.slice(line.indexOf(":") + 1), 10) || 0; continue; }
      if (line.startsWith("#EXT-X-TARGETDURATION:")) { targetDuration = Number.parseFloat(line.slice(line.indexOf(":") + 1)); continue; }
      if (line.startsWith("#EXT-X-KEY:")) { const item = attributes(line.slice(line.indexOf(":") + 1)); currentKey = { ...item, uri: item.URI ? absolute(item.URI, baseUrl) : null }; keys.push(currentKey); continue; }
      if (line.startsWith("#EXT-X-MAP:")) { const item = attributes(line.slice(line.indexOf(":") + 1)); initSegment = { ...item, uri: item.URI ? absolute(item.URI, baseUrl) : null }; continue; }
      if (line === "#EXT-X-DISCONTINUITY") { discontinuity = true; continue; }
      if (line === "#EXT-X-ENDLIST") { endList = true; continue; }
      if (line.startsWith("#")) continue;
      if (pendingVariant) {
        const resolution = pendingVariant.RESOLUTION?.split("x").map(Number) || [];
        variants.push({ uri: absolute(line, baseUrl), bandwidth: Number(pendingVariant.BANDWIDTH) || null, averageBandwidth: Number(pendingVariant["AVERAGE-BANDWIDTH"]) || null, codecs: pendingVariant.CODECS || null, width: resolution[0] || null, height: resolution[1] || null, frameRate: Number(pendingVariant["FRAME-RATE"]) || null, audioGroup: pendingVariant.AUDIO || null, subtitlesGroup: pendingVariant.SUBTITLES || null });
        pendingVariant = null;
        continue;
      }
      const duration = Number.isFinite(pendingDuration) ? pendingDuration : null;
      segments.push({ index: segments.length, sequence: mediaSequence + segments.length, uri: absolute(line, baseUrl), duration, byteRange: pendingByteRange, key: currentKey, initSegment, discontinuity });
      if (duration) totalDuration += duration;
      pendingDuration = null;
      pendingByteRange = null;
      discontinuity = false;
    }
    return { format: "hls", kind: variants.length ? "master" : "media", live: !endList && !variants.length, targetDuration, duration: totalDuration || null, variants, tracks, segments, keys: [...new Map(keys.map(key => [`${key.METHOD}|${key.uri}|${key.IV}`, key])).values()] };
  }

  function isoDuration(value) {
    const match = String(value || "").match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
    if (!match) return null;
    return (Number(match[1]) || 0) * 86400 + (Number(match[2]) || 0) * 3600 + (Number(match[3]) || 0) * 60 + (Number(match[4]) || 0);
  }

  function directChildren(node, localName) { return [...(node?.children || [])].filter(child => child.localName === localName); }
  function directChild(node, localName) { return directChildren(node, localName)[0] || null; }
  function descendants(node, localName) { return [...(node?.getElementsByTagNameNS?.("*", localName) || [])]; }

  function parseDash(text, baseUrl) {
    const documentNode = new DOMParser().parseFromString(String(text || ""), "application/xml");
    const parserError = documentNode.querySelector("parsererror");
    if (parserError) throw new Error("MPD XML 解析失败");
    const mpd = documentNode.documentElement;
    if (mpd.localName !== "MPD") throw new Error("不是有效的 MPD 清单");
    const rootBase = absolute(directChild(mpd, "BaseURL")?.textContent?.trim() || "", baseUrl);
    const periods = directChildren(mpd, "Period").map((period, periodIndex) => {
      const periodBase = absolute(directChild(period, "BaseURL")?.textContent?.trim() || "", rootBase || baseUrl);
      const adaptations = directChildren(period, "AdaptationSet").map((adaptation, adaptationIndex) => {
        const adaptationBase = absolute(directChild(adaptation, "BaseURL")?.textContent?.trim() || "", periodBase || baseUrl);
        const template = directChild(adaptation, "SegmentTemplate");
        const representations = directChildren(adaptation, "Representation").map((representation, representationIndex) => {
          const ownTemplate = directChild(representation, "SegmentTemplate") || template;
          const timeline = ownTemplate ? directChild(ownTemplate, "SegmentTimeline") : null;
          const timelineEntries = timeline ? directChildren(timeline, "S").reduce((count, item) => count + Math.max(1, (Number(item.getAttribute("r")) || 0) + 1), 0) : 0;
          return { id: representation.getAttribute("id") || `${periodIndex}-${adaptationIndex}-${representationIndex}`, bandwidth: Number(representation.getAttribute("bandwidth")) || null, codecs: representation.getAttribute("codecs") || adaptation.getAttribute("codecs") || null, mimeType: representation.getAttribute("mimeType") || adaptation.getAttribute("mimeType") || null, width: Number(representation.getAttribute("width")) || null, height: Number(representation.getAttribute("height")) || null, frameRate: representation.getAttribute("frameRate") || null, audioSamplingRate: representation.getAttribute("audioSamplingRate") || null, baseUrl: absolute(directChild(representation, "BaseURL")?.textContent?.trim() || "", adaptationBase || baseUrl), segmentTemplate: ownTemplate ? { media: ownTemplate.getAttribute("media"), initialization: ownTemplate.getAttribute("initialization"), timescale: Number(ownTemplate.getAttribute("timescale")) || 1, duration: Number(ownTemplate.getAttribute("duration")) || null, startNumber: Number(ownTemplate.getAttribute("startNumber")) || 1, timelineEntries } : null };
        });
        return { id: adaptation.getAttribute("id") || `${periodIndex}-${adaptationIndex}`, contentType: adaptation.getAttribute("contentType") || null, mimeType: adaptation.getAttribute("mimeType") || null, language: adaptation.getAttribute("lang") || null, representations };
      });
      return { id: period.getAttribute("id") || String(periodIndex + 1), start: isoDuration(period.getAttribute("start")), duration: isoDuration(period.getAttribute("duration")), adaptations };
    });
    const protections = descendants(mpd, "ContentProtection").map(node => ({ scheme: node.getAttribute("schemeIdUri"), value: node.getAttribute("value") })).filter(item => item.scheme);
    return { format: "dash", kind: mpd.getAttribute("type") || "static", live: mpd.getAttribute("type") === "dynamic", duration: isoDuration(mpd.getAttribute("mediaPresentationDuration")), minimumUpdatePeriod: isoDuration(mpd.getAttribute("minimumUpdatePeriod")), periods, protections };
  }

  globalThis.StreamFireflyMediaParser = { parseHls, parseDash, attributes, isoDuration };
})();
