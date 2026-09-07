<script setup lang="ts">
import type { ConnectionState } from "../task-state";
import { humanError } from "../store";
defineProps<{ state: ConnectionState; error: string }>();
defineEmits<{ retry: [] }>();
const labels: Record<ConnectionState, string> = { connecting: "正在连接本地助手", ready: "已连接", disconnected: "本地助手已断开", timeout: "本地助手响应超时", incompatible: "扩展与本地助手需要成套更新", error: "本地助手数据异常" };
</script>
<template>
  <div v-if="state !== 'ready'" class="status-banner connection-banner" role="status"><div><strong>{{ labels[state] }}</strong><p>{{ error ? humanError(error) : '资源发现和复制仍可使用。' }}</p></div><button class="button" :disabled="state === 'connecting'" @click="$emit('retry')">重新连接</button></div>
</template>
