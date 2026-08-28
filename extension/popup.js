const api = globalThis.browser ?? globalThis.chrome;
const $ = selector => document.querySelector(selector);
const creating = new Set();
let tabId;
let taskTimer;
let currentTasks = [];
let tasksOpen = false;
let tasksManuallyToggled = false;
let pendingDownload;
let pendingDelete;
let pendingDeleteMode = null;
let activePreview;
let previewObserver;

async function currentTab() { const tabs = await api.tabs.query({ active: true, currentWindow: true }); return tabs[0]; }
function formatBytes(value) { if (value == null) return "大小未知"; const units = ["B", "KB", "MB", "GB"]; let size = Number(value); let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; } return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`; }
function formatDuration(value) { if (!Number.isFinite(value)) return "未知"; const seconds = Math.round(value); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function sourceLabel(source) { return source === "dom" ? "页面元素" : source === "network" ? "网络响应" : "页面脚本"; }
function isActiveTask(task) { return ["queued", "starting", "running", "cancelling"].includes(task.state); }
function stateLabel(task) { const running = task.phase === "fetching" ? "读取清单" : task.phase === "merging" ? "下载并合并" : "正在下载"; return ({ queued: "等待下载", starting: "正在连接", running, cancelling: "正在取消", cancelled: "已取消", succeeded: "已完成", failed: "下载失败", interrupted: "已中断" })[task.state] || task.message || task.state; }
function taskPayload(item, downloadThreads = 6) { return { url: item.url, title: item.title || item.pageTitle || "streamfirefly-download", mime: item.mime || null, contentDisposition: item.contentDisposition || null, referer: item.referer || item.pageUrl || null, requestHeaders: item.requestHeaders || {}, downloadThreads }; }
function closeDialog(id) { $(id).hidden = true; }
function validateFileName(value) { const trimmed = value.trim().replace(/[. ]+$/g, ""); if (!trimmed) return "请输入文件名称"; if (/[<>:\"/\\|?*\u0000-\u001f]/.test(trimmed)) return "文件名不能包含 Windows 非法字符"; return ""; }
function updateDownloadValidation() { const error = validateFileName($("#download-name").value); $("#download-name-error").textContent = error; $("#download-confirm").disabled = Boolean(error); return error; }
function deleteErrorLabel(error) { return ({ task_not_found: "任务不存在或已被删除", cancel_failed: "无法停止下载进程，任务和文件均已保留", file_delete_failed: "本地文件删除失败，请检查文件是否被占用", file_delete_unsafe: "目标不是可安全删除的普通文件" })[error] || error || "unknown"; }
function detailRow(label, value) { const row = document.createElement("div"); row.className = "detail-row"; const name = document.createElement("span"); name.textContent = label; const content = document.createElement("span"); content.textContent = value || "未知"; content.title = value || "未知"; row.append(name, content); row.valueNode = content; return row; }
function hasPreviewHeaders(item) { return Boolean(item.requestHeaders && Object.values(item.requestHeaders).some(Boolean)); }
async function previewMessage(type, payload = {}) { if (!api?.runtime?.sendMessage) return { ok: true }; try { return await api.runtime.sendMessage({ type, payload }); } catch (_) { return { ok: false }; } }
async function applyPreviewHeaders(item) { if (!hasPreviewHeaders(item)) { await previewMessage("preview.headers.clear"); return; } await previewMessage("preview.headers.apply", { url: item.url, headers: item.requestHeaders }); }
async function clearPreviewHeaders() { await previewMessage("preview.headers.clear"); }

function setPreviewError(state, text) {
  state.failed = true;
  state.playing = false;
  if (activePreview === state) activePreview = null;
  state.media?.pause();
  if (state.media) { state.media.controls = false; state.media.muted = true; }
  state.container.classList.add("preview-failed");
  state.container.classList.remove("preview-ready", "preview-playing");
  state.status.textContent = text || "无法预览，可继续下载";
  state.overlay.hidden = false;
  state.overlay.querySelector("span:last-child").textContent = "重试播放";
  void clearPreviewHeaders();
}

function updatePreviewMetadata(state) {
  const media = state.media;
  if (!media) return;
  if (Number.isFinite(media.duration) && media.duration !== Infinity) state.item.duration = media.duration;
  if (media.videoWidth && media.videoHeight) { state.item.width = media.videoWidth; state.item.height = media.videoHeight; }
  state.refreshMetadata();
}

function destroyHls(state) {
  if (!state.hls) return;
  state.hls.destroy();
  state.hls = null;
}

function initializeHls(state, autoplay = false) {
  if (!globalThis.Hls?.isSupported?.()) { setPreviewError(state, "当前浏览器不支持 HLS 预览"); return; }
  destroyHls(state);
  const hls = new globalThis.Hls({ enableWorker: false });
  state.hls = hls;
  state.failed = false;
  hls.on(globalThis.Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(state.item.url));
  hls.on(globalThis.Hls.Events.MANIFEST_PARSED, () => { if (autoplay) state.media.play().catch(() => setPreviewError(state, "浏览器阻止了视频播放，请重试")); });
  hls.on(globalThis.Hls.Events.ERROR, (_event, data) => { if (data?.fatal) { destroyHls(state); setPreviewError(state, "HLS 预览加载失败，可继续下载"); } });
  hls.attachMedia(state.media);
}

function preparePreview(state) {
  if (state.prepared || state.item.url?.startsWith("blob:") || state.item.type === "dash") return;
  state.prepared = true;
  if (state.item.type === "image") { state.image.src = state.item.url; return; }
  if (state.item.type === "hls") return;
  if (!state.media) return;
  state.media.src = state.item.url;
  state.media.load();
}

async function stopActivePreview() {
  const state = activePreview;
  activePreview = null;
  if (state) {
    state.playing = false;
    state.media?.pause();
    if (state.media) { state.media.controls = false; state.media.muted = true; }
    state.container.classList.remove("preview-playing");
    state.overlay.hidden = false;
    state.overlay.querySelector("span:last-child").textContent = state.item.type === "audio" ? "播放音频" : "播放预览";
    if (state.item.type === "hls") { state.suppressErrors = true; destroyHls(state); state.prepared = false; state.media.removeAttribute("src"); state.media.load(); setTimeout(() => { state.suppressErrors = false; }, 0); }
  }
  await clearPreviewHeaders();
}

async function playPreview(state) {
  if (!["video", "audio", "hls"].includes(state.item.type) || state.item.url?.startsWith("blob:")) return;
  if (activePreview && activePreview !== state) await stopActivePreview();
  const retry = state.failed;
  await applyPreviewHeaders(state.item);
  state.failed = false;
  state.container.classList.remove("preview-failed");
  state.container.classList.add("preview-playing");
  state.overlay.hidden = true;
  state.playing = true;
  activePreview = state;
  if (state.item.type === "hls") {
    state.prepared = true;
    state.media.controls = true;
    state.media.muted = false;
    initializeHls(state, true);
    return;
  }
  if (!state.media.currentSrc || retry) { state.media.src = state.item.url; state.media.load(); }
  state.media.controls = true;
  state.media.muted = false;
  try { await state.media.play(); } catch (_) { setPreviewError(state, "浏览器无法播放此资源，可继续下载"); }
}

function createMediaPreview(item, refreshMetadata) {
  const container = document.createElement("div");
  container.className = `media-preview preview-${item.type}`;
  const state = { item, container, refreshMetadata, prepared: false, failed: false, playing: false, suppressErrors: false, hls: null, media: null, image: null };
  if (item.type === "image") {
    const image = document.createElement("img"); image.alt = "图片预览"; image.addEventListener("load", () => container.classList.add("preview-ready")); image.addEventListener("error", () => setPreviewError(state, "图片预览加载失败")); container.appendChild(image); state.image = image;
  } else if (["video", "audio", "hls"].includes(item.type)) {
    const media = document.createElement(item.type === "audio" ? "audio" : "video");
    media.preload = "metadata"; media.muted = true; media.playsInline = true; media.controls = false;
    if (item.poster && media.tagName === "VIDEO") media.poster = item.poster;
    media.addEventListener("loadedmetadata", () => { updatePreviewMetadata(state); if (!state.playing && media.tagName === "VIDEO" && Number.isFinite(media.duration) && media.duration > 0) { try { media.currentTime = Math.min(.5, media.duration / 10); } catch (_) {} } });
    media.addEventListener("loadeddata", () => { container.classList.add("preview-ready"); container.classList.remove("preview-failed"); state.status.textContent = state.playing ? "正在播放" : "点击封面播放"; if (!state.playing) { media.pause(); state.hls?.stopLoad(); } });
    media.addEventListener("error", () => { if (!state.suppressErrors && (!state.playing || item.type !== "hls")) setPreviewError(state, "封面载入失败，点击可重试"); });
    media.addEventListener("ended", () => stopActivePreview());
    container.appendChild(media); state.media = media;
  }
  const placeholder = document.createElement("div"); placeholder.className = "preview-placeholder"; placeholder.innerHTML = `<span class="preview-mark">${item.type === "audio" ? "♫" : item.type === "dash" ? "DASH" : item.type === "image" ? "IMG" : "▶"}</span>`; container.appendChild(placeholder);
  const status = document.createElement("div"); status.className = "preview-status"; status.textContent = item.type === "dash" ? "DASH 暂不支持在线预览" : item.url?.startsWith("blob:") ? "页面内 Blob 资源暂不支持预览" : item.type === "image" ? "图片预览" : "正在生成媒体封面…"; container.appendChild(status); state.status = status;
  const overlay = document.createElement("button"); overlay.className = "preview-play"; overlay.type = "button"; overlay.innerHTML = `<span class="play-symbol">▶</span><span>${item.type === "audio" ? "播放音频" : "播放预览"}</span>`; overlay.hidden = !["video", "audio", "hls"].includes(item.type) || item.url?.startsWith("blob:"); overlay.addEventListener("click", event => { event.stopPropagation(); playPreview(state); }); container.appendChild(overlay); state.overlay = overlay;
  if (item.type === "dash" || item.url?.startsWith("blob:")) container.classList.add("preview-unavailable");
  return state;
}

function renderCandidates(items) {
  void stopActivePreview();
  previewObserver?.disconnect();
  const root = $("#candidates"); root.innerHTML = "";
  if (!items.length) { root.innerHTML = '<div class="empty">当前页面还没有发现媒体资源</div>'; return; }
  previewObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { preparePreview(entry.target.previewState); previewObserver.unobserve(entry.target); } }, { rootMargin: "80px" }) : null;
  for (const item of [...items].sort((a, b) => b.detectedAt - a.detectedAt)) {
    const node = document.createElement("article"); node.className = "item resource-card";
    const row = document.createElement("div"); row.className = "row";
    const tag = document.createElement("strong"); tag.textContent = item.type.toUpperCase();
    const actions = document.createElement("div"); actions.className = "card-actions";
    const detailsButton = document.createElement("button"); detailsButton.className = "detail-button"; detailsButton.textContent = "详情";
    const downloadButton = document.createElement("button"); const unavailable = item.url?.startsWith("blob:"); downloadButton.textContent = unavailable ? "暂不支持" : creating.has(item.canonicalUrl || item.url) ? "创建中…" : "下载"; downloadButton.disabled = unavailable || creating.has(item.canonicalUrl || item.url); if (unavailable) downloadButton.title = "页面内 Blob 地址需要专用清单解析器";
    actions.append(detailsButton, downloadButton); row.append(tag, actions);
    const url = document.createElement("div"); url.className = "url"; url.textContent = item.url; url.title = item.url;
    const meta = document.createElement("div"); meta.className = "meta";
    const details = document.createElement("div"); details.className = "details"; details.hidden = true;
    const sizeRow = detailRow("大小", formatBytes(item.size)); const resolutionRow = detailRow("分辨率", "未知"); const durationRow = detailRow("时长", "未知"); const mimeRow = detailRow("MIME", item.mime || "未知");
    const refreshMetadata = () => { meta.textContent = [item.mime, formatBytes(item.size), item.width && item.height ? `${item.width}×${item.height}` : null, sourceLabel(item.source)].filter(Boolean).join(" · "); resolutionRow.valueNode.textContent = item.width && item.height ? `${item.width} × ${item.height}` : "未知"; durationRow.valueNode.textContent = formatDuration(item.duration); mimeRow.valueNode.textContent = item.mime || "未知"; };
    const preview = createMediaPreview(item, refreshMetadata); preview.container.previewState = preview; refreshMetadata();
    details.append(sizeRow, resolutionRow, durationRow, mimeRow, detailRow("发现来源", sourceLabel(item.source)), detailRow("页面", item.pageTitle || "未知"), detailRow("来源地址", item.pageUrl || item.url));
    if (item.type === "hls") { const tip = document.createElement("div"); tip.className = "stream-tip"; tip.textContent = "支持在线预览；下载并合并由 StreamFirefly 安装包内的 FFmpeg 完成"; details.appendChild(tip); }
    if (item.type === "dash") { const tip = document.createElement("div"); tip.className = "stream-tip"; tip.textContent = "DASH 暂不支持在线预览；下载并合并由 StreamFirefly 安装包内的 FFmpeg 完成"; details.appendChild(tip); }
    detailsButton.addEventListener("click", () => { details.hidden = !details.hidden; detailsButton.textContent = details.hidden ? "详情" : "收起"; });
    downloadButton.addEventListener("click", () => openDownloadDialog(item));
    node.append(row, preview.container, url, meta, details); root.appendChild(node);
    if (previewObserver) previewObserver.observe(preview.container); else preparePreview(preview);
  }
}

async function loadCandidates() { const result = await api.runtime.sendMessage({ type: "media.candidates", tabId }); const items = Array.isArray(result) ? result : []; renderCandidates(items); $("#status").textContent = `${items.length} 个候选资源`; }

async function openDownloadDialog(item) {
  const settings = api?.storage?.local ? await api.storage.local.get({ saveDir: "", downloadThreads: 6 }) : { saveDir: "", downloadThreads: 6 };
  const payload = taskPayload(item, Number(settings.downloadThreads) || 6);
  const fallbackExtension = item.type === "hls" || item.type === "dash" ? "mp4" : item.url.match(/\.([a-z0-9]{1,8})(?:$|[?#])/i)?.[1] || "download";
  const fallbackName = (item.title || item.pageTitle || item.url.split(/[/?#]/).pop()?.replace(/\.[^.]+$/, "") || "streamfirefly-download").trim();
  let prepared = { ok: true, payload: { fileName: fallbackName, extension: fallbackExtension } };
  if (api?.runtime?.sendMessage) prepared = await api.runtime.sendMessage({ type: "task.prepare", payload });
  if (!prepared?.ok) { $("#status").textContent = `无法准备下载：${prepared?.error || "unknown"}`; return; }
  pendingDownload = { item, payload, saveDir: settings.saveDir || null };
  $("#download-name").value = prepared.payload.fileName;
  $("#download-extension").textContent = `.${prepared.payload.extension}`;
  $("#download-save-dir").textContent = settings.saveDir || "系统默认目录";
  $("#download-save-dir").title = settings.saveDir || "系统默认目录";
  $("#download-dialog-source").textContent = item.pageTitle || "设置文件名称和保存位置";
  updateDownloadValidation();
  $("#download-dialog").hidden = false;
  $("#download-name").focus();
  $("#download-name").select();
}

async function createTask() {
  if (!pendingDownload) return;
  const item = pendingDownload.item;
  const key = item.canonicalUrl || item.url;
  if (creating.has(key)) return;
  const fileName = $("#download-name").value.trim();
  const validationError = updateDownloadValidation();
  if (validationError) return;
  closeDialog("#download-dialog");
  creating.add(key); tasksOpen = true; await loadCandidates(); $("#status").textContent = "正在创建下载任务…";
  let finalStatus = "任务创建完成";
  try { const result = await api.runtime.sendMessage({ type: "task.create", payload: { ...pendingDownload.payload, fileName, saveDir: pendingDownload.saveDir } }); finalStatus = !result?.ok ? `创建失败：${result?.error || "unknown"}` : `任务已创建：${result.task?.title || "等待中"}`; }
  catch (error) { finalStatus = `创建失败：${error.message}`; }
  finally { creating.delete(key); pendingDownload = null; await loadCandidates(); await loadTasks(); $("#status").textContent = finalStatus; }
}

function taskNode(task) {
  const node = document.createElement("article"); node.className = "item task-card";
  const head = document.createElement("div"); head.className = "task-head"; const title = document.createElement("strong"); title.textContent = task.title || task.id; const actions = document.createElement("div"); actions.className = "task-actions"; const state = document.createElement("span"); state.className = `task-state ${task.state}`; state.textContent = stateLabel(task); const remove = document.createElement("button"); remove.className = "task-delete"; remove.type = "button"; remove.textContent = task.state === "cancelling" ? "取消中…" : "删除"; remove.disabled = task.state === "cancelling"; remove.addEventListener("click", () => openDeleteDialog(task)); actions.append(state, remove); head.append(title, actions);
  const progress = document.createElement("div"); progress.className = `progress ${task.total_bytes == null && task.state === "running" ? "indeterminate" : ""}`; const bar = document.createElement("span"); bar.style.width = `${Math.max(0, Math.min(100, task.progress || 0))}%`; progress.appendChild(bar);
  const stats = document.createElement("div"); stats.className = "task-stats"; const amount = task.total_bytes == null ? formatBytes(task.downloaded_bytes) : `${formatBytes(task.downloaded_bytes)} / ${formatBytes(task.total_bytes)}`; const parts = [task.total_bytes == null ? null : `${task.progress || 0}%`, amount, task.speed_bytes_per_second ? `${formatBytes(task.speed_bytes_per_second)}/s` : null, task.active_connections ? `${task.active_connections} 路连接` : null, task.segments_total ? `${task.segments_completed || 0}/${task.segments_total} 段` : null, task.eta_seconds != null && task.state === "running" ? `剩余约 ${task.eta_seconds} 秒` : null]; stats.textContent = parts.filter(Boolean).join(" · ");
  const message = document.createElement("div"); message.className = "task-message"; message.textContent = task.error || task.message || "";
  const output = document.createElement("div"); output.className = "task-output"; output.textContent = task.output || ""; output.title = task.output || "";
  node.append(head, progress, stats, message, output); return node;
}

function showDeleteChoices() {
  pendingDeleteMode = null;
  $("#delete-choice").hidden = false; $("#delete-choice-actions").hidden = false; $("#delete-confirmation").hidden = true; $("#delete-dialog-title").textContent = "删除下载任务";
  const active = isActiveTask(pendingDelete); $("#delete-dialog-message").textContent = active ? "此任务仍在下载，请选择删除方式。" : `请选择如何处理“${pendingDelete.title || "此任务"}”。`;
}

function openDeleteDialog(task) {
  pendingDelete = task;
  $("#delete-record-file").querySelector("span").textContent = isActiveTask(task) ? "取消下载，并删除已经写入的临时文件" : "同时删除已下载的本地文件";
  $("#delete-error").textContent = ""; showDeleteChoices(); $("#delete-dialog").hidden = false;
}

function chooseDeleteMode(deleteFile) {
  if (!pendingDelete) return;
  pendingDeleteMode = deleteFile;
  const active = isActiveTask(pendingDelete);
  $("#delete-choice").hidden = true; $("#delete-choice-actions").hidden = true; $("#delete-confirmation").hidden = false; $("#delete-dialog-title").textContent = "再次确认删除"; $("#delete-dialog-message").textContent = `任务：${pendingDelete.title || "未命名任务"}`;
  $("#delete-confirm-title").textContent = deleteFile ? "确认删除记录和本地文件？" : "确认仅删除任务记录？";
  $("#delete-confirm-message").textContent = deleteFile ? active ? "这会停止当前下载，并永久删除已经写入的本地文件。" : "本地文件将被永久删除，此操作无法撤销。" : active ? "这会停止当前下载并移除任务记录，已经写入的文件将保留。" : "任务记录将被移除，本地文件会继续保留。";
  $("#delete-confirm-path").textContent = pendingDelete.output || "尚未生成本地文件"; $("#delete-confirm-path").title = pendingDelete.output || "尚未生成本地文件"; $("#delete-confirm-submit").textContent = deleteFile ? "确认删除记录和文件" : "确认删除记录";
}

async function deleteTask() {
  if (!pendingDelete || pendingDeleteMode == null) return;
  const buttons = [$("#delete-confirm-back"), $("#delete-confirm-submit"), $("#delete-cancel")]; buttons.forEach(button => button.disabled = true); $("#delete-dialog-message").textContent = isActiveTask(pendingDelete) ? "正在取消下载并删除任务…" : "正在删除任务…";
  try {
    const result = await api.runtime.sendMessage({ type: "task.delete", payload: { id: pendingDelete.id, deleteFile: pendingDeleteMode } });
    if (!result?.ok) { $("#delete-error").textContent = `删除失败：${deleteErrorLabel(result?.error)}`; return; }
    const deletedTitle = pendingDelete.title || "任务"; const deletedFile = pendingDeleteMode; pendingDelete = null; pendingDeleteMode = null; closeDialog("#delete-dialog"); await loadTasks(); $("#status").textContent = deletedFile ? `已删除任务和本地文件：${deletedTitle}` : `已删除任务记录：${deletedTitle}`;
  } catch (error) { $("#delete-error").textContent = `删除失败：${error.message}`; }
  finally { buttons.forEach(button => button.disabled = false); }
}

function cancelDeleteDialog() { pendingDelete = null; pendingDeleteMode = null; closeDialog("#delete-dialog"); }

function renderTasks(tasks) {
  const panel = $("#tasks-panel"); const root = $("#tasks-list"); const toggle = $("#tasks-toggle"); const active = tasks.some(isActiveTask);
  if (!tasksManuallyToggled) tasksOpen = active;
  panel.hidden = !tasks.length; root.innerHTML = "";
  if (!tasks.length) root.innerHTML = '<div class="empty">暂无本地任务</div>'; else for (const task of tasks.slice(-8).reverse()) root.appendChild(taskNode(task));
  root.hidden = !tasksOpen; toggle.setAttribute("aria-expanded", String(tasksOpen));
  const activeCount = tasks.filter(isActiveTask).length; $("#tasks-summary").textContent = !tasks.length ? "" : active ? `${activeCount} 个进行中` : `${tasks.length} 个任务`;
}
function scheduleTaskRefresh() { const active = currentTasks.some(isActiveTask); clearInterval(taskTimer); if (active) taskTimer = setInterval(() => loadTasks().catch(() => {}), 1000); }
async function loadTasks() { const result = await api.runtime.sendMessage({ type: "task.list" }); currentTasks = result?.tasks ?? result?.payload?.tasks ?? []; renderTasks(currentTasks); scheduleTaskRefresh(); }

async function init() {
  await clearPreviewHeaders();
  if (!api?.tabs?.query || !api?.runtime?.sendMessage) { renderCandidates([{ type: "video", url: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4", mime: "video/mp4", size: 1128375, width: 960, height: 540, duration: 5, source: "dom", detectedAt: Date.now(), pageTitle: "示例视频" }]); $("#status").textContent = "1 个候选资源 · 界面预览模式"; renderTasks([{ id: "preview-task", title: "测试任务", state: "running", progress: 30, downloaded_bytes: 300, total_bytes: 1000, output: "D:\\Downloads\\测试任务.mp4" }]); return; }
  const tab = await currentTab(); tabId = tab?.id; await api.runtime.sendMessage({ type: "native.connect" }); await loadCandidates(); await loadTasks();
}

api?.runtime?.onMessage?.addListener(message => { if (message?.type === "task.deleted" && message.id) { currentTasks = currentTasks.filter(task => task.id !== message.id); renderTasks(currentTasks); scheduleTaskRefresh(); return; } if (message?.type !== "task.progress" || !message.task) return; const index = currentTasks.findIndex(task => task.id === message.task.id); if (index >= 0) currentTasks[index] = message.task; else { currentTasks.push(message.task); if (isActiveTask(message.task)) { tasksOpen = true; tasksManuallyToggled = false; } } renderTasks(currentTasks); scheduleTaskRefresh(); });
$("#settings").addEventListener("click", () => api?.runtime?.openOptionsPage ? api.runtime.openOptionsPage() : location.assign("options.html"));
$("#tasks-toggle").addEventListener("click", () => { tasksManuallyToggled = true; tasksOpen = !tasksOpen; renderTasks(currentTasks); });
$("#download-confirm").addEventListener("click", createTask);
$("#download-name").addEventListener("input", updateDownloadValidation);
$("#download-name").addEventListener("keydown", event => { if (event.key === "Enter") createTask(); });
for (const id of ["#download-cancel", "#download-cancel-secondary"]) $(id).addEventListener("click", () => { pendingDownload = null; closeDialog("#download-dialog"); });
$("#delete-record").addEventListener("click", () => chooseDeleteMode(false));
$("#delete-record-file").addEventListener("click", () => chooseDeleteMode(true));
$("#delete-confirm-back").addEventListener("click", showDeleteChoices);
$("#delete-confirm-submit").addEventListener("click", deleteTask);
for (const id of ["#delete-cancel", "#delete-cancel-secondary"]) $(id).addEventListener("click", cancelDeleteDialog);
$("#refresh").addEventListener("click", init);
window.addEventListener("pagehide", () => { clearInterval(taskTimer); previewObserver?.disconnect(); void stopActivePreview(); });
init().catch(error => { $("#status").textContent = `读取失败：${error.message}`; });
