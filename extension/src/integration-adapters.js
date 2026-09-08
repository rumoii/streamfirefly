import { prepareIntegrationRequest } from "./integration-request.js";
export function createIntegrationAdapters(api, nativeRequest, evaluate) {
  async function prepare(profile, values) {
    try { return await prepareIntegrationRequest(profile, values, evaluate); }
    catch { throw Object.assign(new Error("argument_invalid"), { definitive: true }); }
  }
  async function request(endpoint, init) {
    let response;
    try { response = await fetch(endpoint, { ...init, redirect: "error", credentials: "omit", signal: AbortSignal.timeout(10000) }); }
    catch { throw new Error("integration_connection_failed"); }
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error([401, 403].includes(response.status) ? "integration_auth_failed" : "integration_rejected"), { definitive: [400, 401, 403, 404, 405, 422].includes(response.status) }); }
    return response;
  }
  async function rpc(profile, method, params, requestId, secret) {
    const response = await request(profile.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params: [...(secret ? [`token:${secret}`] : []), ...params] }) });
    const text = await boundedText(response);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error("integration_response_invalid"); }
    if (data?.id === requestId && data.error) throw Object.assign(new Error(/unauthorized/i.test(String(data.error.message)) ? "integration_auth_failed" : "integration_rejected"), { definitive: true });
    if (!data || data.id !== requestId || !Object.hasOwn(data, "result")) throw new Error("integration_response_invalid");
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
      const prepared = await prepare(profile, values);
      const gid = await rpc(profile, prepared.body.method, prepared.body.params, id, secret);
      if (typeof gid !== "string" || !/^[0-9a-f]{16}$/i.test(gid)) throw new Error("Aria2 未返回有效 GID");
      return { state: "accepted", gid };
    },
    http: async (profile, values, _id, _secret, test) => {
      if (test) throw new Error("HTTP 测试会发送数据，请使用测试资源并确认发送");
      const prepared = await prepare(profile, values);
      const response = await request(prepared.endpoint, { method: prepared.method, headers: prepared.headers, body: prepared.body });
      await response.body?.cancel(); return { state: "accepted" };
    },
    program: async (profile, values, id, _secret, test) => {
      const args = (await prepare(profile, values)).arguments;
      const result = await nativeRequest(test ? "integration.test" : "integration.invoke", { requestId: id, executable: profile.endpoint, arguments: args });
      if (!result.ok) throw Object.assign(new Error(result.error), { definitive: ["executable_not_found", "executable_path_invalid", "script_interpreter_not_allowed", "argument_invalid", "arguments_too_large", "executable_start_failed"].includes(result.error) });
      return { state: test ? "accepted" : "started" };
    },
    protocol: async (profile, values, _id, _secret, test, protocolTabId) => {
      if (test) throw new Error("协议注册无法可靠查询，请使用测试资源确认调用");
      const url = (await prepare(profile, values)).endpoint;
      if (!Number.isInteger(protocolTabId)) throw new Error("请在独立确认页调用外部协议");
      await api.tabs.update(protocolTabId, { url });
      return { state: "requested" };
    }
  };
  return { invoke: (profile, values, id, secret, test = false, protocolTabId) => adapters[profile.kind](profile, { ...values, token: secret || "" }, id, secret, test, protocolTabId) };
}
