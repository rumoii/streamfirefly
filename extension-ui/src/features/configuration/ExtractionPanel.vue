<script setup lang="ts">
import { onMounted, ref, toRaw } from "vue";
import { defaultExtraction, validateExtraction, type ExtractionState, type ExtractionSaveResult, type ExtractionResult } from "../../../../shared/extraction";
import { configurationRequest } from "./client";
const config = ref(defaultExtraction());
const sample = ref({ url: "https://api.example.com/watch?media=https%3A%2F%2Fcdn.example.com%2Fvideo.m3u8", pageUrl: "https://example.com/watch" });
const result = ref<ExtractionResult | null>(null);
const busy = ref(false), message = ref(""), transfer = ref("");
const disabled = ref<Record<string, string>>({});
async function perform(operation: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true; message.value = "";
  try { await operation(); } catch (error) { message.value = error instanceof Error ? error.message : "操作失败"; }
  finally { busy.value = false; }
}
onMounted(() => perform(async () => { const response = await configurationRequest<ExtractionState>("extraction.get"); config.value = response.config; message.value = response.error; disabled.value = response.disabled; }));
function add() { config.value.rules.push({ id: crypto.randomUUID(), name: "新提取规则", enabled: false, sites: [], pattern: "[?&]media=([^&]+)", flags: "i", output: "$1", decode: true, kind: "hls" }); result.value = null; }
function move(index: number, offset: number) { const [rule] = config.value.rules.splice(index, 1); config.value.rules.splice(index + offset, 0, rule); }
async function save() { await perform(async () => { const response = await configurationRequest<ExtractionSaveResult>("extraction.save", validateExtraction(toRaw(config.value))); config.value = response.config; disabled.value = response.disabled; result.value = null; message.value = response.cleanup.status === "failed" ? `提取配置已保存并生效，但旧候选清理未完成：${response.cleanup.error}。请再次点击“保存提取配置”重试清理，已创建任务不受影响。` : "提取配置已保存，仅由旧配置产生的候选已清理；新请求到来后重新提取，已创建任务不受影响。"; }); }
async function test() { await perform(async () => { result.value = null; result.value = await configurationRequest("extraction.test", { config: validateExtraction(toRaw(config.value)), sample: { ...sample.value } }); }); }
function importConfig() { try { config.value = validateExtraction(JSON.parse(transfer.value)); result.value = null; message.value = "已载入草稿，核对后保存。"; } catch (error) { message.value = error instanceof Error ? error.message : "导入失败"; } }
</script>

<template>
  <section class="panel feature-panel">
    <header><h3>URL 提取</h3><p>从请求地址提取媒体链接，按顺序取首条匹配。不覆盖原资源，不自动下载或发送，也不继承原请求凭据。</p></header>
    <fieldset :disabled="busy">
      <article v-for="(rule, index) in config.rules" :key="rule.id" class="feature-rule">
        <div class="feature-row"><label><input v-model="rule.enabled" type="checkbox"> 启用</label><input v-model="rule.name" class="control" aria-label="提取规则名称"><button class="button small" :disabled="index === 0" @click="move(index, -1)">上移</button><button class="button small" :disabled="index === config.rules.length - 1" @click="move(index, 1)">下移</button><button class="button danger small" @click="config.rules.splice(index, 1)">删除</button></div>
        <div class="feature-grid">
          <label class="field"><span>适用站点（空格分隔，留空为全部）</span><input class="control" :value="rule.sites.join(' ')" @change="rule.sites = ($event.target as HTMLInputElement).value.split(/[,\s]+/).filter(Boolean)"></label>
          <label class="field"><span>请求 URL 正则</span><input v-model="rule.pattern" class="control" aria-label="提取正则"></label>
          <label class="field"><span>正则标志（i、u）</span><input v-model="rule.flags" class="control"></label>
          <label class="field"><span>输出模板（$0 整体匹配，$1 起为捕获组）</span><input v-model="rule.output" class="control" aria-label="提取输出模板"></label>
          <label class="field"><span>预期媒体类型</span><select v-model="rule.kind" class="control"><option v-for="kind in ['video', 'audio', 'image', 'hls', 'dash', 'segment']" :key="kind">{{ kind }}</option></select></label>
          <label><input v-model="rule.decode" type="checkbox"> 对输出执行一次 URL 解码</label>
        </div>
        <p v-if="disabled[rule.id]" role="alert">{{ disabled[rule.id] }}</p>
      </article>
      <div class="feature-row"><button class="button" :disabled="config.rules.length >= 100" @click="add">新增提取规则</button><button class="button primary" @click="save">保存提取配置</button></div>
      <details open><summary>测试当前草稿（不保存、不收集资源）</summary><label class="field"><span>请求地址</span><input v-model="sample.url" class="control" aria-label="提取测试地址"></label><label class="field"><span>来源页面</span><input v-model="sample.pageUrl" class="control"></label><button class="button" @click="test">测试提取</button>
        <div v-if="result" role="status"><p>{{ result.error || result.url || '没有匹配的提取结果' }}</p><p v-if="result.url">预期类型：{{ result.kind }}。正式收集时还会经过站点限制和识别排除规则。</p><ol><li v-for="step in result.steps" :key="step.ruleId">{{ step.name }}：{{ step.reason }}</li></ol></div>
      </details>
      <details><summary>提取配置导入 / 导出</summary><textarea v-model="transfer" class="control feature-code" aria-label="提取配置 JSON"></textarea><div class="feature-row"><button class="button" @click="transfer = JSON.stringify(config, null, 2)">生成导出内容</button><button class="button" @click="importConfig">载入草稿</button></div></details>
    </fieldset>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>
