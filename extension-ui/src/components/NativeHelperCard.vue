<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { sendMessage } from "../api";
import { humanError } from "../store";
import NativeInstallGuide from "./NativeInstallGuide.vue";

const status = ref<"checking" | "ready" | "error">("checking");
const error = ref("");
let timer = 0;
let disposed = false;

async function check() {
  window.clearTimeout(timer);
  const result = await sendMessage<{ ok: boolean; error?: string }>({ type: "native.connect" }).catch(reason => ({ ok: false, error: reason?.message || "native_host_unavailable" }));
  if (disposed) return;
  status.value = result.ok ? "ready" : "error";
  error.value = result.ok ? "" : result.error || "native_host_disconnected";
  // Keep checking while the helper is unavailable so the card turns green right after installation.
  if (!result.ok) timer = window.setTimeout(check, 3000);
}
function onFocus() { if (status.value !== "ready") void check(); }
onMounted(() => { void check(); window.addEventListener("focus", onFocus); });
onBeforeUnmount(() => { disposed = true; window.clearTimeout(timer); window.removeEventListener("focus", onFocus); });
</script>

<template>
  <section class="settings-card" aria-labelledby="settings-native-title">
    <header><h4 id="settings-native-title">本地下载助手</h4><p>下载、HLS/DASH 合并与缓存捕捉由 Windows 本地助手完成。</p></header>
    <p v-if="status === 'checking'" class="settings-note">正在检查本地助手…</p>
    <p v-else-if="status === 'ready'" class="settings-note native-ready">已连接，可以开始下载。</p>
    <template v-else>
      <p class="settings-note">{{ humanError(error) }}</p>
      <NativeInstallGuide v-if="error === 'native_host_missing' || error === 'native_host_incompatible'" :update="error === 'native_host_incompatible'" />
      <div v-else><button class="button" type="button" @click="check">重新检查</button></div>
    </template>
  </section>
</template>
