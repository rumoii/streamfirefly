
<script setup lang="ts">
import { onMounted, ref, toRaw } from "vue";
import { defaultDiscovery, validateDiscovery, type DetectionRule, type DiscoveryConfig, type DetectionResult } from "../../../../shared/discovery";
import { configurationRequest } from "./client";
import SfIcon from "../../ui/SfIcon.vue";
import SfSelect from "../../ui/SfSelect.vue";

const config = ref(defaultDiscovery());
const message = ref("");
const busy = ref(false);
const disabled = ref<Record<string, string>>({});
const sample = ref({ url: "https://cdn.example.com/video.mp4", mime: "video/mp4", pageUrl: "https://example.com/watch", size: "" });
const result = ref<DetectionResult | null>(null);
const transfer = ref("");
const kindOptions = ["video", "audio", "image", "hls", "dash", "segment"].map(value => ({ value, label: value }));
const siteModes = [{ value: "exclude", label: "排除下列站点" }, { value: "include", label: "仅在下列站点识别" }];
const actions = [{ value: "include", label: "识别" }, { value: "exclude", label: "排除" }];
const fields = [{ value: "extension", label: "后缀" }, { value: "mime", label: "MIME" }, { value: "url", label: "URL 正则" }];
async function perform(action: () => Promise<void>) { busy.value = true; message.value = ""; try { await action(); } catch (error) { message.value = error instanceof Error ? error.message : "操作失败"; } finally { busy.value = false; } }
onMounted(() => perform(async () => { const response = await configurationRequest<{ config: DiscoveryConfig; disabled: Record<string, string>; error: string }>("discovery.get"); config.value = response.config; disabled.value = response.disabled; message.value = response.error; }));
function add() { config.value.rules.push({ id: crypto.randomUUID(), name: "新规则", enabled: true, action: "include", field: "extension", pattern: "mp4", kind: "video", sites: [] }); }
function duplicate(index: number) { if (config.value.rules.length >= 100) return; const rule = structuredClone(toRaw(config.value.rules[index])); rule.id = crypto.randomUUID(); rule.name += " 副本"; config.value.rules.splice(index + 1, 0, rule); }
function move(index: number, offset: number) { const rules = config.value.rules; const [rule] = rules.splice(index, 1); rules.splice(index + offset, 0, rule); }
function domains(value: string) { return value.split(/[,\s]+/).map(item => item.trim()).filter(Boolean); }
function patchSites(rule: DetectionRule, event: Event) { rule.sites = domains((event.target as HTMLInputElement).value); }
async function save() { await perform(async () => { await configurationRequest("discovery.save", validateDiscovery(toRaw(config.value))); disabled.value = {}; message.value = "规则已保存；已保留的资源会重新评估，历史未收集资源需刷新来源页面。"; }); }
async function test() { await perform(async () => { result.value = null; result.value = await configurationRequest("discovery.test", { config: validateDiscovery(toRaw(config.value)), sample: { ...sample.value, size: sample.value.size === "" ? null : Number(sample.value.size) } }); }); }
function exportConfig() { transfer.value = JSON.stringify(config.value, null, 2); }
function importConfig() { try { config.value = validateDiscovery(JSON.parse(transfer.value)); message.value = "已载入草稿，请检查后保存。"; } catch (error) { message.value = error instanceof Error ? error.message : "导入失败"; } }

