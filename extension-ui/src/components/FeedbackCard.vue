<script setup lang="ts">
import { ref } from "vue";
import { configurationRequest } from "../features/configuration/client";
import SfIcon from "../ui/SfIcon.vue";

interface DiagnosticsReport { downloads?: unknown[] | null; captures?: { captures?: unknown[] } | null; errors?: unknown[] }
const busy = ref(false), message = ref(""), error = ref("");

function fileName(now = new Date()) {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `streamfirefly-diagnostics-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
}
function summary(report: DiagnosticsReport) {
  const skipped = report.errors?.length ? `；${report.errors.length} 项未能读取，本地助手未连接时属正常` : "";
  return `${report.downloads?.length ?? 0} 个下载任务、${report.captures?.captures?.length ?? 0} 次录制${skipped}`;
}
async function run(action: "save" | "copy") {
  if (busy.value) return;
  busy.value = true; message.value = ""; error.value = "";
  try {
    const report = await configurationRequest<DiagnosticsReport>("diagnostics.export");
    const text = JSON.stringify(report, null, 2);
    if (action === "copy") { await navigator.clipboard.writeText(text); message.value = `已复制诊断报告：${summary(report)}。`; }
    else {
      const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = fileName(); link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      message.value = `已导出诊断报告：${summary(report)}。把文件发给开发者即可。`;
    }
  } catch (reason) { error.value = `导出失败：${reason instanceof Error ? reason.message : String(reason)}`; }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="settings-card" aria-labelledby="settings-feedback-title">
    <header><h4 id="settings-feedback-title">问题反馈</h4><p>遇到问题时导出诊断报告发给开发者。</p></header>
    <p class="settings-note">报告包含版本信息、最近 20 个下载任务和最近 10 次录制的状态与错误，已去掉视频链接参数和用户名，不含视频文件。</p>
    <div class="feature-row">
      <button class="button primary" type="button" :disabled="busy" @click="run('save')"><SfIcon name="download" /><span>导出诊断报告</span></button>
      <button class="button" type="button" :disabled="busy" @click="run('copy')"><SfIcon name="copy" /><span>复制到剪贴板</span></button>
    </div>
    <p v-if="message" class="settings-note" role="status">{{ message }}</p>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
  </section>
</template>
