<script setup lang="ts">
import { reactive, watch } from "vue";

const props = defineProps<{ settings: { saveDir: string; downloadThreads: number; detectImages: boolean; advancedDeepSearch: boolean; candidateSort: string } }>();
const emit = defineEmits<{ save: [settings: typeof props.settings]; reset: [] }>();
const form = reactive({ ...props.settings });
watch(() => props.settings, value => Object.assign(form, value), { deep: true });
</script>

<template>
  <section class="settings-page">
    <div class="settings-intro"><span>⚙</span><div><h2>流萤设置</h2><p>配置新下载任务和网页媒体识别方式，保存后立即生效。</p></div></div>
    <section class="panel settings-card"><div class="settings-section"><div><h3>下载设置</h3><p>决定文件的默认保存位置和普通文件并发下载数。</p></div><div class="settings-fields"><label class="field"><span>默认保存目录</span><input v-model="form.saveDir" class="control" placeholder="例如 D:\Downloads\StreamFirefly"><small>留空时使用系统默认目录；请填写绝对路径。</small></label><label class="field compact"><span>下载并发数</span><input v-model.number="form.downloadThreads" class="control" type="number" min="1" max="16"><small>支持 Range 的普通文件建议使用 4–8 路。</small></label></div></div><div class="settings-divider"></div><div class="settings-section"><div><h3>媒体识别</h3><p>控制是否收集更多网页资源。修改后刷新来源网页生效。</p></div><div class="toggle-list"><label class="toggle-row"><span><strong>识别图片</strong><small>显示 JPG、PNG、GIF 和 WebP 图片资源。</small></span><input v-model="form.detectImages" type="checkbox"><i></i></label><label class="toggle-row"><span><strong>高级深度搜索</strong><small>额外观察页面解码和 Worker；可能影响少数复杂网站。</small></span><input v-model="form.advancedDeepSearch" type="checkbox"><i></i></label></div></div><div class="settings-footer"><button class="button" type="button" @click="$emit('reset')">恢复默认</button><button class="button primary" type="button" @click="$emit('save', { ...form })">验证并保存</button></div></section>
  </section>
</template>
