<script setup lang="ts">
import { computed, ref } from "vue";
import { extensionApi } from "../api";
import { INSTALL_GUIDE_URL, currentInstallCommand } from "../native-install";

const props = defineProps<{ update?: boolean }>();
const field = ref<HTMLInputElement | null>(null);
const copied = ref(false);
const command = computed(() => { try { return currentInstallCommand(extensionApi()); } catch { return ""; } });
const title = computed(() => props.update ? "一键更新本地下载助手" : "一键安装本地下载助手");

async function copy() {
  try { await navigator.clipboard.writeText(command.value); }
  catch { field.value?.select(); document.execCommand("copy"); }
  copied.value = true;
}
</script>

<template>
  <section class="native-install" aria-labelledby="native-install-title">
    <h4 id="native-install-title">{{ title }}</h4>
    <template v-if="command">
      <ol>
        <li>点击“复制安装命令”。</li>
        <li>按 <kbd>Win</kbd> + <kbd>R</kbd> 打开“运行”窗口。</li>
        <li>按 <kbd>Ctrl</kbd> + <kbd>V</kbd> 粘贴，再按回车。</li>
      </ol>
      <div class="native-install-command">
        <input ref="field" class="control" :value="command" readonly aria-label="安装命令" @focus="field?.select()">
        <button class="button primary" type="button" @click="copy">{{ copied ? '已复制' : '复制安装命令' }}</button>
      </div>
      <p class="settings-note">安装完成后这里会自动连接。无需管理员权限；安装包从 GitHub Release 下载并校验 SHA-256。{{ update ? '如提示助手正在使用，请先关闭浏览器再运行。' : '' }}</p>
    </template>
    <p v-else class="settings-note">当前环境无法生成安装命令。</p>
    <p class="settings-note"><a :href="INSTALL_GUIDE_URL" target="_blank" rel="noreferrer">手动安装说明</a></p>
  </section>
</template>
