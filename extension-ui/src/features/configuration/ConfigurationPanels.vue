<script setup lang="ts">
import { ref } from "vue";
import { surfaceFromUrl } from "../../api";
import { openTrustedSettings } from "./client";
import RulesPanel from "./RulesPanel.vue";
import ToolsPanel from "./ToolsPanel.vue";
import TemplatesPanel from "./TemplatesPanel.vue";
const trusted = surfaceFromUrl() !== "workspace";
const section = ref("rules");
</script>
<template><section class="feature-settings"><template v-if="trusted"><nav class="feature-row" aria-label="高级设置分类"><button v-for="item in [{ id: 'rules', name: '识别规则' }, { id: 'tools', name: '外部工具' }, { id: 'templates', name: '模板' }]" :key="item.id" class="button" :class="{ primary: section === item.id }" @click="section = item.id">{{ item.name }}</button></nav><RulesPanel v-if="section === 'rules'" /><ToolsPanel v-else-if="section === 'tools'" /><TemplatesPanel v-else /></template><div v-else class="panel feature-panel"><h3>规则与外部工具</h3><p>程序路径、调用目标与敏感字段授权只在独立扩展设置页管理，网页不能修改。</p><button class="button" @click="openTrustedSettings">打开扩展设置</button></div></section></template>
