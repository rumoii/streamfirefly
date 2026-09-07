export type TemplateValues = Record<string, string>;
const variables = new Set(["url", "referer", "origin", "cookie", "authorization", "token", "userAgent", "title", "fileName", "ext", "now", "pageUrl", "mime", "size"]);

function splitExpression(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let part = "", quote = "", escaped = false;
  for (const char of value) {
    if (escaped) { part += char; escaped = false; continue; }
    if (char === "\\") { part += char; escaped = true; continue; }
    if (quote) { part += char; if (char === quote) quote = ""; continue; }
    if (char === "'" || char === '"') { quote = char; part += char; continue; }
    if (char === delimiter) { parts.push(part.trim()); part = ""; } else part += char;
  }
  if (quote || escaped) throw new Error("模板参数引号或转义未闭合");
  parts.push(part.trim());
  return parts;
}

function parameter(value: string): string {
  if (value.startsWith('"')) { try { return JSON.parse(value); } catch { throw new Error("模板参数无效"); } }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  return value;
}

export function renderTemplate(template: string, values: TemplateValues): string {
  if (typeof template !== "string" || template.length > 8192) throw new Error("模板超出长度限制");
  const rendered = template.replace(/\$\{([^{}]+)\}/g, (_match, expression: string, offset: number) => {
    const [variable, ...functions] = splitExpression(expression, "|");
    if (!variables.has(variable)) throw new Error(`模板第 ${offset + 1} 个字符：未知变量 ${variable}`);
    let value = values[variable] || "";
    for (const operation of functions) {
      const [name, ...rawArgs] = splitExpression(operation, ":");
      const args = rawArgs.flatMap(argument => splitExpression(argument, ",")).map(parameter);
      if (name === "exists" && args.length >= 1 && args.length <= 2) value = (value ? args[0] : args[1] || "").replaceAll("*", value);
      else if (name === "replace" && args.length === 2 && args[0]) value = value.replace(args[0], () => args[1]);
      else if (name === "replaceAll" && args.length === 2 && args[0]) value = value.replaceAll(args[0], () => args[1]);
      else if (name === "prepend" && args.length === 1) value = args[0] + value;
      else if (name === "concat" && args.length === 1) value += args[0];
      else if (name === "regexp" && args.length >= 1 && args.length <= 2 && args[0].length <= 512 && /^(?:i?u?|u?i?)$/.test(args[1] || "")) { const match = value.match(new RegExp(args[0], args[1])); value = match ? match.slice(1).filter(Boolean).map(part => part.trim()).join("") : ""; }
      else if (name === "slice" && args.length >= 1 && args.length <= 2 && args.every(arg => /^-?\d{1,6}$/.test(arg))) value = value.slice(Number(args[0]), args[1] == null ? undefined : Number(args[1]));
      else if (name === "urlEncode" && !args.length) value = encodeURIComponent(value);
      else if (name === "urlDecode" && !args.length) value = decodeURIComponent(value);
      else if (name === "base64" && !args.length) value = btoa(Array.from(new TextEncoder().encode(value), byte => String.fromCharCode(byte)).join(""));
      else if (name === "unbase64" && !args.length) value = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(value), char => char.charCodeAt(0)));
      else if (name === "lower" && !args.length) value = value.toLowerCase();
      else if (name === "upper" && !args.length) value = value.toUpperCase();
      else if (name === "to" && args.length === 1) {
        if (args[0] === "urlEncode") value = encodeURIComponent(value);
        else if (args[0] === "urlDecode") value = decodeURIComponent(value);
        else if (args[0] === "lowerCase") value = value.toLowerCase();
        else if (args[0] === "upperCase") value = value.toUpperCase();
        else if (args[0] === "trim") value = value.trim();
        else if (args[0] === "base64") value = btoa(Array.from(new TextEncoder().encode(value), byte => String.fromCharCode(byte)).join(""));
        else throw new Error(`不支持的转换 ${args[0]}`);
      }
      else throw new Error(`模板第 ${offset + 1} 个字符：函数或参数无效 ${name}`);
      if (value.length > 65536) throw new Error("模板结果超出长度限制");
    }
    return value;
  });
  if (template.replace(/\$\{([^{}]+)\}/g, "").includes("${")) throw new Error("模板变量未闭合");
  if (rendered.length > 65536 || /\0/.test(rendered)) throw new Error("模板结果无效或过长");
  return rendered;
}

export function renderFilename(template: string, values: TemplateValues): string {
  const name = renderTemplate(template, values).trim();
  if (!name || name.length > 180 || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name === "." || name === "..") throw new Error("文件名包含路径或不允许的字符");
  return name;
}
