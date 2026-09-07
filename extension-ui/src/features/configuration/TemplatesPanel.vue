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
<template><section class="panel feature-panel"><h3>输出模板</h3><label v-for="field in ['hls', 'dash', 'other', 'filename'] as const" :key="field" class="field"><span>{{ field === 'filename' ? '文件主名称（留空使用自动命名，不包含扩展名）' : `${field} 复制模板` }}</span><input v-model="output[field]" class="control"></label><button class="button" @click="save">保存输出模板</button><h3>模板试验台</h3><p>工具参数使用相同语法。支持 url、title、fileName、ext、referer、cookie、authorization、now 等变量；支持 exists、replace、slice、urlEncode、urlDecode、base64、unbase64、lower、upper。</p><label class="field"><span>模板</span><textarea v-model="template" class="control feature-code"></textarea></label><label class="field"><span>样例变量 JSON（请勿填写真实凭据）</span><textarea v-model="values" class="control feature-code"></textarea></label><button class="button primary" :disabled="busy" @click="test">预览结果</button><pre class="feature-result" role="status">{{ result }}</pre></section></template>
