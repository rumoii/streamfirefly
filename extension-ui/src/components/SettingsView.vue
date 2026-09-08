<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { surfaceFromUrl } from "../api";
import { openTrustedSettings } from "../features/configuration/client";
import RulesPanel from "../features/configuration/RulesPanel.vue";
import ExtractionPanel from "../features/configuration/ExtractionPanel.vue";
import ToolsPanel from "../features/configuration/ToolsPanel.vue";
import TemplatesPanel from "../features/configuration/TemplatesPanel.vue";

const props = defineProps<{ settings: { saveDir: string; downloadThreads: number; detectImages: boolean; advancedDeepSearch: boolean; candidateSort: string } }>();
const emit = defineEmits<{ save: [settings: typeof props.settings]; reset: [] }>();
const form = reactive({ ...props.settings });
watch(() => props.settings, value => Object.assign(form, value), { deep: true });
const trusted = surfaceFromUrl() !== "workspace";
const section = ref("general");
const panels = { rules: RulesPanel, extraction: ExtractionPanel, tools: ToolsPanel, templates: TemplatesPanel };
const currentPanel = computed(() => panels[section.value as keyof typeof panels]);
const categories = [{ id: "general", name: "常规", icon: "⚙" }, ...(trusted ? [{ id: "rules", name: "识别规则", icon: "≡" }, { id: "extraction", name: "URL 提取", icon: "↗" }, { id: "tools", name: "外部工具", icon: "↔" }, { id: "templates", name: "输出模板", icon: "◇" }] : [{ id: "advanced", name: "高级设置", icon: "↗" }])];
</script>

<template>
  <section class="settings-page settings-layout panel">
    <header class="settings-heading"><h2>设置</h2><p>配置媒体发现与下载方式</p></header>
    <nav class="settings-navigation" aria-label="设置分类">
      <button v-for="category in categories" :key="category.id" type="button" :class="{ selected: section === category.id }" :aria-current="section === category.id ? 'page' : undefined" aria-controls="settings-content" @click="section = category.id"><span aria-hidden="true">{{ category.icon }}</span>{{ category.name }}</button>
    </nav>
    <div id="settings-content" class="settings-content">
      <section v-show="section === 'general'" class="settings-general" aria-label="常规设置">
        <header><h3>常规</h3><p>设置默认下载方式和媒体识别偏好。</p></header>
        <div class="settings-fields">
          <label class="field"><span>默认保存目录</span><input v-model="form.saveDir" class="control" placeholder="例如 D:\Downloads\StreamFirefly"><small>留空时使用系统默认目录；请填写绝对路径。</small></label>
          <label class="field compact"><span>下载并发数</span><input v-model.number="form.downloadThreads" class="control" type="number" min="1" max="16"><small>支持 Range 的普通文件建议使用 4–8 路。</small></label>
        </div>
        <div class="settings-preferences"><h4>媒体识别</h4><p>修改后刷新来源网页生效。</p><div class="toggle-list">
          <label class="toggle-row"><span><strong>识别图片</strong><small>显示 JPG、PNG、GIF 和 WebP 图片资源。</small></span><input v-model="form.detectImages" type="checkbox"><i></i></label>
          <label class="toggle-row"><span><strong>高级深度搜索</strong><small>额外观察页面解码和 Worker；可能影响少数复杂网站。</small></span><input v-model="form.advancedDeepSearch" type="checkbox"><i></i></label>
        </div></div>
        <footer class="settings-footer"><span>修改后需保存</span><button class="button" type="button" @click="emit('reset')">恢复默认</button><button class="button primary" type="button" @click="emit('save', { ...form })">验证并保存</button></footer>
      </section>
      <KeepAlive><component :is="currentPanel" v-if="trusted && currentPanel" :key="section" /></KeepAlive>
      <section v-if="!trusted && section === 'advanced'" class="settings-general"><header><h3>高级设置</h3><p>规则、程序路径、调用目标与敏感字段授权只在独立扩展设置页管理。</p></header><button class="button" @click="openTrustedSettings">打开扩展设置</button></section>
    </div>
  </section>
</template>
