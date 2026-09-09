<script setup lang="ts">
import { toRef } from "vue";
import type { UiContext } from "../../types";
import { createCaptureState } from "../capture/state";
import { sessionError } from "../session-client";
const props = defineProps<{ context: UiContext | null }>();
const { sessions, catalog, error, message, busy, selected, acknowledged, directory, active, sourceKey, scan, start, stop, recover, refresh } = createCaptureState(toRef(props, "context"), true);
const labels: Record<string, string> = { armed: "等待数据", capturing: "捕捉中", stopping: "停止排空中", finalizing: "整理输出中", complete: "已保存", partial: "部分结果", interrupted: "已中断", unavailable: "检查点不可用" };
</script>
<template>
  <section class="feature-panel">
    <h3>缓存捕捉</h3><p>仅保存开启后的原始媒体数据，不回溯旧缓存，不处理 DRM。跳转或编码变化会分开保存，整理片段不会补齐遗漏数据。</p>
    <button class="button" :disabled="busy || !context?.supported || !!active" @click="scan">扫描媒体源</button>
    <label class="field"><span>媒体源</span><select v-model="selected" class="control" :disabled="busy || !!active"><option value="">请选择媒体源</option><option v-for="source in catalog.sources" :key="sourceKey(source)" :value="sourceKey(source)">{{ source.frameId === 0 ? '主页面' : `框架 ${source.frameId}` }} · {{ source.url }} · {{ source.tracks.join(', ') }} · {{ source.state }}</option></select></label>
    <p v-for="frame in catalog.frames.filter(item => item.state !== 'ready')" :key="frame.frameId">框架 {{ frame.frameId }} · {{ frame.url }}：{{ frame.state === 'unsupported' ? '此框架不支持捕捉' : sessionError(frame.error) }}</p>
    <label class="field"><span>保存目录（留空使用默认目录）</span><input v-model="directory" class="control" :disabled="busy || !!active" placeholder="绝对路径"></label>
    <label><input v-model="acknowledged" type="checkbox">我有权保存此媒体，并了解仅捕捉开启后的数据</label>
    <div class="feature-row"><button class="button primary" :disabled="busy || !context?.supported || !selected || !acknowledged || !!active" @click="start">开始捕捉</button><button class="button" :disabled="busy || !active || !['armed', 'capturing'].includes(active.state)" @click="stop">停止并保存</button><button class="button" @click="refresh">刷新会话</button></div>
    <p v-if="message" role="status">{{ message }}</p><p v-if="error" role="alert">{{ error }}</p>
    <article v-for="session in sessions" :key="session.id" class="feature-card">
      <strong>{{ labels[session.state] || session.state }} · {{ session.state === 'unavailable' ? '数据量未知' : `${(session.bytes / 1048576).toFixed(1)} MiB` }}</strong>
      <p v-if="session.source">框架 {{ session.source.frameId }} · {{ session.source.url }}</p>
      <p v-for="output in session.outputs" :key="output">{{ output }}</p><p v-if="session.error">{{ sessionError(session.error) }}</p>
      <button v-if="['partial', 'interrupted'].includes(session.state)" class="button" :disabled="busy" @click="recover(session.id)">整理已有片段</button>
      <p v-for="track in session.tracks" :key="track.id">轨道 {{ track.id }} · {{ track.mime }} · {{ track.initialized ? '含初始化片段' : '缺少初始化片段' }}</p>
    </article>
  </section>
</template>
