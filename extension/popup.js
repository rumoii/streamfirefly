const api = globalThis.browser ?? globalThis.chrome;
const $ = selector => document.querySelector(selector);
const creating = new Set();
let tabId;
let taskTimer;
let currentTasks = [];
let tasksOpen = false;
let tasksManuallyToggled = false;

async function currentTab() { const tabs = await api.tabs.query({ active: true, currentWindow: true }); return tabs[0]; }
function formatBytes(value) { if (value == null) return "大小未知"; const units = ["B", "KB", "MB", "GB"]; let size = Number(value); let unit = 0; while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; } return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`; }
function formatDuration(value) { if (!Number.isFinite(value)) return "未知"; const seconds = Math.round(value); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function sourceLabel(source) { return source === "dom" ? "页面元素" : "网络响应"; }
function isActiveTask(task) { return ["queued", "starting", "running"].includes(task.state); }
function stateLabel(task) { const running = task.phase === "fetching" ? "读取清单" : task.phase === "merging" ? "下载并合并" : "正在下载"; return ({ queued: "等待下载", starting: "正在连接", running, succeeded: "已完成", failed: "下载失败", interrupted: "已中断" })[task.state] || task.message || task.state; }

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
    downloadButton.addEventListener("click", () => createTask(item));
    node.append(row, url, meta, details); root.appendChild(node);
  }
}

async function loadCandidates() { const result = await api.runtime.sendMessage({ type: "media.candidates", tabId }); const items = Array.isArray(result) ? result : []; renderCandidates(items); $("#status").textContent = `${items.length} 个候选资源`; }

async function createTask(item) {
  const key = item.canonicalUrl || item.url;
  if (creating.has(key)) return;
  creating.add(key); tasksOpen = true; await loadCandidates(); $("#status").textContent = "正在创建下载任务…";
  let finalStatus = "任务创建完成";
  try {
    const settings = await api.storage.local.get({ saveDir: "" });
    const result = await api.runtime.sendMessage({ type: "task.create", payload: { url: item.url, title: item.title || item.pageTitle || "streamfirefly-download", mime: item.mime || null, contentDisposition: item.contentDisposition || null, referer: item.referer || item.pageUrl || null, saveDir: settings.saveDir || null } });
    finalStatus = !result?.ok ? `创建失败：${result?.error || "unknown"}` : `任务已创建：${result.task?.title || "等待中"}`;
  } catch (error) {
    finalStatus = `创建失败：${error.message}`;
  } finally { creating.delete(key); await loadCandidates(); await loadTasks(); $("#status").textContent = finalStatus; }
}

function taskNode(task) {
  const node = document.createElement("article"); node.className = "item task-card";
  const head = document.createElement("div"); head.className = "task-head"; const title = document.createElement("strong"); title.textContent = task.title || task.id; const state = document.createElement("span"); state.className = `task-state ${task.state}`; state.textContent = stateLabel(task); head.append(title, state);
  const progress = document.createElement("div"); progress.className = `progress ${task.total_bytes == null && task.state === "running" ? "indeterminate" : ""}`; const bar = document.createElement("span"); bar.style.width = `${Math.max(0, Math.min(100, task.progress || 0))}%`; progress.appendChild(bar);
  const stats = document.createElement("div"); stats.className = "task-stats"; const amount = task.total_bytes == null ? formatBytes(task.downloaded_bytes) : `${formatBytes(task.downloaded_bytes)} / ${formatBytes(task.total_bytes)}`; const parts = [task.total_bytes == null ? null : `${task.progress || 0}%`, amount, task.speed_bytes_per_second ? `${formatBytes(task.speed_bytes_per_second)}/s` : null, task.eta_seconds != null && task.state === "running" ? `剩余约 ${task.eta_seconds} 秒` : null]; stats.textContent = parts.filter(Boolean).join(" · ");
  const message = document.createElement("div"); message.className = "task-message"; message.textContent = task.error || task.message || "";
  const output = document.createElement("div"); output.className = "task-output"; output.textContent = task.output || ""; output.title = task.output || "";
  node.append(head, progress, stats, message, output); return node;
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

api.runtime?.onMessage?.addListener(message => { if (message?.type !== "task.progress" || !message.task) return; const index = currentTasks.findIndex(task => task.id === message.task.id); if (index >= 0) currentTasks[index] = message.task; else { currentTasks.push(message.task); if (isActiveTask(message.task)) { tasksOpen = true; tasksManuallyToggled = false; } } renderTasks(currentTasks); scheduleTaskRefresh(); });
$("#settings").addEventListener("click", () => api?.runtime?.openOptionsPage ? api.runtime.openOptionsPage() : location.assign("options.html"));
$("#tasks-toggle").addEventListener("click", () => { tasksManuallyToggled = true; tasksOpen = !tasksOpen; renderTasks(currentTasks); });
$("#refresh").addEventListener("click", init);
window.addEventListener("unload", () => clearInterval(taskTimer));
init().catch(error => { $("#status").textContent = `读取失败：${error.message}`; });
