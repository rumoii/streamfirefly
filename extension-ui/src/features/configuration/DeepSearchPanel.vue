<script setup lang="ts">
import { computed, inject, toRef } from "vue";
import SfDialog from "../../ui/SfDialog.vue";
import SfIcon from "../../ui/SfIcon.vue";
import type { UiContext } from "../../types";
import { createDeepSearchState, deepSearchKey } from "../deep-search/state";
const props = defineProps<{ context: UiContext | null }>();
const { state, remember, busy, message, hasError, dialogOpen: detailsOpen, refresh, toggle } = inject(deepSearchKey, null) ?? createDeepSearchState(toRef(props, "context"));
const failed = computed(() => state.value.frames.filter(frame => frame.state === "failed"));
// The toolbar only shows a dot; the hint row under the toolbar explains what to do.
const status = computed(() => !state.value.enabled ? "未开启" : failed.value.length ? `已开启，${failed.value.length} 个框架异常` : state.value.requiresReload ? "已开启，需刷新页面" : "已开启");
const labels = { ready: "探针已运行", disabled: "未开启", failed: "注入失败", unsupported: "不支持此框架" };
</script>
<template>
  <div v-if="context?.supported" class="deep-search-actions">
    <button class="icon-button deep-search-trigger" :class="{ enabled: state.enabled, warning: failed.length || state.requiresReload }" aria-haspopup="dialog" :aria-expanded="detailsOpen" :aria-label="`深度搜索（${status}）`" :title="`深度搜索：${status}`" @click="detailsOpen = true"><SfIcon name="radar-2" /><i aria-hidden="true"></i></button>
    <span v-if="hasError" class="resource-tool-error" role="alert">{{ message }}</span>
    <SfDialog v-if="detailsOpen" title="深度搜索" :description="`${state.enabled ? '已开启' : '未开启'} · ${state.frames.filter(frame => frame.state === 'ready').length}/${state.frames.length} 个框架就绪`" close-label="关闭深搜详情" size="lg" @close="detailsOpen = false">
      <div class="deep-search-settings"><label class="remember-site"><input v-model="remember" type="checkbox" class="checkbox" :disabled="busy">记住此站点（下次切换时应用）</label><button class="button" :disabled="busy" @click="refresh"><SfIcon name="refresh" /><span>刷新状态</span></button><button class="button primary" :disabled="busy" @click="toggle">{{ state.enabled ? '关闭深搜' : '开启深搜' }}</button></div>
      <p v-if="message" class="tool-notice" role="status">{{ message }}</p>
      <p v-if="state.requiresReload" class="tool-notice">刷新来源页面后可观察初始化数据；已创建的 Worker 不保证能被补充观察。</p>
      <p v-if="!state.frames.length" class="tool-notice">{{ state.enabled ? '尚无探针状态，请刷新来源页面后重试。' : '开启深搜后可查看框架探针状态。' }}</p>
      <div class="probe-frame-list"><div v-for="frame in state.frames" :key="frame.frameId" class="probe-frame"><span>{{ frame.frameId === 0 ? '主页面' : '框架 ' + frame.frameId }}</span><span class="probe-url" :title="frame.url">{{ frame.url }}</span><span :class="{ 'probe-failure': frame.state === 'failed' }">{{ labels[frame.state] }}</span><p v-if="frame.error" class="probe-failure">{{ frame.error }}</p></div></div>
      <p v-if="state.enabled && !state.keys.length" class="privacy-hint">尚未发现密钥候选，不代表此页面不存在资源。</p>
      <details v-if="state.keys.length" class="key-candidates"><summary>{{ state.keys.length }} 个疑似 AES-128 密钥</summary><p>仅为候选，不会自动应用。可在 HLS 解析器中手动选择，验证通过后再下载。</p><p v-for="key in state.keys" :key="key.hex"><code>{{ key.hex }}</code> · {{ key.source }} · frame {{ key.frameId }}</p></details>
    </SfDialog>
  </div>
</template>