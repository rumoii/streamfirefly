import { createHlsMetadataQueue, probeHlsMetadata, type HlsMetadata, type ManifestText } from "./hls-metadata";
import type { MediaCandidate } from "./types";

const master = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\nhigh.m3u8\n";
const vod = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\na.ts\n#EXTINF:5.5,\nb.ts\n#EXT-X-ENDLIST\n";
const live = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\na.ts\n";
const files: Record<string, string> = { "https://v.example/master.m3u8": master, "https://v.example/high.m3u8": vod, "https://v.example/live.m3u8": live };
const load = vi.fn(async (url: string) => { if (!(url in files)) throw new Error("missing"); return { text: files[url], url }; });
const hls = (id: string, url: string, extra: Partial<MediaCandidate> = {}): MediaCandidate => ({ id, url, type: "hls", ...extra });

async function readHlsMetadata(candidate: MediaCandidate, read: (url: string) => Promise<ManifestText>) {
  const patches: HlsMetadata[] = [];
  for await (const metadata of probeHlsMetadata(candidate, read)) patches.push(metadata);
  return patches;
}

describe("HLS metadata probing", () => {
  afterEach(() => load.mockClear());
  it("reads the best variant resolution and the media playlist duration without loading video", async () => {
    expect(await readHlsMetadata(hls("m", "https://v.example/master.m3u8"), load)).toEqual([{ width: 1920, height: 1080, duration: 11.5 }]);
    expect(load.mock.calls.map(([url]) => url)).toEqual(["https://v.example/master.m3u8", "https://v.example/high.m3u8"]);
    expect(await readHlsMetadata(hls("l", "https://v.example/live.m3u8"), load)).toEqual([{ live: true }]);
  });
  it("fills only missing fields, probes each candidate once and drops results from a previous page", async () => {
    const apply = vi.fn(async () => {});
    const queue = createHlsMetadataQueue({ load: (_candidate, url) => load(url), apply, concurrency: 1 });
    const items = [hls("known", "https://v.example/master.m3u8", { width: 1280, height: 720, duration: 3 }), hls("master", "https://v.example/master.m3u8", { duration: 99 }), hls("broken", "https://v.example/none.m3u8"), { id: "mp4", url: "https://v.example/a.mp4", type: "video" } as MediaCandidate];
    queue.schedule("page", items);
    queue.schedule("page", items);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply).toHaveBeenCalledWith(items[1], { width: 1920, height: 1080 });
    load.mockClear(); apply.mockClear();
    let release!: () => void;
    load.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ text: vod, url: "https://v.example/next.m3u8" }); }));
    queue.schedule("page-2", [hls("next", "https://v.example/next.m3u8")]);
    queue.schedule("page-3", []);
    release(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(apply).not.toHaveBeenCalled();
  });
});

it('fills a child resolution from its exact parent variant and preserves it on a child failure', async () => {
 const child=hls('child','https://v.example/high.m3u8',{parents:['https://v.example/master.m3u8']});
 expect(await readHlsMetadata(child,async url=>({text:url.endsWith('master.m3u8')?master:vod,url}))).toEqual([{duration:11.5},{width:1920,height:1080}]);
 expect(await readHlsMetadata(hls('m','https://v.example/master.m3u8'),async url=>{if(url.endsWith('high.m3u8'))throw Error('403');return {text:master,url};})).toEqual([{width:1920,height:1080}]);
});
it('automatically fills supported DASH without downloading segments', async () => {
 const text='<MPD mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4" codecs="avc1.64001f"><SegmentTemplate duration="2" media="$RepresentationID$-$Number$.m4s"/><Representation id="low" bandwidth="100" width="640" height="360"/><Representation id="high" bandwidth="200" width="1920" height="1080"/></AdaptationSet></Period></MPD>';
 const item={id:'dash',url:'https://v.example/main.mpd',type:'dash'};
 const read=vi.fn(async(url:string)=>({text,url}));const apply=vi.fn(async()=>{});
 createHlsMetadataQueue({load:(_item,url)=>read(url),apply}).schedule('page',[item]);
 await vi.waitFor(()=>expect(apply).toHaveBeenCalledWith(item,{width:1920,height:1080,duration:4}));
 expect(read).toHaveBeenCalledTimes(1);
});

it('does not fetch or publish while sniffing is paused',async()=>{
 let complete!:(value:any)=>void;const read=vi.fn(()=>new Promise<ManifestText>(resolve=>{complete=resolve;}));const apply=vi.fn(async()=>{});
 const queue=createHlsMetadataQueue({load:read,apply});const item=hls('paused','https://v.example/live.m3u8');
 queue.schedule('page',[item],false);expect(read).not.toHaveBeenCalled();
 queue.schedule('page',[item],true);expect(read).toHaveBeenCalledTimes(1);
 queue.schedule('page',[item],false);complete({text:vod,url:item.url});await new Promise(resolve=>setTimeout(resolve,0));expect(apply).not.toHaveBeenCalled();
});

it("publishes child duration while the exact parent resolution is still pending", async () => {
  const parent = "https://v.example/master.m3u8";
  const item = hls("child", "https://v.example/high.m3u8", { parents: [parent] });
  let resolveParent!: (value: ManifestText) => void;
  const parentResponse = new Promise<ManifestText>(resolve => { resolveParent = resolve; });
  const read = vi.fn(async (_item: MediaCandidate, url: string) => url === parent ? parentResponse : { text: vod, url });
  const apply = vi.fn(async () => {});
  createHlsMetadataQueue({ load: read, apply }).schedule("page", [item]);

  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith(item, parent));
    expect(apply.mock.calls).toEqual([[item, { duration: 11.5 }]]);
  } finally {
    resolveParent({ text: master, url: parent });
  }
  await vi.waitFor(() => expect(apply).toHaveBeenNthCalledWith(2, item, { width: 1920, height: 1080 }));
});

it("gives DASH and HLS 40 automatic reads each, including after a page change", async () => {
  const dash: MediaCandidate[] = Array.from({ length: 41 }, (_, id) => ({ id: `dash-${id}`, url: `https://v.example/${id}.mpd`, type: "dash" }));
  const playlists = Array.from({ length: 41 }, (_, id) => hls(`hls-${id}`, `https://v.example/${id}.m3u8`));
  const read = vi.fn(async (_item: MediaCandidate, url: string) => ({
    text: url.endsWith(".mpd") ? '<MPD mediaPresentationDuration="PT4S"><Period><AdaptationSet mimeType="video/mp4"><SegmentTemplate duration="2" media="$Number$.m4s"/><Representation id="v" bandwidth="200" width="640" height="360"/></AdaptationSet></Period></MPD>' : vod,
    url
  }));
  const queue = createHlsMetadataQueue({ load: read, apply: async () => {} });
  const idsRead = () => read.mock.calls.map(([item]) => item.id);
  const expected = [...dash.slice(0, 40), ...playlists.slice(0, 40)].map(item => item.id);
  queue.schedule("page", [...dash, ...playlists]);
  await vi.waitFor(() => expect(idsRead()).toEqual(expected));
  queue.schedule("next-page", [...dash, ...playlists]);
  await vi.waitFor(() => expect(idsRead()).toEqual([...expected, ...expected]));
});
