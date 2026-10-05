<script setup lang="ts">
import { computed } from "vue";
import type { ConnectionState } from "../task-state";
import { humanError } from "../store";
import NativeInstallGuide from "./NativeInstallGuide.vue";
const props = defineProps<{ state: ConnectionState; error: string }>();
defineEmits<{ retry: [] }>();
const labels: Record<ConnectionState, string> = { connecting: "正在连接本地助手", ready: "已连接", disconnected: "本地助手已断开", missing: "尚未安装本地助手", timeout: "本地助手响应超时", incompatible: "本地助手需要更新", error: "本地助手数据异常" };
// Reconnection attempts briefly report "connecting"; keep the install guide steady until the helper answers.
const guide = computed(() => props.error === "native_host_missing" ? "install" : props.error === "native_host_incompatible" ? "update" : "");
const label = computed(() => guide.value === "install" ? labels.missing : guide.value === "update" ? labels.incompatible : labels[props.state]);
</script>
<template>
  <div v-if="state !== 'ready'" class="status-banner connection-banner" :class="{ 'with-guide': guide }" role="status">
    <div><strong>{{ label }}</strong><p>{{ error ? humanError(error) : '资源发现和复制仍可使用。' }}</p></div>
    <button v-if="!guide" class="button" :disabled="state === 'connecting'" @click="$emit('retry')">重新连接</button>
    <NativeInstallGuide v-else :update="guide === 'update'" />
  </div>
</template>
