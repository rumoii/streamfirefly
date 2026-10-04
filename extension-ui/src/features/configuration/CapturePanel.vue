<script setup lang="ts">
import { toRef } from "vue";
import type { UiContext } from "../../types";
import { createCaptureState } from "../capture/state";
import { sessionError } from "../session-client";
import { computed } from "vue";
import SfIcon from "../../ui/SfIcon.vue";
import SfSelect from "../../ui/SfSelect.vue";
const props = defineProps<{ context: UiContext | null; targetObjectUrl?: string }>();
const { sessions, catalog, error, message, busy, selected, acknowledged, directory, active, sourceKey, scan, start, stop, recover, refresh } = createCaptureState(toRef(props, "context"), true, toRef(props, "targetObjectUrl"));
const labels: Record<string, string> = { armed: "等待数据", capturing: "捕捉中", stopping: "停止排空中", finalizing: "整理输出中", complete: "已保存", partial: "部分结果", interrupted: "已中断", unavailable: "检查点不可用" };
const sourceOptions = computed(() => [{ value: "", label: props.targetObjectUrl ? "尚未定位对应媒体源" : "请选择媒体源" }, ...catalog.value.sources.map(source => ({ value: sourceKey(source), label: `${source.frameId === 0 ? "主页面" : `框架 ${source.frameId}`} · ${source.url} · ${source.tracks.join(", ")} · ${source.state}` }))]);
</script>
<template>
  <section class="feature-panel capture-panel">
    <section class="feature-card">
      <h4>捕捉设置</h4>
      <p class="feature-note">仅保存开启后的原始媒体数据，不回溯旧缓存，不处理 DRM。跳转或编码变化会分开保存，整理片段不会补齐遗漏数据。</p>
      <p v-if="targetObjectUrl" class="tool-notice">正在处理资源列表中的 Blob 临时媒体；开始捕捉后请回到来源页面，从头重新播放视频。</p>
      <div class="capture-source-row"><div class="field"><span>媒体源</span><SfSelect v-model="selected" :options="sourceOptions" label="媒体源" :disabled="busy || !!active || !!targetObjectUrl" /></div><button class="button" :disabled="busy || !context?.supported || !!active" @click="scan"><SfIcon name="radar-2" /><span>扫描媒体源</span></button></div>
      <p v-for="frame in catalog.frames.filter(item => item.state !== 'ready')" :key="frame.frameId" class="feature-note">框架 {{ frame.frameId }} · {{ frame.url }}：{{ frame.state === 'unsupported' ? '此框架不支持捕捉' : sessionError(frame.error) }}</p>
      <label class="field"><span>保存目录（留空使用默认目录）</span><input v-model="directory" class="control" :disabled="busy || !!active" placeholder="绝对路径"></label>
      <label class="feature-check"><input v-model="acknowledged" type="checkbox">我有权保存此媒体，并了解仅捕捉开启后的数据</label>
      <div class="feature-row"><button class="button primary" :disabled="busy || !context?.supported || !selected || !acknowledged || !!active" @click="start"><SfIcon name="capture" /><span>开始捕捉</span></button><button class="button" :disabled="busy || !active || !['armed', 'capturing'].includes(active.state)" @click="stop"><SfIcon name="player-stop" /><span>停止并保存</span></button><button class="button ghost" @click="refresh"><SfIcon name="refresh" /><span>刷新会话</span></button></div>
    </section>
    <p v-if="message" class="feature-message" role="status">{{ message }}</p><p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <article v-for="session in sessions" :key="session.id" class="feature-rule capture-session">
      <div class="dispatch-item-head"><span class="dispatch-state" :data-state="session.state">{{ labels[session.state] || session.state }}</span><strong>{{ session.state === 'unavailable' ? '数据量未知' : `${(session.bytes / 1048576).toFixed(1)} MiB` }}</strong></div>
      <p v-if="session.source" class="feature-note">框架 {{ session.source.frameId }} · {{ session.source.url }}</p>
      <p v-for="output in session.outputs" :key="output" class="capture-output">{{ output }}</p><p v-if="session.error" class="inline-error">{{ sessionError(session.error) }}</p>
      <p v-for="track in session.tracks" :key="track.id" class="feature-note">轨道 {{ track.id }} · {{ track.mime }} · {{ track.initialized ? '含初始化片段' : '缺少初始化片段' }}</p>
      <div v-if="['partial', 'interrupted'].includes(session.state)" class="feature-row"><button class="button sm" :disabled="busy" @click="recover(session.id)">整理已有片段</button></div>
    </article>
  </section>
</template>
