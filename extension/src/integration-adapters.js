import { prepareIntegrationRequest } from "./integration-request.js";
export function createIntegrationAdapters(api, nativeRequest, evaluate) {
  async function request(endpoint, init) {
    const response = await fetch(endpoint, { ...init, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`服务返回 HTTP ${response.status}`);
    return response;
  }
  async function rpc(profile, method, params, requestId, secret) {
    const response = await request(profile.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params: [...(secret ? [`token:${secret}`] : []), ...params] }) });
    const text = await boundedText(response);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("Aria2 响应格式无效"); }
    if (data.id === requestId && data.error) throw Object.assign(new Error("Aria2 拒绝请求"), { definitive: true });
    if (data.id !== requestId || !Object.hasOwn(data, "result")) throw new Error("Aria2 响应无效，结果未知");
    return data.result;
  }
  async function boundedText(response) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("服务未返回响应体");
    let count = 0; const chunks = [];
    try { while (true) { const result = await reader.read(); if (result.done) break; count += result.value.length; if (count > 65536) throw new Error("服务响应过大"); chunks.push(result.value); } }
    finally { await reader.cancel().catch(() => {}); }
    return new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk => [...chunk])));
  }
  const adapters = {
    aria2: async (profile, values, id, secret, test) => {
      if (test) { await rpc(profile, "aria2.getVersion", [], id, secret); return { state: "accepted" }; }
      const prepared = await prepareIntegrationRequest(profile, values, evaluate);
      const gid = await rpc(profile, prepared.body.method, prepared.body.params, id, secret);
      if (typeof gid !== "string" || !/^[0-9a-f]{16}$/i.test(gid)) throw new Error("Aria2 未返回有效 GID");
      return { state: "accepted", gid };
    },
    http: async (profile, values, _id, _secret, test) => {
      if (test) throw new Error("HTTP 测试会发送数据，请使用测试资源并确认发送");
      const prepared = await prepareIntegrationRequest(profile, values, evaluate);
      const response = await request(prepared.endpoint, { method: prepared.method, headers: prepared.headers, body: prepared.body });
      await response.body?.cancel(); return { state: "accepted" };
    },
    program: async (profile, values, id, _secret, test) => {
      const args = (await prepareIntegrationRequest(profile, values, evaluate)).arguments;
      const result = await nativeRequest(test ? "integration.test" : "integration.invoke", { requestId: id, executable: profile.endpoint, arguments: args });
      if (!result.ok) { if (result.error === "native_host_timeout" || result.error === "native_host_disconnected") return { state: "unknown", error: "助手连接中断，执行结果未知，不会自动重试" }; throw Object.assign(new Error("工具未启动"), { definitive: ["executable_not_found", "executable_path_invalid", "script_interpreter_not_allowed", "argument_invalid", "arguments_too_large", "executable_start_failed"].includes(result.error) }); }
      return { state: test ? "accepted" : "started" };
    },
    protocol: async (profile, values, _id, _secret, test, protocolTabId) => {
      if (test) throw new Error("协议注册无法可靠查询，请使用测试资源确认调用");
      const url = (await prepareIntegrationRequest(profile, values, evaluate)).endpoint;
      if (!Number.isInteger(protocolTabId)) throw new Error("请在独立确认页调用外部协议");
      await api.tabs.update(protocolTabId, { url });
      return { state: "requested" };
    }
  };
  return { invoke: (profile, values, id, secret, test = false, protocolTabId) => adapters[profile.kind](profile, { ...values, token: secret || "" }, id, secret, test, protocolTabId) };
}
