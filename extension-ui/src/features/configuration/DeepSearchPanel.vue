<script setup lang="ts">
import { toRef } from "vue";
import type { UiContext } from "../../types";
import { createDeepSearchState } from "../deep-search/state";
const props = defineProps<{ context: UiContext | null }>();
const { state, remember, busy, message, refresh, toggle } = createDeepSearchState(toRef(props, "context"));
const labels = { ready: "探针已运行", disabled: "未开启", failed: "注入失败", unsupported: "不支持此框架" };
</script>
<template><section v-if="context?.supported" class="feature-panel">
  <div class="feature-row"><strong>深度搜索：{{ state.enabled ? '开启' : '关闭' }}</strong><button class="button" :disabled="busy" @click="toggle">{{ state.enabled ? '关闭' : '开启' }}</button><label><input v-model="remember" type="checkbox" :disabled="busy">记住此站点</label><button class="button" :disabled="busy" @click="refresh">刷新结果</button></div>
  <p v-if="message" role="status">{{ message }}</p><p v-if="state.requiresReload">刷新来源页面后可观察初始化数据；已创建的 Worker 不保证能被补充观察。</p>
  <p v-if="!state.frames.length">尚无框架探针状态，请刷新来源页面后重试。</p>
  <p v-for="frame in state.frames" :key="frame.frameId">框架 {{ frame.frameId }} · {{ frame.url }} · {{ labels[frame.state] }}<span v-if="frame.error">：{{ frame.error }}</span></p>
  <p v-if="state.enabled && !state.keys.length">尚未发现密钥候选，不代表此页面不存在资源；请同时查看资源列表和框架状态。</p>
  <details v-if="state.keys.length"><summary>{{ state.keys.length }} 个疑似 AES-128 密钥</summary><p>仅为候选，不会自动应用。可在 HLS 解析器中手动选择，验证通过后再下载。</p><p v-for="key in state.keys" :key="key.hex"><code>{{ key.hex }}</code> · {{ key.source }} · frame {{ key.frameId }}</p></details>
</section></template>
