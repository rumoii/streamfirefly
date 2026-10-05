<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { extensionApi, surfaceFromUrl } from "../api";
import { openTrustedSettings } from "../features/configuration/client";
import RulesPanel from "../features/configuration/RulesPanel.vue";
import ExtractionPanel from "../features/configuration/ExtractionPanel.vue";
import ToolsPanel from "../features/configuration/ToolsPanel.vue";
import TemplatesPanel from "../features/configuration/TemplatesPanel.vue";
import { validateProxyUrl, type AppSettings } from "../features/settings/state";
import SfIcon from "../ui/SfIcon.vue";
import SfSelect from "../ui/SfSelect.vue";
import type { IconName } from "../ui/icons";
import { EDITION, EDITION_LABEL } from "../edition";
import NativeHelperCard from "./NativeHelperCard.vue";

const props = defineProps<{ settings: AppSettings }>();
const emit = defineEmits<{ save: [settings: typeof props.settings]; reset: [] }>();
const form = reactive({ ...props.settings });
watch(() => props.settings, value => Object.assign(form, value), { deep: true });
const trusted = surfaceFromUrl() !== "workspace";
const version = String(extensionApi()?.runtime?.getManifest?.().version || "");
const section = ref("general");
const panels = { rules: RulesPanel, extraction: ExtractionPanel, tools: ToolsPanel, templates: TemplatesPanel };
const currentPanel = computed(() => panels[section.value as keyof typeof panels]);
const categories: { id: string; name: string; icon: IconName }[] = [{ id: "general", name: "常规", icon: "settings" }, ...(trusted ? [{ id: "rules", name: "识别规则", icon: "filter" as IconName }, { id: "extraction", name: "URL 提取", icon: "link" as IconName }, { id: "tools", name: "外部工具", icon: "external-link" as IconName }, { id: "templates", name: "输出模板", icon: "template" as IconName }] : [{ id: "advanced", name: "高级设置", icon: "adjustments-horizontal" as IconName }])];
const proxyOptions: { value: AppSettings["proxyMode"]; label: string }[] = [{ value: "system", label: "跟随 Windows 系统代理" }, { value: "direct", label: "直连" }, { value: "custom", label: "自定义代理" }];
const sniffOptions: { value: AppSettings["sniffMode"]; label: string }[] = [{ value: "on_open", label: "打开流萤时嗅探（默认）" }, { value: "always", label: "始终嗅探" }];
const proxyError = computed(() => form.proxyMode === "custom" ? validateProxyUrl(form.proxyUrl) : "");
const hasUnsavedChanges = computed(() => JSON.stringify(form) !== JSON.stringify(props.settings));
defineExpose({ hasUnsavedChanges });
</script>

<template>
  <section class="settings-page settings-layout">
    <nav class="settings-navigation" aria-label="设置分类">
      <button v-for="category in categories" :key="category.id" type="button" :class="{ selected: section === category.id }" :aria-current="section === category.id ? 'page' : undefined" aria-controls="settings-content" @click="section = category.id"><SfIcon :name="category.icon" />{{ category.name }}</button>
    </nav>
    <div id="settings-content" class="settings-content">
      <section v-show="section === 'general'" class="settings-general" aria-label="常规设置">
        <header class="settings-section-head"><div><h3>常规</h3><p>设置默认下载方式和媒体识别偏好。</p></div></header>
        <NativeHelperCard v-if="trusted" />
        <section class="settings-card" aria-labelledby="settings-download-title">
          <header><h4 id="settings-download-title">下载</h4><p>保存位置、并发数与网络代理。</p></header>
          <div class="settings-fields">
            <label class="field"><span>默认保存目录</span><input v-model="form.saveDir" class="control" placeholder="例如 D:\Downloads\StreamFirefly"><small>留空时使用系统默认目录；请填写绝对路径。</small></label>
            <div class="settings-field-row">
              <label class="field"><span>下载并发数</span><input v-model.number="form.downloadThreads" class="control" type="number" min="1" max="16"><small>支持 Range 的普通文件建议使用 4–8 路。</small></label>
              <div class="field"><span>下载代理</span><SfSelect v-model="form.proxyMode" :options="proxyOptions" label="下载代理" /><small>系统模式读取 Windows 固定代理；PAC/WPAD 请使用自定义代理。</small></div>
            </div>
            <label v-if="form.proxyMode === 'custom'" class="field"><span>自定义代理地址</span><input v-model="form.proxyUrl" class="control" placeholder="例如 http://127.0.0.1:7897"><small :class="{ 'error-text': proxyError }">{{ proxyError || '支持 HTTP/HTTPS，不保存代理账号密码。' }}</small></label>
          </div>
        </section>
        <section class="settings-card" aria-labelledby="settings-detect-title">
          <header><h4 id="settings-detect-title">媒体识别</h4><p>嗅探时机保存后立即生效；其他识别偏好修改后刷新来源网页生效。</p></header>
          <div class="field"><span>嗅探时机</span><SfSelect v-model="form.sniffMode" :options="sniffOptions" label="嗅探时机" /><small>打开流萤后嗅探当前标签页，收起为小入口后继续嗅探；关闭后保留已发现的资源。</small></div>
          <div class="toggle-list">
            <label class="toggle-row"><span><strong>识别图片</strong><small>显示 JPG、PNG、GIF 和 WebP 图片资源。</small></span><input v-model="form.detectImages" type="checkbox"><i></i></label>
            <label class="toggle-row"><span><strong>高级深度搜索</strong><small>额外观察页面解码和 Worker；可能影响少数复杂网站。</small></span><input v-model="form.advancedDeepSearch" type="checkbox"><i></i></label>
          </div>
        </section>
        <section class="settings-card" aria-labelledby="settings-edition-title">
          <header><h4 id="settings-edition-title">版本</h4><p>{{ EDITION_LABEL }} {{ version }}</p></header>
          <p v-if="EDITION === 'chrome-store'" class="settings-note">根据 Chrome 应用商店政策，此版本不识别和下载 YouTube 内容。</p>
          <p v-else class="settings-note">通用版不限制网站；能否识别和下载取决于网站本身，DRM 加密内容不受支持。</p>
        </section>
        <footer class="settings-footer"><span class="save-state" :class="{ dirty: hasUnsavedChanges }" role="status">{{ hasUnsavedChanges ? '有未保存的修改' : '已保存' }}</span><button class="button" type="button" @click="emit('reset')">恢复默认</button><button class="button primary" type="button" :disabled="Boolean(proxyError)" @click="emit('save', { ...form })">验证并保存</button></footer>
      </section>
      <KeepAlive><component :is="currentPanel" v-if="trusted && currentPanel" :key="section" /></KeepAlive>
      <section v-if="!trusted && section === 'advanced'" class="settings-general">
        <header class="settings-section-head"><div><h3>高级设置</h3><p>规则、程序路径、调用目标与敏感字段授权只在独立扩展设置页管理。</p></div></header>
        <div class="settings-card settings-link-card"><SfIcon name="adjustments-horizontal" :size="20" /><div><strong>在扩展设置页中管理</strong><p>识别规则、URL 提取、外部工具和输出模板涉及凭据与本机程序，不在网页内的工作区中修改。</p></div><button class="button" type="button" @click="openTrustedSettings"><SfIcon name="external-link" /><span>打开扩展设置</span></button></div>
      </section>
    </div>
  </section>
</template>
