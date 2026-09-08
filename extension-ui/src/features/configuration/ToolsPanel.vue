<script setup lang="ts">
import { onMounted, ref, toRaw } from "vue";
import { integrationDefaults, preset, validateIntegrations, type IntegrationConfig, type IntegrationKind, type IntegrationProfile, type DispatchReceipt } from "../../../../shared/integrations";
import { configurationRequest } from "./client";
import { useAdvancedArguments } from "../../../../shared/tool-options";
const config = ref(integrationDefaults());
const receipts = ref<DispatchReceipt[]>([]);
const secrets = ref<Record<string, string>>({});
const message = ref("");
const busy = ref(false);
const selectedKind = ref<IntegrationKind>("aria2");
const transfer = ref("");
async function perform(action: () => Promise<void>) { busy.value = true; message.value = ""; try { await action(); } catch (error) { message.value = error instanceof Error ? error.message : "操作失败"; } finally { busy.value = false; } }
async function refresh() { const response = await configurationRequest<{ config: IntegrationConfig; receipts: DispatchReceipt[]; error: string }>("integration.get"); config.value = response.config; receipts.value = response.receipts; message.value = response.error; }
onMounted(() => perform(refresh));
async function save() { await perform(async () => { await configurationRequest("integration.save", validateIntegrations(toRaw(config.value))); message.value = "工具配置已保存；发送前仍需确认目标与参数。"; }); }
function addTool() { const profile = preset(selectedKind.value); if (profile.kind === "program") { profile.arguments = []; profile.programOptions = { directory: "", fileName: "", autoSelect: true }; } config.value.profiles.push(profile); }
async function test(profile: IntegrationProfile) { await perform(async () => { await configurationRequest("integration.test", { profile: validateIntegrations({ version: 1, profiles: [toRaw(profile)] }).profiles[0], secret: secrets.value[profile.id] || "" }); message.value = "草稿检查通过；未保存配置，未创建下载任务。"; }); }
async function secret(profileId: string) { await perform(async () => { await configurationRequest("integration.secret", { profileId, secret: secrets.value[profileId] || "" }); secrets.value[profileId] = ""; message.value = "凭据已存入本次后台会话内存，后台重启后需重新输入。"; }); }
function importConfig() { try { const parsed = validateIntegrations(JSON.parse(transfer.value)); parsed.profiles.forEach(profile => { profile.enabled = false; profile.autoSites = []; }); config.value = parsed; message.value = "已导入禁用的草稿，请核对地址与参数后启用。"; } catch (error) { message.value = error instanceof Error ? error.message : "导入失败"; } }
function updateHeaders(profile: IntegrationProfile, event: Event) { try { const headers = JSON.parse((event.target as HTMLTextAreaElement).value); if (!headers || Array.isArray(headers) || typeof headers !== "object" || Object.values(headers).some(value => typeof value !== "string")) throw new Error("请求头必须是字符串键值 JSON 对象"); profile.headers = headers; message.value = "请求头草稿已更新，请保存工具配置。"; } catch (error) { message.value = error instanceof Error ? error.message : "请求头无效"; } }
</script>
<template>
  <section class="panel feature-panel">
    <header><h3>外部工具</h3><p>调用结果仅表示服务接收或程序启动，不代表文件下载完成。密钥和令牌不随配置保存。</p></header>
    <div class="feature-row"><select v-model="selectedKind" class="control" aria-label="工具类型"><option value="aria2">Aria2 RPC</option><option value="program">N_m3u8DL-RE / 本地程序</option><option value="protocol">自定义协议</option><option value="http">HTTP 数据发送</option></select><button class="button" :disabled="busy || config.profiles.length >= 30" @click="addTool">添加工具</button></div>
    <article v-for="profile in config.profiles" :key="profile.id" class="feature-rule">
      <div class="feature-row"><label><input v-model="profile.enabled" type="checkbox"> 启用</label><input v-model="profile.name" class="control" aria-label="工具名称"><span>{{ profile.kind }}</span><button class="button danger small" @click="config.profiles = config.profiles.filter(item => item.id !== profile.id)">删除</button></div>
      <label class="field"><span>目标地址 / 可执行文件绝对路径</span><input v-model="profile.endpoint" class="control"></label>
      <label v-if="profile.kind === 'aria2'" class="field"><span>目标服务保存目录（留空使用服务默认）</span><input v-model="profile.directory" class="control"></label>
      <label v-if="profile.kind === 'aria2'" class="field"><span>输出文件名模板（留空由服务决定）</span><input v-model="profile.fileName" class="control" placeholder="${fileName}"></label>
      <template v-if="profile.programOptions">
        <h4>N_m3u8DL-RE 参数</h4>
        <label class="field"><span>保存目录（支持模板，留空使用程序默认）</span><input v-model="profile.programOptions.directory" class="control" aria-label="程序保存目录"></label>
        <label class="field"><span>保存名称模板（留空由程序决定）</span><input v-model="profile.programOptions.fileName" class="control" aria-label="程序名称模板" placeholder="${title}"></label>
        <label><input v-model="profile.programOptions.autoSelect" type="checkbox"> 自动选择轨道</label>
        <p>请求头按下方授权生成；没有值的请求头不会传递。路径有空格也无需加引号。</p>
        <button class="button" :disabled="busy" @click="useAdvancedArguments(profile)">转换为高级参数</button>
      </template>
      <label v-else-if="profile.kind === 'program'" class="field"><span>高级参数（每行一个参数，不额外包引号；exists 条件为空时省略该参数）</span><textarea class="control feature-code" :value="profile.arguments.join('\n')" @change="profile.arguments = ($event.target as HTMLTextAreaElement).value.split('\n')"></textarea></label>
      <template v-if="profile.kind === 'http'"><label class="field"><span>请求方式</span><select v-model="profile.method" class="control"><option>POST</option><option>GET</option></select></label><label class="field"><span>请求头 JSON（值可使用模板）</span><textarea class="control feature-code" :value="JSON.stringify(profile.headers, null, 2)" @change="updateHeaders(profile, $event)"></textarea></label><label class="field"><span>JSON 请求体（字符串值可使用模板）</span><textarea v-model="profile.body" class="control feature-code"></textarea></label></template>
      <fieldset><legend>允许随资源发送的请求信息</legend><label v-for="field in ['referer', 'cookie', 'authorization', 'userAgent', 'origin']" :key="field" class="feature-check"><input v-model="profile.sensitiveFields" type="checkbox" :value="field">{{ field }}</label></fieldset>
      <details v-if="profile.kind === 'aria2' || profile.kind === 'http'"><summary>自动发送（仅对明确授权的站点）</summary><p>保存非空站点即授权将新发现资源自动发送到此目标，不逐项弹窗。不要填写不信任的服务。</p><input class="control" aria-label="自动发送站点" :value="profile.autoSites.join(' ')" @change="profile.autoSites = ($event.target as HTMLInputElement).value.split(/[,\s]+/).filter(Boolean)"></details>
      <div class="feature-row"><input v-model="secrets[profile.id]" class="control" type="password" autocomplete="off" aria-label="本次会话令牌" placeholder="测试使用此输入；实际发送前保存工具并应用令牌"><button class="button" :disabled="busy" @click="secret(profile.id)">应用令牌</button><button v-if="profile.kind === 'aria2' || profile.kind === 'program'" class="button" :disabled="busy" @click="test(profile)">测试草稿</button></div>
    </article>
    <button class="button primary" :disabled="busy" @click="save">保存工具</button>
    <details><summary>导入 / 导出</summary><textarea v-model="transfer" class="control feature-code" aria-label="工具配置 JSON"></textarea><div class="feature-row"><button class="button" @click="transfer = JSON.stringify(config, null, 2)">生成无凭据配置</button><button class="button" @click="importConfig">载入并禁用</button></div></details>
    <details><summary>最近交接记录</summary><p v-for="receipt in [...receipts].reverse()" :key="receipt.requestId">{{ new Date(receipt.createdAt).toLocaleString() }} · {{ receipt.profileId }} · {{ receipt.state }} {{ receipt.error }}</p></details>
    <p v-if="message" role="status">{{ message }}</p>
  </section>
</template>
