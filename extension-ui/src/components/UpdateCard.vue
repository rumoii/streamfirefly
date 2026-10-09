<script setup lang="ts">
import { onMounted, ref } from "vue";
import { extensionApi } from "../api";
import { EDITION, EDITION_LABEL } from "../edition";
import { RELEASES_URL, checkUpdate, updateErrorText, type UpdateStatus } from "../features/update/client";
import SfIcon from "../ui/SfIcon.vue";

const version = String(extensionApi()?.runtime?.getManifest?.().version || "");
const checkable = EDITION !== "chrome-store";
const autoCheck = ref(true), busy = ref(false), message = ref(""), error = ref(""), found = ref<UpdateStatus | null>(null);

onMounted(async () => {
  if (!checkable) return;
  try { autoCheck.value = (await extensionApi()?.storage?.local?.get(["autoCheckUpdates"]))?.autoCheckUpdates !== false; } catch { /* Keep the default. */ }
});
async function toggleAutoCheck(event: Event) {
  const enabled = (event.target as HTMLInputElement).checked;
  error.value = "";
  try { await extensionApi().storage.local.set({ autoCheckUpdates: enabled }); autoCheck.value = enabled; }
  catch (reason) { (event.target as HTMLInputElement).checked = autoCheck.value; error.value = `保存失败：${reason instanceof Error ? reason.message : String(reason)}`; }
}
async function check() {
  if (busy.value) return;
  busy.value = true; message.value = ""; error.value = ""; found.value = null;
  try {
    const status = await checkUpdate();
    if (status.hasUpdate) found.value = status;
    else message.value = `已是最新版（${status.latestVersion || version}）。`;
  } catch (reason) { error.value = updateErrorText(reason instanceof Error ? reason.message : String(reason)); }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="settings-card" aria-labelledby="settings-edition-title">
    <header><h4 id="settings-edition-title">版本</h4><p>{{ EDITION_LABEL }} {{ version }}</p></header>
    <p v-if="EDITION === 'chrome-store'" class="settings-note">根据 Chrome 应用商店政策，此版本不识别和下载 YouTube 内容。</p>
    <p v-else class="settings-note">通用版不限制网站；能否识别和下载取决于网站本身，DRM 加密内容不受支持。</p>
    <template v-if="checkable">
      <div class="toggle-list">
        <label class="toggle-row"><span><strong>每天自动检查更新</strong><small>每天第一次打开流萤时检查一次，有新版本才提示；切换后立即生效。</small></span><input :checked="autoCheck" type="checkbox" @change="toggleAutoCheck"><i></i></label>
      </div>
      <p class="settings-note">检查更新会访问 GitHub（api.github.com），只查询最新版本号，不上传浏览和下载记录。国内网络可能连不上 GitHub，建议开启浏览器或系统代理；下载设置里的“下载代理”只作用于本地助手，不影响检查更新。</p>
      <div class="feature-row">
        <button class="button" type="button" :disabled="busy" @click="check"><SfIcon name="refresh" /><span>{{ busy ? '正在检查…' : '检查更新' }}</span></button>
        <a class="button subtle" :href="RELEASES_URL" target="_blank" rel="noreferrer"><SfIcon name="external-link" /><span>查看所有版本</span></a>
      </div>
      <div v-if="found" class="settings-note update-found" role="status">发现新版本 {{ found.latestVersion }}，扩展和本地助手请一起升级。<a :href="found.releaseUrl" target="_blank" rel="noreferrer">打开下载页</a></div>
      <p v-if="message" class="settings-note" role="status">{{ message }}</p>
      <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    </template>
  </section>
</template>
