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

async function currentTab() { const tabs = await api.tabs.query({ active: true, currentWindow: true }); return tabs[0]; }
function formatBytes(value) { if (value == null) return "大小未知"; const units = ["B", "KB", "MB", "GB"]; let size = Number(value); let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; } return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`; }
function formatDuration(value) { if (!Number.isFinite(value)) return "未知"; const seconds = Math.round(value); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function sourceLabel(source) { return source === "dom" ? "页面元素" : "网络响应"; }
function isActiveTask(task) { return ["queued", "starting", "running", "cancelling"].includes(task.state); }
function stateLabel(task) { const running = task.phase === "fetching" ? "读取清单" : task.phase === "merging" ? "下载并合并" : "正在下载"; return ({ queued: "等待下载", starting: "正在连接", running, cancelling: "正在取消", cancelled: "已取消", succeeded: "已完成", failed: "下载失败", interrupted: "已中断" })[task.state] || task.message || task.state; }
function taskPayload(item) { return { url: item.url, title: item.title || item.pageTitle || "streamfirefly-download", mime: item.mime || null, contentDisposition: item.contentDisposition || null, referer: item.referer || item.pageUrl || null }; }
function closeDialog(id) { $(id).hidden = true; }
function validateFileName(value) { const trimmed = value.trim().replace(/[. ]+$/g, ""); if (!trimmed) return "请输入文件名称"; if (/[<>:\"/\\|?*\u0000-\u001f]/.test(trimmed)) return "文件名不能包含 Windows 非法字符"; return ""; }
function updateDownloadValidation() { const error = validateFileName($("#download-name").value); $("#download-name-error").textContent = error; $("#download-confirm").disabled = Boolean(error); return error; }
function deleteErrorLabel(error) { return ({ task_not_found: "任务不存在或已被删除", cancel_failed: "无法停止下载进程，任务和文件均已保留", file_delete_failed: "本地文件删除失败，请检查文件是否被占用", file_delete_unsafe: "目标不是可安全删除的普通文件" })[error] || error || "unknown"; }

function detailRow(label, value) { const row = document.createElement("div"); row.className = "detail-row"; const name = document.createElement("span"); name.textContent = label; const content = document.createElement("span"); content.textContent = value || "未知"; content.title = value || "未知"; row.append(name, content); return row; }

function renderCandidates(items) {
  const root = $("#candidates"); root.innerHTML = "";
  if (!items.length) { root.innerHTML = '<div class="empty">当前页面还没有发现媒体资源</div>'; return; }
  for (const item of items.sort((a, b) => b.detectedAt - a.detectedAt)) {
    const node = document.createElement("article"); node.className = "item resource-card";
    const row = document.createElement("div"); row.className = "row";
    const tag = document.createElement("strong"); tag.textContent = item.type.toUpperCase();
    const actions = document.createElement("div"); actions.className = "card-actions";
    const detailsButton = document.createElement("button"); detailsButton.className = "detail-button"; detailsButton.textContent = "详情";
    const downloadButton = document.createElement("button"); const unavailable = item.url?.startsWith("blob:"); downloadButton.textContent = unavailable ? "暂不支持" : creating.has(item.canonicalUrl || item.url) ? "创建中…" : "下载"; downloadButton.disabled = unavailable || creating.has(item.canonicalUrl || item.url); if (unavailable) downloadButton.title = "页面内 Blob 地址需要专用清单解析器";
    actions.append(detailsButton, downloadButton); row.append(tag, actions);
    const url = document.createElement("div"); url.className = "url"; url.textContent = item.url; url.title = item.url;
    const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = [item.mime, formatBytes(item.size), item.width && item.height ? `${item.width}×${item.height}` : null, sourceLabel(item.source)].filter(Boolean).join(" · ");
    const details = document.createElement("div"); details.className = "details"; details.hidden = true;
    if (item.poster) { const poster = document.createElement("img"); poster.className = "poster"; poster.src = item.poster; poster.alt = "资源封面"; poster.addEventListener("error", () => poster.remove()); details.appendChild(poster); }
    details.append(detailRow("大小", formatBytes(item.size)), detailRow("分辨率", item.width && item.height ? `${item.width} × ${item.height}` : "未知"), detailRow("时长", formatDuration(item.duration)), detailRow("MIME", item.mime || "未知"), detailRow("发现来源", sourceLabel(item.source)), detailRow("页面", item.pageTitle || "未知"), detailRow("来源地址", item.pageUrl || item.url));
    if (item.type === "hls" || item.type === "dash") { const tip = document.createElement("div"); tip.className = "stream-tip"; tip.textContent = "流媒体资源需要本机安装 FFmpeg"; details.appendChild(tip); }
    detailsButton.addEventListener("click", () => { details.hidden = !details.hidden; detailsButton.textContent = details.hidden ? "详情" : "收起"; });
    downloadButton.addEventListener("click", () => openDownloadDialog(item));
    node.append(row, url, meta, details); root.appendChild(node);
  }
}

async function loadCandidates() { const result = await api.runtime.sendMessage({ type: "media.candidates", tabId }); const items = Array.isArray(result) ? result : []; renderCandidates(items); $("#status").textContent = `${items.length} 个候选资源`; }

async function openDownloadDialog(item) {
  const settings = api?.storage?.local ? await api.storage.local.get({ saveDir: "" }) : { saveDir: "" };
  const payload = taskPayload(item);
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
  try {
    const result = await api.runtime.sendMessage({ type: "task.create", payload: { ...pendingDownload.payload, fileName, saveDir: pendingDownload.saveDir } });
    finalStatus = !result?.ok ? `创建失败：${result?.error || "unknown"}` : `任务已创建：${result.task?.title || "等待中"}`;
  } catch (error) {
    finalStatus = `创建失败：${error.message}`;
  } finally { creating.delete(key); pendingDownload = null; await loadCandidates(); await loadTasks(); $("#status").textContent = finalStatus; }
}

function taskNode(task) {
  const node = document.createElement("article"); node.className = "item task-card";
  const head = document.createElement("div"); head.className = "task-head"; const title = document.createElement("strong"); title.textContent = task.title || task.id; const actions = document.createElement("div"); actions.className = "task-actions"; const state = document.createElement("span"); state.className = `task-state ${task.state}`; state.textContent = stateLabel(task); const remove = document.createElement("button"); remove.className = "task-delete"; remove.type = "button"; remove.textContent = task.state === "cancelling" ? "取消中…" : "删除"; remove.disabled = task.state === "cancelling"; remove.addEventListener("click", () => openDeleteDialog(task)); actions.append(state, remove); head.append(title, actions);
  const progress = document.createElement("div"); progress.className = `progress ${task.total_bytes == null && task.state === "running" ? "indeterminate" : ""}`; const bar = document.createElement("span"); bar.style.width = `${Math.max(0, Math.min(100, task.progress || 0))}%`; progress.appendChild(bar);
  const stats = document.createElement("div"); stats.className = "task-stats"; const amount = task.total_bytes == null ? formatBytes(task.downloaded_bytes) : `${formatBytes(task.downloaded_bytes)} / ${formatBytes(task.total_bytes)}`; const parts = [task.total_bytes == null ? null : `${task.progress || 0}%`, amount, task.speed_bytes_per_second ? `${formatBytes(task.speed_bytes_per_second)}/s` : null, task.eta_seconds != null && task.state === "running" ? `剩余约 ${task.eta_seconds} 秒` : null]; stats.textContent = parts.filter(Boolean).join(" · ");
  const message = document.createElement("div"); message.className = "task-message"; message.textContent = task.error || task.message || "";
  const output = document.createElement("div"); output.className = "task-output"; output.textContent = task.output || ""; output.title = task.output || "";
  node.append(head, progress, stats, message, output); return node;
}

function openDeleteDialog(task) {
  pendingDelete = task;
  const active = isActiveTask(task);
  $("#delete-dialog-message").textContent = active ? "此任务仍在下载，删除前会先取消下载。" : `请选择如何处理“${task.title || "此任务"}”。`;
  $("#delete-record-file").querySelector("span").textContent = active ? "取消下载，并删除已经写入的临时文件" : "同时删除已下载的本地文件";
  $("#delete-error").textContent = "";
  $("#delete-dialog").hidden = false;
}

async function deleteTask(deleteFile) {
  if (!pendingDelete) return;
  const buttons = [$("#delete-record"), $("#delete-record-file")];
  buttons.forEach(button => button.disabled = true);
  $("#delete-dialog-message").textContent = isActiveTask(pendingDelete) ? "正在取消下载并删除任务…" : "正在删除任务…";
  try {
    const result = await api.runtime.sendMessage({ type: "task.delete", payload: { id: pendingDelete.id, deleteFile } });
    if (!result?.ok) { $("#delete-error").textContent = `删除失败：${deleteErrorLabel(result?.error)}`; return; }
    const deletedTitle = pendingDelete.title || "任务";
    pendingDelete = null;
    closeDialog("#delete-dialog");
    await loadTasks();
    $("#status").textContent = deleteFile ? `已删除任务和本地文件：${deletedTitle}` : `已删除任务记录：${deletedTitle}`;
  } catch (error) {
    $("#delete-error").textContent = `删除失败：${error.message}`;
  } finally {
    buttons.forEach(button => button.disabled = false);
  }
}

function renderTasks(tasks) {
  const panel = $("#tasks-panel");
  const root = $("#tasks-list");
  const toggle = $("#tasks-toggle");
  const active = tasks.some(isActiveTask);
  if (!tasksManuallyToggled) tasksOpen = active;
  panel.hidden = !tasks.length;
  root.innerHTML = "";
  if (!tasks.length) root.innerHTML = '<div class="empty">暂无本地任务</div>';
  else for (const task of tasks.slice(-8).reverse()) root.appendChild(taskNode(task));
  root.hidden = !tasksOpen;
  toggle.setAttribute("aria-expanded", String(tasksOpen));
  const activeCount = tasks.filter(isActiveTask).length;
  $("#tasks-summary").textContent = !tasks.length ? "" : active ? `${activeCount} 个进行中` : `${tasks.length} 个任务`;
}
function scheduleTaskRefresh() { const active = currentTasks.some(isActiveTask); clearInterval(taskTimer); if (active) taskTimer = setInterval(() => loadTasks().catch(() => {}), 1000); }
async function loadTasks() { const result = await api.runtime.sendMessage({ type: "task.list" }); currentTasks = result?.tasks ?? result?.payload?.tasks ?? []; renderTasks(currentTasks); scheduleTaskRefresh(); }

async function init() {
  if (!api?.tabs?.query || !api?.runtime?.sendMessage) { renderCandidates([{ type: "video", url: "https://media.example/video/sample.mp4", mime: "video/mp4", size: 8388608, width: 1920, height: 1080, duration: 42, source: "dom", detectedAt: Date.now(), pageTitle: "示例页面" }]); $("#status").textContent = "1 个候选资源 · 界面预览模式"; renderTasks([]); return; }
  const tab = await currentTab(); tabId = tab?.id; await api.runtime.sendMessage({ type: "native.connect" }); await loadCandidates(); await loadTasks();
}

api.runtime?.onMessage?.addListener(message => { if (message?.type === "task.deleted" && message.id) { currentTasks = currentTasks.filter(task => task.id !== message.id); renderTasks(currentTasks); scheduleTaskRefresh(); return; } if (message?.type !== "task.progress" || !message.task) return; const index = currentTasks.findIndex(task => task.id === message.task.id); if (index >= 0) currentTasks[index] = message.task; else { currentTasks.push(message.task); if (isActiveTask(message.task)) { tasksOpen = true; tasksManuallyToggled = false; } } renderTasks(currentTasks); scheduleTaskRefresh(); });
$("#settings").addEventListener("click", () => api?.runtime?.openOptionsPage ? api.runtime.openOptionsPage() : location.assign("options.html"));
$("#tasks-toggle").addEventListener("click", () => { tasksManuallyToggled = true; tasksOpen = !tasksOpen; renderTasks(currentTasks); });
$("#download-confirm").addEventListener("click", createTask);
$("#download-name").addEventListener("input", updateDownloadValidation);
$("#download-name").addEventListener("keydown", event => { if (event.key === "Enter") createTask(); });
for (const id of ["#download-cancel", "#download-cancel-secondary"]) $(id).addEventListener("click", () => { pendingDownload = null; closeDialog("#download-dialog"); });
$("#delete-record").addEventListener("click", () => deleteTask(false));
$("#delete-record-file").addEventListener("click", () => deleteTask(true));
for (const id of ["#delete-cancel", "#delete-cancel-secondary"]) $(id).addEventListener("click", () => { pendingDelete = null; closeDialog("#delete-dialog"); });
$("#refresh").addEventListener("click", init);
window.addEventListener("unload", () => clearInterval(taskTimer));
init().catch(error => { $("#status").textContent = `读取失败：${error.message}`; });
