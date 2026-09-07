<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import type { UiContext } from "../../types";
import { configurationRequest } from "./client";
import { sendMessage, surfaceFromUrl } from "../../api";
const props = defineProps<{ context: UiContext | null }>();
interface Capture { id: string; state: string; bytes: number; output?: string; outputs: string[]; error?: string; tracks: { id: number; mime: string; bytes: number; initialized: boolean }[] }
const sessions = ref<Capture[]>([]), error = ref("");
const busy = ref(false), acknowledged = ref(false);
const trusted = surfaceFromUrl() !== "workspace";
const sources = ref<{ id: string; state: string; tracks: string[] }[]>([]);
const sourceId = ref("");
const directory = ref("");
let refreshing = false;
watch(() => props.context?.sourceContextId, () => { sources.value = []; sourceId.value = ""; acknowledged.value = false; });
async function loadSources() { if (!props.context) return; try { sources.value = await configurationRequest("capture.sources", { tabId: props.context.sourceTabId }); sourceId.value = sources.value.length === 1 ? sources.value[0].id : ""; } catch (reason) { error.value = reason instanceof Error ? reason.message : "读取媒体源失败"; } }
async function openControl() { const result = await sendMessage({ type: "capture.control.open", payload: { tabId: props.context?.sourceTabId } }); if (!result?.ok) error.value = result?.error || "无法打开捕捉控制页"; }
let timer: ReturnType<typeof setTimeout> | null = null;
let disposed = false;
async function refresh() { if (disposed || refreshing) return; refreshing = true; if (timer) clearTimeout(timer); try { const result = await configurationRequest<Capture[]>("capture.list"); if (!disposed) sessions.value = result; } catch (reason) { if (!disposed) error.value = reason instanceof Error ? reason.message : "读取失败"; } finally { refreshing = false; if (!disposed) timer = setTimeout(refresh, 1500); } }
async function start() { if (!props.context || !acknowledged.value) return; busy.value = true; error.value = ""; try { await configurationRequest("capture.open", { tabId: props.context.sourceTabId, sourceContextId: props.context.sourceContextId, sourceId: sourceId.value, directory: directory.value }); if (timer) clearTimeout(timer); await refresh(); } catch (reason) { error.value = reason instanceof Error ? reason.message : "启动失败"; } finally { busy.value = false; } }
async function stop() { if (!props.context) return; busy.value = true; try { await configurationRequest("capture.close", { tabId: props.context.sourceTabId }); } catch (reason) { error.value = reason instanceof Error ? reason.message : "停止失败"; } finally { busy.value = false; } }
onBeforeUnmount(() => { disposed = true; if (timer) clearTimeout(timer); });
const labels: Record<string, string> = { armed: "等待数据", capturing: "捕捉中", stopping: "停止中", finalizing: "合并中", complete: "已保存", partial: "部分结果", interrupted: "已中断" };
function refreshNow() { if (timer) clearTimeout(timer); void refresh(); }
async function recover(id: string) { try { await configurationRequest("capture.recover", { id }); refreshNow(); } catch (reason) { error.value = reason instanceof Error ? reason.message : "恢复失败"; } }
</script>
<template><section v-if="!trusted" class="feature-panel"><strong>缓存捕捉</strong><p>在独立扩展页面选择媒体源、开启捕捉及整理片段。</p><button class="button" :disabled="!context?.supported" @click="openControl">打开捕捉控制页</button><p v-if="error" role="alert">{{ error }}</p></section><details v-else class="feature-panel"><summary>缓存捕捉</summary><p>仅捕捉开启后送入媒体缓冲区的数据，不能补回已经缓冲的内容。请先暂停播放，开启后重新播放；可选择媒体源；不选择时捕捉首个新增数据的媒体源，不混合多个视频。跳转或编码变化时分段保存，不拼接不同时间线；缺少初始化片段时保留原始轨道并标记部分结果。</p><div class="feature-row"><button class="button" @click="loadSources">读取媒体源</button><select v-model="sourceId" class="control" aria-label="捕捉媒体源"><option value="">首个新增数据的媒体源</option><option v-for="source in sources" :key="source.id" :value="source.id">媒体源 {{ source.id }} · {{ source.state }} · {{ source.tracks.join(" / ") }}</option></select></div><label class="field"><span>捕捉保存目录（留空使用助手默认目录）</span><input v-model="directory" class="control" placeholder="本机绝对路径"></label><label><input v-model="acknowledged" type="checkbox">当前页面仅播放一个已获授权的视频</label><div class="feature-row"><button class="button primary" :disabled="busy || !acknowledged || !context?.supported" @click="start">开启捕捉</button><button class="button" :disabled="busy" @click="stop">停止并保存</button><button class="button" @click="refreshNow">刷新会话</button></div><article v-for="session in sessions" :key="session.id" class="feature-rule"><strong>{{ labels[session.state] || session.state }} · {{ (session.bytes / 1048576).toFixed(1) }} MiB</strong><p v-for="output in session.outputs" :key="output">{{ output }}</p><p v-if="session.error">{{ session.error }}</p><button v-if="['partial', 'interrupted'].includes(session.state)" class="button" @click="recover(session.id)">整理已有片段</button><p v-for="track in session.tracks" :key="track.id">轨道 {{ track.id }} · {{ track.mime }} · {{ track.initialized ? '含初始化片段' : '缺少初始化片段' }}</p></article><p v-if="error" role="alert">{{ error }}</p></details></template>
