import { createSelectionPreviewSession, decodeManualKey } from "./hls-selection-preview";
import { AttrList } from "hls.js";

const videoText = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/key.bin",IV=0x00112233445566778899aabbccddeeff
#EXTINF:2,
https://media.example/v1.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:2,
https://media.example/v2.ts
#EXT-X-ENDLIST`;

const audioText = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/key.bin"
#EXTINF:2,
https://media.example/a1.aac
#EXT-X-ENDLIST`;

const variant = { bandwidth: 800000, averageBandwidth: null, width: 640, height: 360, codecs: "avc1.64001f,mp4a.40.2", audioGroup: "audio" };

function baseInput(overrides: Partial<Parameters<typeof createSelectionPreviewSession>[0]> = {}) {
  return { sessionId: "s1", video: { text: videoText }, audio: { text: audioText }, variant, keyOverride: null, ...overrides };
}

test("builds a virtual master with one variant and one external audio", () => {
  const session = createSelectionPreviewSession(baseInput());
  expect(session.urls.master).toContain("/session/s1/");
  expect(session.masterText).toContain(`URI="${session.urls.audio}"`);
  expect(session.masterText).toContain(session.urls.video);
  expect(session.masterText.match(/#EXT-X-STREAM-INF/g)).toHaveLength(1);
  expect(session.videoText).toBe(videoText);
  session.dispose();
});

test("keeps the planned external audio track when the variant lacks an AUDIO group (R2-2)", () => {
  const session = createSelectionPreviewSession(baseInput({ variant: { ...variant, audioGroup: null } }));
  expect(session.masterText).toContain("TYPE=AUDIO");
  expect(session.masterText).toContain('GROUP-ID="preview-audio"');
  expect(session.masterText).toContain(`URI="${session.urls.audio}"`);
  expect(session.masterText).toContain('AUDIO="preview-audio"');
  session.dispose();
});

test("serves only whitelisted virtual playlists and never falls through", async () => {
  const session = createSelectionPreviewSession(baseInput());
  const loaders = session.configFor(class { load() {} abort() {} destroy() {} context = null; stats = {} as never });
  const received: string[] = [];
  const loader = new loaders.pLoader!({} as never);
  loader.load({ url: session.urls.video } as never, {} as never, {
    onSuccess: (response: { data?: unknown }) => received.push(String(response.data).startsWith("#EXTM3U") ? "ok:playlist" : "ok:other"),
    onError: (_error: unknown, context: { url: string }) => received.push(`err:${context.url}`),
    onTimeout: () => received.push("timeout")
  } as never);
  await new Promise(resolve => setTimeout(resolve, 0));
  loader.load({ url: "https://streamfirefly-preview.invalid/session/s1/unknown.m3u8" } as never, {} as never, {
    onSuccess: () => received.push("ok:unknown"),
    onError: (_error: unknown, context: { url: string }) => received.push(`err:${context.url}`),
    onTimeout: () => received.push("timeout")
  } as never);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(received[0]).toBe("ok:playlist");
  expect(received[1]).toContain("err:");
  expect(received[1]).toContain("unknown.m3u8");
  session.dispose();
});

test("does not deliver playlist results after abort or dispose", async () => {
  const session = createSelectionPreviewSession(baseInput());
  const loaders = session.configFor(class { load() {} abort() {} destroy() {} context = null; stats = {} as never });
  const received: string[] = [];
  const loader = new loaders.pLoader!({} as never);
  loader.load({ url: session.urls.master } as never, {} as never, { onSuccess: () => received.push("ok"), onError: () => received.push("err"), onTimeout: () => received.push("timeout") } as never);
  loader.abort();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(received).toEqual([]);
  const second = new loaders.pLoader!({} as never);
  second.load({ url: session.urls.master } as never, {} as never, { onSuccess: () => received.push("ok2"), onError: () => received.push("err2"), onTimeout: () => received.push("timeout2") } as never);
  session.dispose();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(received).toEqual([]);
});

test("rewrites manual keys onto session copies only and keeps METHOD=NONE", () => {
  const before = videoText;
  const session = createSelectionPreviewSession(baseInput({ keyOverride: { kind: "hex", value: "00112233445566778899aabbccddeeff", iv: "0xffffffffffffffffffffffffffffffff" } }));
  expect(session.videoText).toContain(`URI="${session.urls.key}"`);
  expect(session.videoText).toContain("IV=0xffffffffffffffffffffffffffffffff");
  expect(session.videoText).toContain("#EXT-X-KEY:METHOD=NONE");
  expect(session.videoText).not.toContain("keys.example");
  expect(session.audioText).toContain(`URI="${session.urls.key}"`);
  expect(videoText).toBe(before);
  session.dispose();
});

test("keeps manifest IV when no manual IV is given", () => {
  const session = createSelectionPreviewSession(baseInput({ keyOverride: { kind: "hex", value: "00112233445566778899aabbccddeeff", iv: null } }));
  expect(session.videoText).toContain("IV=0x00112233445566778899aabbccddeeff");
  expect(session.audioText).not.toContain("IV=");
  session.dispose();
});

test("serves decoded manual keys and validates lengths", async () => {
  expect(decodeManualKey({ kind: "hex", value: "0x00112233445566778899aabbccddeeff" })).toHaveLength(16);
  expect(decodeManualKey({ kind: "base64", value: "MDEyMzQ1Njc4OWFiY2RlZg==" })).toHaveLength(16);
  expect(() => decodeManualKey({ kind: "hex", value: "1234" })).toThrow("32 位");
  expect(() => decodeManualKey({ kind: "base64", value: "AA==" })).toThrow("16 字节");

  class FailingDefaultLoader {
    context = null;
    stats = {} as never;
    load(_context: unknown, _config: unknown, callbacks: { onError: (error: { code: number; text: string }, context: unknown) => void }): void { callbacks.onError({ code: 0, text: "delegate" }, {}); }
    abort(): void {}
    destroy(): void {}
  }
  const session = createSelectionPreviewSession(baseInput({ keyOverride: { kind: "base64", value: "MDEyMzQ1Njc4OWFiY2RlZg==" } }));
  const loaders = session.configFor(FailingDefaultLoader as never);
  const results: string[] = [];
  const loader = new loaders.loader!({} as never);
  loader.load({ url: session.urls.key, responseType: "arraybuffer" } as never, {} as never, {
    onSuccess: (response: { data: ArrayBuffer }) => results.push(`ok:${response.data.byteLength}`),
    onError: (error: { text: string }) => results.push(`err:${error.text}`),
    onTimeout: () => results.push("timeout")
  } as never);
  loader.load({ url: "https://cdn.example/seg.ts" } as never, {} as never, {
    onSuccess: () => results.push("delegate"),
    onError: (error: { text: string }) => results.push(`delegate-err:${error.text}`),
    onTimeout: () => results.push("delegate-timeout")
  } as never);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(results).toContain("ok:16");
  expect(results).toContain("delegate-err:delegate");
  session.dispose();
});

test("fetches URL keys through the controlled loader and rejects wrong sizes", async () => {
  const calls: { url: string; aborted: boolean }[] = [];
  const session = createSelectionPreviewSession(baseInput({
    keyOverride: { kind: "url", value: "https://keys.example/manual.bin", iv: null },
    keyFetch: async (url, signal) => {
      const call = { url, aborted: false };
      calls.push(call);
      signal.addEventListener("abort", () => { call.aborted = true; });
      return new Uint8Array(16).buffer;
    }
  }));
  const loaders = session.configFor(class { load() {} abort() {} destroy() {} context = null; stats = {} as never });
  const results: string[] = [];
  const loader = new loaders.loader!({} as never);
  loader.load({ url: session.urls.key, responseType: "arraybuffer" } as never, {} as never, {
    onSuccess: (response: { data: ArrayBuffer }) => results.push(`ok:${response.data.byteLength}`),
    onError: (error: { text: string }) => results.push(`err:${error.text}`),
    onTimeout: () => results.push("timeout")
  } as never);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(results).toEqual(["ok:16"]);
  expect(calls[0].url).toBe("https://keys.example/manual.bin");

  const wrong = createSelectionPreviewSession(baseInput({
    keyOverride: { kind: "url", value: "https://keys.example/wrong.bin", iv: null },
    keyFetch: async () => new Uint8Array(15).buffer
  }));
  const wrongLoaders = wrong.configFor(class { load() {} abort() {} destroy() {} context = null; stats = {} as never });
  const wrongResults: string[] = [];
  const wrongLoader = new wrongLoaders.loader!({} as never);
  wrongLoader.load({ url: wrong.urls.key, responseType: "arraybuffer" } as never, {} as never, {
    onSuccess: () => wrongResults.push("ok"),
    onError: (error: { text: string }) => wrongResults.push(`err:${error.text}`),
    onTimeout: () => wrongResults.push("timeout")
  } as never);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(wrongResults).toEqual(["err:密钥长度无效"]);
  session.dispose();
  wrong.dispose();
});

test("an accepted prefixless manual IV preserves the 16 byte IV in Hls", () => {
  const iv = "112233445566778899aabbccddeeff00";
  const expected = Array.from(Uint8Array.from(iv.match(/../g)!.map(byte => parseInt(byte, 16))));
  for (const value of [iv, `0x${iv}`, `0X${iv.toUpperCase()}`]) {
    const session = createSelectionPreviewSession(baseInput({
      keyOverride: { kind: "hex", value: "00112233445566778899aabbccddeeff", iv: value }
    }));
    const keyTag = session.videoText.split(/\r?\n/).find(line => line.startsWith("#EXT-X-KEY:"))!;
    const parsed = new AttrList(keyTag.slice("#EXT-X-KEY:".length)).hexadecimalInteger("IV");
    expect(Array.from(parsed!)).toEqual(expected);
    expect(parsed!.byteLength).toBe(16);
    session.dispose();
  }
});

test("aborts pending URL key fetches on dispose", async () => {
  let aborted = false;
  const gate: { release?: () => void } = {};
  const session = createSelectionPreviewSession(baseInput({
    keyOverride: { kind: "url", value: "https://keys.example/manual.bin", iv: null },
    keyFetch: (_url, signal) => new Promise(resolve => {
      signal.addEventListener("abort", () => { aborted = true; gate.release = () => resolve(new ArrayBuffer(0)); });
    })
  }));
  const loaders = session.configFor(class { load() {} abort() {} destroy() {} context = null; stats = {} as never });
  const results: string[] = [];
  const loader = new loaders.loader!({} as never);
  loader.load({ url: session.urls.key, responseType: "arraybuffer" } as never, {} as never, {
    onSuccess: () => results.push("ok"),
    onError: () => results.push("err"),
    onTimeout: () => results.push("timeout"),
    onAbort: () => results.push("aborted")
  } as never);
  session.dispose();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(aborted).toBe(true);
  gate.release?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(results).toEqual([]);
});
