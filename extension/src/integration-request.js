import { programTemplates, headerNames } from "../../shared/tool-options.ts";
export async function prepareIntegrationRequest(profile, values, evaluate) {
  const render = template => evaluate({ kind: "template", template, values });
  const request = { endpoint: profile.endpoint, method: profile.method, arguments: [], headers: {}, body: undefined };
  if (profile.kind === "program") {
    request.arguments = [];
    for (const template of programTemplates(profile)) {
      const value = await render(template);
      if (!value && template.includes("|exists:")) continue;
      if (/[\r\n\0]/.test(value)) throw new Error("程序参数包含非法字符");
      request.arguments.push(value);
    }
    if (request.arguments.length > 64 || request.arguments.join("").length > 16384) throw new Error("程序参数超过限制");
  }
  if (profile.kind === "protocol") {
    request.endpoint = await render(profile.endpoint);
    if (request.endpoint.length > 8192 || /[\r\n\0]/.test(request.endpoint)) throw new Error("调用协议过长或包含非法字符");
  }
  if (profile.kind === "aria2") {
    const header = profile.sensitiveFields.filter(field => values[field]).map(field => `${headerNames[field]}: ${values[field]}`);
    const out = profile.fileName ? await evaluate({ kind: "filename", template: profile.fileName, values }) : "";
    request.body = { method: "aria2.addUri", params: [[values.url], { header, ...(profile.directory ? { dir: profile.directory } : {}), ...(out ? { out } : {}) }] };
  }
  if (profile.kind === "http") {
    for (const [name, template] of Object.entries(profile.headers)) {
      const value = await render(template);
      if (/[\r\n]/.test(value)) throw new Error("请求头模板含换行");
      request.headers[name] = value;
    }
    if (profile.method === "POST") {
      async function expand(value, depth = 0) {
        if (depth > 12) throw new Error("请求模板嵌套过深");
        if (typeof value === "string") return render(value);
        if (Array.isArray(value)) return Promise.all(value.map(item => expand(item, depth + 1)));
        if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await expand(item, depth + 1)])));
        return value;
      }
      request.body = JSON.stringify(await expand(JSON.parse(profile.body)));
      request.headers["content-type"] ||= "application/json";
    }
  }
  return request;
}
