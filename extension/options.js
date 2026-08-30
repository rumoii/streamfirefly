const api = globalThis.browser ?? globalThis.chrome;
const input = document.querySelector("#save-dir");
const threadsInput = document.querySelector("#download-threads");
const detectImagesInput = document.querySelector("#detect-images");
const advancedDeepSearchInput = document.querySelector("#advanced-deep-search");
const message = document.querySelector("#message");
const errorLabels = { path_empty: "路径不能为空", path_must_be_absolute: "请填写 Windows 绝对路径", path_is_not_directory: "该路径指向文件，不是目录", path_not_writable: "目录无法创建或写入", native_host_unavailable: "本地助手不可用，请重新安装或启动" };

function show(text, error = false) { message.textContent = text; message.className = `message${error ? " error" : ""}`; }
const available = Boolean(typeof api?.storage?.local?.get === "function" && typeof api.storage.local.set === "function" && typeof api.storage.local.remove === "function" && typeof api?.runtime?.sendMessage === "function");
function threadsValue() { const value = Number.parseInt(threadsInput.value, 10); return Number.isInteger(value) ? Math.max(1, Math.min(16, value)) : 6; }
function detectionSettings() { return { detectImages: detectImagesInput.checked, advancedDeepSearch: advancedDeepSearchInput.checked }; }

async function load() {
  if (!available) { show("界面预览模式：加载为扩展后可验证并保存设置"); return; }
  const value = await api.storage.local.get({ saveDir: "", downloadThreads: 6, detectImages: false, advancedDeepSearch: false });
  input.value = value.saveDir || "";
  threadsInput.value = String(Math.max(1, Math.min(16, Number(value.downloadThreads) || 6)));
  detectImagesInput.checked = Boolean(value.detectImages);
  advancedDeepSearchInput.checked = Boolean(value.advancedDeepSearch);
}

document.querySelector("#save").addEventListener("click", async () => {
  const value = input.value.trim();
  const downloadThreads = threadsValue();
  const detection = detectionSettings();
  threadsInput.value = String(downloadThreads);
  if (!available) { show("界面预览模式：设置尚未写入", true); return; }
  if (!value) {
    await api.storage.local.set({ downloadThreads, ...detection });
    await api.storage.local.remove("saveDir");
    show("保存成功；识别选项将在刷新目标网页后生效");
    return;
  }
  show("正在验证目录…");
  const result = await api.runtime.sendMessage({ type: "path.validate", payload: { path: value } });
  if (!result?.ok) { show(`保存失败：${errorLabels[result?.error] || result?.error || "目录不可用"}`, true); return; }
  await api.storage.local.set({ saveDir: result.path, downloadThreads, ...detection });
  input.value = result.path;
  show("保存成功；新任务使用这些参数，识别选项将在刷新目标网页后生效");
});

document.querySelector("#reset").addEventListener("click", async () => {
  if (available) {
    await api.storage.local.remove("saveDir");
    await api.storage.local.set({ downloadThreads: 6, detectImages: false, advancedDeepSearch: false });
  }
  input.value = "";
  threadsInput.value = "6";
  detectImagesInput.checked = false;
  advancedDeepSearchInput.checked = false;
  show("已恢复默认设置；识别选项将在刷新目标网页后生效");
});

load().catch(error => show(`读取设置失败：${error.message}`, true));
