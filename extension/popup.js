const api = globalThis.browser ?? globalThis.chrome;
const $ = selector => document.querySelector(selector);
let tabId;

async function currentTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

function renderCandidates(items) {
  const root = $("#candidates");
  root.innerHTML = "";
  if (!items.length) { root.innerHTML = '<div class="empty">当前页面还没有发现媒体资源</div>'; return; }
  for (const item of items.sort((a, b) => b.detectedAt - a.detectedAt)) {
    const node = document.createElement("article");
    node.className = "item";
    node.innerHTML = `<div class="row"><strong>${item.type.toUpperCase()}</strong><button data-url="">下载</button></div><div class="url" title=""></div><div class="meta"></div>`;
    node.querySelector(".url").textContent = item.url;
    node.querySelector(".url").title = item.url;
    node.querySelector(".meta").textContent = [item.mime, item.size ? `${Math.round(item.size / 1024)} KB` : "大小未知", item.source].filter(Boolean).join(" · ");
    node.querySelector("button").addEventListener("click", () => createTask(item));
    root.appendChild(node);
  }
}

async function loadCandidates() {
  const result = await api.runtime.sendMessage({ type: "media.candidates", tabId });
  renderCandidates(Array.isArray(result) ? result : []);
  $("#status").textContent = `${Array.isArray(result) ? result.length : 0} 个候选资源`;
}

async function createTask(item) {
  if (!api?.runtime?.sendMessage) {
    $("#status").textContent = `预览模式：将创建 ${item.type.toUpperCase()} 下载任务`;
    return;
  }
  const result = await api.runtime.sendMessage({ type: "task.create", payload: {
    url: item.url, title: item.title || document.title || "streamfirefly-download", mime: item.mime || null,
    referer: item.pageUrl || null
  }});
  if (!result?.ok) $("#status").textContent = `本地助手不可用：${result?.error || "unknown"}`;
  else $("#status").textContent = `任务已创建：${result.task?.id || result.id || "等待中"}`;
  await loadTasks();
}

async function loadTasks() {
  const result = await api.runtime.sendMessage({ type: "task.list" });
  const root = $("#tasks-list"); root.innerHTML = "";
  const tasks = result?.tasks ?? result?.payload?.tasks ?? [];
  if (!tasks.length) { root.innerHTML = '<div class="empty">暂无本地任务</div>'; return; }
  for (const task of tasks.slice(-8).reverse()) {
    const node = document.createElement("article"); node.className = "item";
    node.textContent = `${task.title || task.id} · ${task.state} · ${task.progress ?? 0}%`;
    root.appendChild(node);
  }
}

async function init() {
  if (!api?.tabs?.query || !api?.runtime?.sendMessage) {
    renderCandidates([
      { type: "hls", url: "https://media.example/video/master.m3u8", mime: "application/vnd.apple.mpegurl", size: null, source: "network", detectedAt: Date.now() },
      { type: "video", url: "https://media.example/video/sample.mp4", mime: "video/mp4", size: 8388608, source: "dom", detectedAt: Date.now() - 1 }
    ]);
    $("#status").textContent = "2 个候选资源 · 界面预览模式";
    $("#tasks-list").innerHTML = '<article class="item">示例下载 · running · 42%</article>';
    return;
  }
  const tab = await currentTab(); tabId = tab?.id;
  await api.runtime.sendMessage({ type: "native.connect" });
  await loadCandidates(); await loadTasks();
}
$("#refresh").addEventListener("click", init); init().catch(error => { $("#status").textContent = `读取失败：${error.message}`; });