</script>
<template>
  <section class="feature-panel">
    <header class="feature-head"><div><h3>识别规则</h3><p>在资源进入列表之前识别或排除。排除优先，识别规则按顺序首次命中。</p></div><div class="feature-head-actions"><button class="button" :disabled="busy || config.rules.length >= 100" @click="add"><SfIcon name="filter" /><span>新增规则</span></button><button class="button primary" :disabled="busy" @click="save">保存规则</button></div></header>
    <p v-if="message" class="feature-message" role="status">{{ message }}</p>
    <section class="feature-card">
      <div class="feature-grid"><div class="field"><span>站点模式</span><SfSelect v-model="config.siteMode" :options="siteModes" label="站点模式" /></div><label class="field"><span>站点域名（空格分隔）</span><input class="control" :value="config.sites.join(' ')" @change="config.sites = domains(($event.target as HTMLInputElement).value)" placeholder="example.com *.example.org"></label></div>
    </section>
    <article v-for="(rule, index) in config.rules" :key="rule.id" class="feature-rule" :class="{ disabled: !rule.enabled }">
      <div class="feature-rule-head"><label class="switch" title="启用"><input v-model="rule.enabled" type="checkbox" aria-label="启用规则"><i></i></label><input v-model="rule.name" class="control" aria-label="规则名称"><div class="feature-rule-tools"><button class="icon-button" type="button" aria-label="上移" title="上移" :disabled="index === 0" @click="move(index, -1)"><SfIcon name="chevron-up" /></button><button class="icon-button" type="button" aria-label="下移" title="下移" :disabled="index === config.rules.length - 1" @click="move(index, 1)"><SfIcon name="chevron-down" /></button><button class="icon-button" type="button" aria-label="复制" title="复制" :disabled="config.rules.length >= 100" @click="duplicate(index)"><SfIcon name="copy" /></button><button class="icon-button danger" type="button" aria-label="删除" title="删除" @click="config.rules.splice(index, 1)"><SfIcon name="trash" /></button></div></div>
      <div class="feature-grid"><div class="field"><span>动作</span><SfSelect v-model="rule.action" :options="actions" label="动作" /></div><div class="field"><span>匹配字段</span><SfSelect v-model="rule.field" :options="fields" label="匹配字段" /></div><label class="field"><span>表达式</span><input v-model="rule.pattern" class="control"></label><div class="field"><span>资源类型</span><SfSelect v-model="rule.kind" :options="kindOptions" label="资源类型" /></div><label class="field"><span>最小字节数</span><input v-model.number="rule.minBytes" class="control" type="number" min="0" @change="rule.minBytes = rule.minBytes === ('' as unknown) ? null : rule.minBytes"></label><label class="field"><span>最大字节数</span><input v-model.number="rule.maxBytes" class="control" type="number" min="0" @change="rule.maxBytes = rule.maxBytes === ('' as unknown) ? null : rule.maxBytes"></label><label class="field"><span>适用站点（留空为全部）</span><input class="control" :value="rule.sites.join(' ')" @change="patchSites(rule, $event)"></label><label v-if="rule.field === 'url'" class="field"><span>正则标志</span><input v-model="rule.flags" class="control" placeholder="i 或 u"></label></div>
      <p v-if="disabled[rule.id]" class="inline-error" role="alert">{{ disabled[rule.id] }}</p>
    </article>
    <div v-if="!config.rules.length" class="feature-empty">还没有识别规则。未命中规则的资源按内置识别处理。</div>
    <details class="feature-details"><summary><span>测试当前草稿（不保存）</span><SfIcon name="chevron-down" /></summary><div class="feature-details-body"><div class="feature-grid"><label v-for="(_value, key) in sample" :key="key" class="field"><span>{{ key }}</span><input v-model="sample[key]" class="control"></label></div><div class="feature-row"><button class="button" :disabled="busy" @click="test">运行测试</button></div><div v-if="result" class="feature-result" role="status"><strong>{{ result.kind || '未收集' }} · {{ result.reason }}</strong><ol v-if="result?.steps"><li v-for="step in result.steps" :key="step.ruleId">{{ step.name }}：{{ step.reason }}</li></ol></div></div></details>
    <details class="feature-details"><summary><span>配置导入 / 导出</span><SfIcon name="chevron-down" /></summary><div class="feature-details-body"><textarea v-model="transfer" class="control feature-code" aria-label="识别配置 JSON"></textarea><div class="feature-row"><button class="button" @click="exportConfig">生成导出内容</button><button class="button" @click="importConfig">载入草稿</button></div></div></details>
  </section>
</template>
