(() => {
  const LIMIT = 512 * 1024;
  const join = parts => { const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; };
  function box(bytes) {
    if (bytes.length < 8) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let size = view.getUint32(0), header = 8;
    if (size === 1) { if (bytes.length < 16) return null; const extended = view.getBigUint64(8); if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("invalid"); size = Number(extended); header = 16; }
    if (size < header) throw Error("invalid");
    return { size, header, kind: String.fromCharCode(...bytes.subarray(4, 8)) };
  }
  function children(bytes) {
    let offset = 0; const kinds = [];
    while (offset < bytes.length) { const item = box(bytes.subarray(offset)); if (!item || offset + item.size > bytes.length) throw Error("invalid"); if (["trak", "mdia", "minf", "stbl", "mvex"].includes(item.kind)) children(bytes.subarray(offset + item.header, offset + item.size)); kinds.push(item.kind); offset += item.size; }
    return kinds;
  }
  function vint(bytes, offset, id) {
    const first = bytes[offset]; if (first == null) return null;
    const width = Math.clz32(first) - 24 + 1;
    if (width > (id ? 4 : 8)) throw Error("invalid");
    if (offset + width > bytes.length) return null;
    let value = BigInt(id ? first : first & (255 >> width));
    for (let i = 1; i < width; i++) value = (value << 8n) | BigInt(bytes[offset + i]);
    const unknown = !id && value === (1n << BigInt(width * 7)) - 1n;
    if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) throw Error("invalid");
    return { value: Number(value), width, unknown };
  }
  function element(bytes) {
    const id = vint(bytes, 0, true); if (!id) return null;
    const size = vint(bytes, id.width, false); if (!size) return null;
    return { kind: id.value, header: id.width + size.width, size: size.unknown ? Infinity : id.width + size.width + size.value };
  }
  function ebmlChildren(bytes, required) {
    let offset = 0, found = required == null && bytes.length > 0;
    while (offset < bytes.length) { const item = element(bytes.subarray(offset)); if (!item || !Number.isFinite(item.size) || offset + item.size > bytes.length) throw Error("invalid"); if (item.kind === 0xae) ebmlChildren(bytes.subarray(offset + item.header, offset + item.size)); found ||= item.kind === required; offset += item.size; }
    if (!found) throw Error("invalid");
  }
  function create(mime) {
    let pending = new Uint8Array(), skip = 0, item = null, parts = [], initialization = null, unavailable = "", webm = /webm/.test(mime), stage = 0, fingerprint = "", revision = 0;
    function commit(value) { let hash = 2166136261; for (const byte of value) hash = Math.imul(hash ^ byte, 16777619); const next = `${value.length}:${hash}`; if (fingerprint !== next) { fingerprint = next; revision++; } initialization = value; }
    const retained = () => pending.length + parts.reduce((n, part) => n + part.length, 0) + (initialization?.length || 0);
    function reset(reason = "") { pending = new Uint8Array(); skip = 0; item = null; parts = []; initialization = null; unavailable = reason; stage = 0; }
    function feed(input, available) {
      let offset = 0;
      try {
        while (offset < input.length) {
          if (skip) { const length = Math.min(skip, input.length - offset); offset += length; skip -= length; continue; }
          // A new WebM append may start a new stream after an unknown-sized cluster.
          if (webm && stage === 4) { if (input.length - offset >= 4 && input[offset] === 0x1a && input[offset + 1] === 0x45 && input[offset + 2] === 0xdf && input[offset + 3] === 0xa3) reset(); else break; }
          if (!item) {
            const next = join([pending, input.subarray(offset, offset + 1)]);
            if (next.length > 16) throw Error("invalid");
            pending = next; offset++;
            item = webm ? element(pending) : box(pending);
            if (!item) continue;
            const initial = webm ? [0x1a45dfa3, 0x18538067, 0x1549a966, 0x1654ae6b].includes(item.kind) : ["ftyp", "moov"].includes(item.kind);
            if (!initial) {
              pending = new Uint8Array();
              if (webm && item.kind === 0x1f43b675 && !Number.isFinite(item.size)) stage = 4;
              else skip = item.size - item.header;
              item = null; continue;
            }
            if ((!webm && item.kind === "ftyp") || (webm && item.kind === 0x1a45dfa3)) { initialization = null; parts = []; unavailable = ""; stage = 0; }
            if (webm && item.kind === 0x18538067) {
              if (stage !== 1) throw Error("invalid");
              const header = pending.slice(); header.fill(255, 4); header[4] = 255 >> (header.length - 5);
              parts.push(header); pending = new Uint8Array(); item = null; stage = 2; continue;
            }
            if (!Number.isFinite(item.size) || item.size > LIMIT) throw Error("limit");
          }
          const length = Math.min(item.size - pending.length, input.length - offset);
          if (retained() + length > Math.min(LIMIT, available)) throw Error("limit");
          pending = join([pending, input.subarray(offset, offset + length)]); offset += length;
          if (pending.length !== item.size) break;
          const body = pending.subarray(item.header);
          if (!webm && item.kind === "ftyp") { if (body.length < 8) throw Error("invalid"); parts = [pending]; }
          if (!webm && item.kind === "moov") {
            initialization = null;
            const kinds = children(body);
            if (!parts.length || !kinds.includes("mvhd") || !kinds.includes("trak")) throw Error("invalid");
            commit(join([parts[0], pending])); parts = [];
          }
          if (webm) {
            if (item.kind === 0x1a45dfa3) { ebmlChildren(body); parts = [pending]; stage = 1; }
            if (item.kind === 0x1549a966) { if (stage !== 2) throw Error("invalid"); ebmlChildren(body); parts.push(pending); stage = 3; }
            if (item.kind === 0x1654ae6b) { if (stage !== 3) throw Error("invalid"); ebmlChildren(body, 0xae); commit(join([...parts, pending])); parts = []; }
          }
          pending = new Uint8Array(); item = null;
          if (retained() > Math.min(LIMIT, available)) throw Error("limit");
        }
      } catch (error) { reset(error.message === "limit" ? "capture_initialization_limit" : "capture_initialization_missing"); }
    }
    return { feed, reset, get bytes() { return retained(); }, get data() { return initialization; }, get unavailable() { return unavailable; }, get revision() { return revision; } };
  }
  window.__streamFireflyCaptureInitialization = { create };
})();
