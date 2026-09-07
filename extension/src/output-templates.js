export function createOutputTemplates(api, evaluate) {
  let config = { version: 1, hls: "${url}", dash: "${url}", other: "${url}", filename: "" };
  let error = "";
  function validate(input) {
    if (!input || input.version !== 1 || ["hls", "dash", "other", "filename"].some(key => typeof input[key] !== "string" || input[key].length > 8192 || /\$\{(?:cookie|authorization|token)(?:[|}])/.test(input[key]))) throw new Error("输出模板无效；不允许自动复制敏感凭据");
    return { version: 1, hls: input.hls, dash: input.dash, other: input.other, filename: input.filename };
  }
  const ready = api.storage.local.get(["outputTemplates"]).then(stored => { if (stored.outputTemplates) config = validate(stored.outputTemplates); }).catch(reason => { error = reason.message; });
  async function read() { await ready; if (error) throw new Error(error); return { ...config }; }
  async function save(input) { await ready; if (error) throw new Error(error); const next = validate(input); await api.storage.local.set({ outputTemplates: next }); config = next; return read(); }
  function values(candidate) { return { url: candidate.url || "", title: candidate.pageTitle || candidate.title || "媒体", fileName: candidate.fileName || candidate.title || "媒体", pageUrl: candidate.pageUrl || "", referer: candidate.referer || candidate.pageUrl || "", mime: candidate.mime || "", ext: candidate.extension || "", size: candidate.size == null ? "" : String(candidate.size), now: new Date().toISOString().replace(/[:.]/g, "-") }; }
  async function render(candidate, kind) { const current = await read(); const template = current[kind]; if (!template && kind === "filename") return ""; return evaluate({ kind: kind === "filename" ? "filename" : "template", template, values: values(candidate) }); }
  return { read, save, copy: candidate => render(candidate, ["hls", "dash"].includes(candidate.type) ? candidate.type : "other"), filename: candidate => render(candidate, "filename") };
}
