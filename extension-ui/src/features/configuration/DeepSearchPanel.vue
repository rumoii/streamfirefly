<script setup lang="ts">
import { ref, watch } from "vue";
import { configurationRequest } from "./client";
import type { UiContext } from "../../types";
const props = defineProps<{ context: UiContext | null }>();
const enabled = ref(false), remember = ref(false), busy = ref(false);
const keys = ref<{ hex: string; source: string; frameId: number }[]>([]);
const message = ref("");
let sequence = 0;
async function refresh() { const current = ++sequence; if (!props.context?.supported) return; try { const state = await configurationRequest<{ enabled: boolean; keys: typeof keys.value }>("deep.status", { tabId: props.context.sourceTabId }); if (current !== sequence) return; enabled.value = state.enabled; keys.value = state.keys; } catch (error) { if (current === sequence) message.value = error instanceof Error ? error.message : "读取失败"; } }
watch(() => props.context?.sourceContextId, () => { keys.value = []; message.value = ""; void refresh(); }, { immediate: true });
async function toggle() { if (!props.context?.supported) return; busy.value = true; try { const result = await configurationRequest<{ enabled: boolean; failedFrames: number }>("deep.set", { tabId: props.context.sourceTabId, enabled: !enabled.value, remember: remember.value }); enabled.value = result.enabled; keys.value = []; message.value = result.enabled ? `已开启，刷新来源页面可捕获初始化数据；${result.failedFrames} 个框架未能注入。` : "已关闭，疑似密钥已清理。"; } catch (error) { message.value = error instanceof Error ? error.message : "操作失败"; } finally { busy.value = false; } }
</script>
<template><section v-if="context?.supported" class="feature-panel"><div class="feature-row"><strong>深度搜索：{{ enabled ? '开启' : '关闭' }}</strong><button class="button" :disabled="busy" @click="toggle">{{ enabled ? '关闭' : '开启' }}</button><label><input v-model="remember" type="checkbox">记住此站点</label><button class="button" @click="refresh">刷新结果</button></div><p v-if="message" role="status">{{ message }}</p><details v-if="keys.length"><summary>{{ keys.length }} 个疑似 AES-128 密钥</summary><p>仅为候选，不会自动应用。可复制到 HLS 解析器的手动密钥输入，首片验证通过后才用于下载。</p><p v-for="key in keys" :key="key.hex"><code>{{ key.hex }}</code> · {{ key.source }} · frame {{ key.frameId }}</p></details></section></template>
