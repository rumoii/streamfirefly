const api = globalThis.browser ?? globalThis.chrome;
const input = document.querySelector("#save-dir");
const message = document.querySelector("#message");
const errorLabels = { path_empty: "路径不能为空", path_must_be_absolute: "请填写 Windows 绝对路径", path_is_not_directory: "该路径指向文件，不是目录", path_not_writable: "目录无法创建或写入", native_host_unavailable: "本地助手不可用，请重新安装或启动" };
function show(text, error = false) { message.textContent = text; message.className = `message${error ? " error" : ""}`; }
const available = Boolean(api?.storage?.local && api?.runtime?.sendMessage);
async function load() { if (!available) { show("界面预览模式：加载为扩展后可验证并保存目录"); return; } const value = await api.storage.local.get({ saveDir: "" }); input.value = value.saveDir || ""; }
document.querySelector("#save").addEventListener("click", async () => { const value = input.value.trim(); if (!available) { show("界面预览模式：路径尚未写入", true); return; } if (!value) { await api.storage.local.remove("saveDir"); show("已恢复为系统默认目录"); return; } show("正在验证目录…"); const result = await api.runtime.sendMessage({ type: "path.validate", payload: { path: value } }); if (!result?.ok) { show(`保存失败：${errorLabels[result?.error] || result?.error || "目录不可用"}`, true); return; } await api.storage.local.set({ saveDir: result.path }); input.value = result.path; show("保存成功，新任务将使用此目录"); });
document.querySelector("#reset").addEventListener("click", async () => { if (available) await api.storage.local.remove("saveDir"); input.value = ""; show("已恢复为系统默认目录"); });
load().catch(error => show(`读取设置失败：${error.message}`, true));
