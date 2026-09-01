const api = globalThis.browser ?? globalThis.chrome;
const parser = globalThis.StreamFireflyMediaParser;
const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tabId"));
const candidateId = params.get("id") || "";
let candidate;
let parsed;
let rawText = "";
let currentManifestUrl = "";

const $ = selector => document.querySelector(selector);
function formatDuration(value) { if (!Number.isFinite(value)) return "时长未知"; const seconds = Math.round(value); return `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}:` : ""}${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function formatBitrate(value) { return Number.isFinite(value) ? `${(value / 1000).toFixed(value >= 1000000 ? 0 : 1)} Kbps` : "码率未知"; }
function notice(text, error = false) { const node = $("#notice"); node.hidden = false; node.textContent = text; node.className = `notice${error ? " error" : ""}`; }
function summary(values) { const root = $("#summary"); root.innerHTML = ""; for (const value of values.filter(Boolean)) { const node = document.createElement("span"); node.textContent = value; root.appendChild(node); } }
function card(title, lines, action) { const node = document.createElement("article"); node.className = "card"; const heading = document.createElement("strong"); heading.textContent = title; const detail = document.createElement("div"); detail.textContent = lines.filter(Boolean).join(" · "); node.append(heading, detail); if (action) { const button = document.createElement("button"); button.type = "button"; button.textContent = "打开此清晰度"; button.addEventListener("click", action); node.appendChild(button); } return node; }

function renderHls(data) {
  summary([data.kind === "master" ? "多清晰度主清单" : data.live ? "直播清单" : "点播清单", data.duration ? formatDuration(data.duration) : null, data.variants.length ? `${data.variants.length} 个清晰度` : null, data.tracks.length ? `${data.tracks.length} 条音轨/字幕` : null, data.segments.length ? `${data.segments.length} 个切片` : null, data.keys.length ? `${data.keys.length} 个加密配置` : null]);
  const variants = $("#variants"); variants.innerHTML = "";
  for (const item of data.variants) variants.appendChild(card(item.width && item.height ? `${item.width} × ${item.height}` : "自适应清晰度", [formatBitrate(item.averageBandwidth || item.bandwidth), item.codecs], () => loadManifest(item.uri)));
  for (const item of data.tracks) variants.appendChild(card(`${item.TYPE || "轨道"} · ${item.NAME || item.LANGUAGE || "未命名"}`, [item.LANGUAGE, item.GROUP_ID, item.DEFAULT === "YES" ? "默认" : null], item.uri ? () => loadManifest(item.uri) : null));
  $("#variants-panel").hidden = !variants.children.length;
  renderSegments(data.segments);
}

function renderDash(data) {
  const representations = data.periods.flatMap(period => period.adaptations.flatMap(adaptation => adaptation.representations.map(item => ({ ...item, contentType: adaptation.contentType || adaptation.mimeType, language: adaptation.language }))));
  summary([data.live ? "动态 MPD" : "静态 MPD", data.duration ? formatDuration(data.duration) : null, `${data.periods.length} 个 Period`, `${representations.length} 条表示`, data.protections.length ? `检测到 ${data.protections.length} 个内容保护描述` : null]);
  const variants = $("#variants"); variants.innerHTML = "";
  for (const item of representations) variants.appendChild(card(`${item.contentType || item.mimeType || "轨道"}${item.width && item.height ? ` · ${item.width} × ${item.height}` : ""}`, [item.language, formatBitrate(item.bandwidth), item.codecs, item.segmentTemplate?.timelineEntries ? `${item.segmentTemplate.timelineEntries} 个时间线切片` : null]));
  $("#variants-panel").hidden = !variants.children.length;
  $("#segments-panel").hidden = true;
}

function renderSegments(items) {
  const root = $("#segments"); root.innerHTML = "";
  $("#segments-count").textContent = `${items.length} 个`;
  for (const item of items.slice(0, 1000)) { const node = document.createElement("div"); node.className = "segment"; const index = document.createElement("span"); index.textContent = `#${item.sequence}`; const duration = document.createElement("span"); duration.textContent = item.duration ? `${item.duration.toFixed(2)} 秒` : "时长未知"; const url = document.createElement("span"); url.textContent = item.uri; url.title = item.uri; node.append(index, duration, url); root.appendChild(node); }
  $("#segments-panel").hidden = !items.length;
}

async function loadManifest(url = candidate?.url) {
  notice("正在读取并解析媒体清单…");
  const response = candidate?.inlineManifest && url === candidate.url ? { ok: true, url: candidate.inlineManifest.baseUrl || candidate.url, text: candidate.inlineManifest.text } : await api.runtime.sendMessage({ type: "media.fetchText", tabId, id: candidate.id, url });
  if (!response?.ok) { notice(`读取失败：${response?.error || "unknown"}${response?.status ? ` (${response.status})` : ""}`, true); return; }
  rawText = response.text;
  currentManifestUrl = response.url || url;
  try { parsed = candidate.type === "dash" || /^\s*<\?xml|^\s*<MPD/i.test(rawText) ? parser.parseDash(rawText, response.url) : parser.parseHls(rawText, response.url); }
  catch (error) { notice(`解析失败：${error.message}`, true); return; }
  $("#notice").hidden = true;
  $("#source").hidden = false;
  $("#raw-panel").hidden = false;
  $("#format").textContent = parsed.format.toUpperCase();
  $("#title").textContent = candidate.pageTitle || candidate.title || "未命名媒体";
  $("#source-url").textContent = response.url;
  $("#raw").textContent = rawText;
  if (parsed.format === "hls") renderHls(parsed); else renderDash(parsed);
}

async function init() {
  if (!Number.isInteger(tabId)) { notice("缺少来源页面标识，请从流萤侧边栏打开媒体工作台。", true); return; }
  const result = await api.runtime.sendMessage({ type: "media.candidate.get", tabId, id: candidateId });
  if (!result?.ok) { notice(`资源读取失败：${result?.error || "unknown"}`, true); return; }
  candidate = Array.isArray(result.candidate) ? result.candidate[0] : result.candidate;
  if (!candidate) { notice("当前页面没有可解析的 HLS 或 DASH 资源。", true); return; }
  await loadManifest(candidate.url);
}

$("#reload").addEventListener("click", () => loadManifest(candidate?.url));
$("#download").addEventListener("click", async () => {
  const url = currentManifestUrl || candidate.url;
  const usesOriginalInlineManifest = Boolean(candidate.inlineManifest && url === candidate.url);
  const result = await api.runtime.sendMessage({ type: "task.create", payload: { url, title: candidate.title || candidate.pageTitle || "streamfirefly-media", mime: parsed?.format === "dash" ? "application/dash+xml" : parsed?.format === "hls" ? "application/vnd.apple.mpegurl" : candidate.mime, referer: candidate.referer || candidate.pageUrl, requestHeaders: candidate.requestHeaders || {}, inlineManifest: usesOriginalInlineManifest ? candidate.inlineManifest : null } });
  notice(result?.ok ? "当前清单下载任务已创建，可回到侧边栏查看进度。" : `创建任务失败：${result?.error || "unknown"}`, !result?.ok);
});
init().catch(error => notice(`工作台启动失败：${error.message}`, true));
