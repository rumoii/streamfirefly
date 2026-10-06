# Blob 捕捉与资源预览验收

这些步骤需要操作者在真实 X 和 B 站执行。本地合成夹具通过不能替代站点结果，也不能保证缺少初始化段的文件可播放。

## 准备

### 初始化段与重新捕捉验收

本轮在 X、B 站、小红书分别执行普通晚开始和“重新捕捉（刷新来源页）”。普通捕捉有新追加时必须生成可播放文件；已全缓冲时应提示“开始后播放器没有追加新数据，请使用重新捕捉”。三站重新捕捉均须产出文件，由 ffprobe 确认音视频流、分辨率和有效时长。记录新文档身份、会话、队列排空、Native 落盘与整理日志；不得把来源结束追加说成完整视频保存。

本轮测试结果尚未填写。任一步尝试一次失败即保留证据并停下询问；通过后交付证据，保持版本号、不提交。下方原有 A/B 注入时机对照步骤保留作历史诊断，不代替本轮两种捕捉方式验收。

使用默认“打开时嗅探”，记录浏览器版本、使用的扩展目录或包、测试时间和站点。版本号保持开发中的版本，不能仅凭版本号区分原版与本次修改后的本地包。更新或重新加载扩展后，必须刷新来源页面，旧页面不会自动获得新的 document_start 登记。

- B 站：`https://www.bilibili.com/video/BV1bX4y1e7U6/`
- X：`https://x.com/NFL/status/2106952872399409458`

在原版上做对照能检验注入晚的假设；在本次本地包上重复相同步骤用于验收修复。若原版 A 失败、B 成功，并且页面侧 A 没有登记而 B 有登记，支持注入时机导致候选为空；两组都失败时不要据此定论。

## A：先播放，再打开面板

1. 关闭该页流萤界面，新开站点标签页，开始播放视频。
2. 打开页面开发者工具 Console，选择视频所在框架的页面执行上下文，执行下方“页面脚本”，保存输出。
3. 打开流萤面板，在 Blob 资源上点“缓存捕捉”，记录下拉框、提示和框架状态。
4. 再执行一次页面脚本。在捕捉控制页打开开发者工具 Console，执行“扩展脚本”，保存输出。

## B：先打开面板，刷新后播放

1. 另开站点标签页，先打开流萤面板，再刷新来源页面；等待刷新完成后重新打开面板并播放视频。
2. 在来源页执行页面脚本，再从 Blob 条目打开捕捉控制页并执行扩展脚本。
3. 对比 A、B 的 `installed`、`sources`、当前 video 地址与精确匹配数量。`about:blank` 框架 unsupported 单独记录，同时检查主框架是否有来源。

### 页面脚本

只读检查；不创建媒体源、不安装探针、不启动捕捉。

```js
(() => {
  const probe = window.__streamFireflyCaptureProbe;
  return {
    installed: Boolean(probe?.installed),
    unavailable: Boolean(probe?.unavailable),
    videos: [...document.querySelectorAll('video')].map(video => ({
      currentSrc: video.currentSrc, src: video.src,
      paused: video.paused, readyState: video.readyState,
      width: video.videoWidth, height: video.videoHeight,
      currentTime: video.currentTime, duration: video.duration
    })),
    sources: probe?.sources?.() || []
  };
})()
```

### 扩展脚本

必须在 `app.html?surface=options&captureTab=…&captureBlob=…` 的 Console 执行，而非网站 Console。仅请求扫描，不开始捕捉。

```js
(async () => {
  const params = new URLSearchParams(location.search);
  const tabId = Number(params.get('captureTab'));
  const objectUrl = params.get('captureBlob') || '';
  if (!params.has('captureTab') || !Number.isInteger(tabId)) throw new Error('请在捕捉控制页执行');
  const api = globalThis.browser ?? globalThis.chrome;
  const result = await api.runtime.sendMessage({ type: 'capture.sources', payload: { tabId } });
  return {
    tabId, objectUrl, ok: result?.ok, error: result?.error,
    exactMatches: result?.value?.sources?.filter(source => source.objectUrls.includes(objectUrl)) || [],
    catalog: result?.value
  };
})()
```

## 修复验收

- 两组在播放器创建前均应已安装探针；有可捕捉 MSE 的情况下应能发现来源。普通 Blob、Worker 中创建的 MediaSource 或非 HTTP(S) 框架不因此获得支持。
- Blob 唯一匹配时选中对应来源；零匹配但有候选时必须手动选择，界面持续显示“未确认对应此 Blob”；多匹配必须手动选择。选择变化或重扫后重新确认授权。
- 刷新来源页后点击“刷新来源页面状态”，检查候选和文档身份更新，不使用旧源启动捕捉。无候选时保存两段输出后停止，不反复刷新尝试。
- 捕捉文件另行验收：确认有权保存该视频后开始捕捉，返回来源继续播放、停止并等待保存。记录是否得到可播放文件或初始化段缺失的部分结果。已登记来源不代表能补回开始前的媒体数据。
- 在 X 的 HLS 条目展开详情，观察至少 10 秒，预览就绪后不应随列表刷新重新出现准备提示；播放、收起和关闭仍正常。三个排序模式分别检查可下载条目在 Blob 之前，同类条目保留原有排序。

回传每站 A、B 两组脚本输出、控制页提示和文件结果即可；不要回传请求头、Cookie、授权凭据或完整浏览器 profile。
