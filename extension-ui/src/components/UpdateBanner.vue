<script setup lang="ts">
import { onMounted, ref } from "vue";
import { EDITION } from "../edition";
import { autoCheckUpdate, dismissUpdate, type UpdateStatus } from "../features/update/client";

const status = ref<UpdateStatus | null>(null);
// Failures stay silent: the next day's first opening tries again, and the settings page offers a manual check.
onMounted(async () => { if (EDITION !== "chrome-store") status.value = await autoCheckUpdate().catch(() => null); });
function dismiss() {
  const version = status.value?.latestVersion;
  status.value = null;
  if (version) void dismissUpdate(version).catch(() => {});
}
</script>

<template>
  <div v-if="status?.hasUpdate" class="status-banner update-banner" role="status">
    <div><strong>流萤 {{ status.latestVersion }} 已发布</strong><p>当前 {{ status.currentVersion }}，扩展和本地助手请一起升级。</p></div>
    <span class="update-banner-actions">
      <a class="button sm" :href="status.releaseUrl" target="_blank" rel="noreferrer">查看更新</a>
      <button class="button sm subtle" type="button" @click="dismiss">忽略此版本</button>
    </span>
  </div>
</template>
