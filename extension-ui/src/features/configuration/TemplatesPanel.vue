<script setup lang="ts">
import { onMounted, ref } from "vue";
import { configurationRequest } from "./client";
const template = ref('${url} ${referer|exists:\'-H "Referer: *"\'}');
const values = ref('{"url":"https://cdn.example.com/video.mp4","referer":"https://example.com/watch","title":"示例视频"}');
const result = ref("");
const busy = ref(false);
const output = ref({ version: 1, hls: "${url}", dash: "${url}", other: "${url}", filename: "" });
onMounted(async () => { try { output.value = await configurationRequest("templates.get"); } catch (error) { result.value = error instanceof Error ? error.message : "读取失败"; } });
async function save() { try { await configurationRequest("templates.save", output.value); result.value = "复制和文件名模板已保存。"; } catch (error) { result.value = error instanceof Error ? error.message : "保存失败"; } }
async function test() { busy.value = true; try { result.value = await configurationRequest<string>("template.render", { template: template.value, values: JSON.parse(values.value) }); } catch (error) { result.value = error instanceof Error ? error.message : "模板无效"; } finally { busy.value = false; } }
</script>
<template>
  <section class="feature-panel">
    <header class="feature-head"><div><h3>输出模板</h3><p>复制资源地址时按类型套用模板；文件主名称模板用于下载命名。</p></div><div class="feature-head-actions"><button class="button primary" @click="save">保存输出模板</button></div></header>
    <section class="feature-card">
      <h4>复制与命名</h4>
      <div class="feature-grid wide"><label v-for="field in ['hls', 'dash', 'other', 'filename'] as const" :key="field" class="field"><span>{{ field === 'filename' ? '文件主名称（留空使用自动命名，不包含扩展名）' : `${field} 复制模板` }}</span><input v-model="output[field]" class="control"></label></div>
    </section>
    <section class="feature-card">
      <h4>模板试验台</h4>
      <p class="feature-note">工具参数使用相同语法。支持 url、title、fileName、ext、referer、cookie、authorization、now 等变量；支持 exists、replace、slice、urlEncode、urlDecode、base64、unbase64、lower、upper。</p>
      <label class="field"><span>模板</span><textarea v-model="template" class="control feature-code"></textarea></label>
      <label class="field"><span>样例变量 JSON（请勿填写真实凭据）</span><textarea v-model="values" class="control feature-code"></textarea></label>
      <div class="feature-row"><button class="button" :disabled="busy" @click="test">预览结果</button></div>
      <pre class="feature-result" role="status">{{ result || '预览结果会显示在这里。' }}</pre>
    </section>
  </section>
</template>
