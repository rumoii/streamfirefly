import type { IntegrationProfile } from "./integrations";

export const headerNames: Record<string, string> = { referer: "Referer", cookie: "Cookie", authorization: "Authorization", userAgent: "User-Agent", origin: "Origin" };

export function programTemplates(profile: IntegrationProfile): string[] {
  const options = profile.programOptions;
  if (!options) return [...profile.arguments];
  return ["${url}", ...(options.directory ? ["--save-dir", options.directory] : []), ...(options.fileName ? ["--save-name", options.fileName] : []), ...(options.autoSelect ? ["--auto-select"] : []), ...profile.sensitiveFields.flatMap(field => ["${" + field + "|exists:'-H'}", "${" + field + "|exists:'" + headerNames[field] + ": *'}"])];
}

export function useAdvancedArguments(profile: IntegrationProfile): void {
  profile.arguments = programTemplates(profile);
  delete profile.programOptions;
}

export function toolError(code: string): string {
  const messages: Record<string, string> = {
    executable_not_found: "程序不存在，请检查 EXE 绝对路径。",
    executable_path_invalid: "程序路径无效，请选择 EXE 绝对路径。",
    script_interpreter_not_allowed: "不允许通过脚本解释器启动工具，请直接选择下载程序。",
    argument_invalid: "参数包含非法字符或超过长度限制，请检查参数模板。",
    arguments_too_large: "参数超过数量或长度限制，请减少参数。",
    executable_start_failed: "程序未能启动，请检查路径、权限及程序依赖。",
    native_host_disconnected: "本地助手未连接，请检查安装与连接。",
    native_host_timeout: "本地助手响应超时；实际调用结果可能未知，请勿重复发送。",
    integration_auth_failed: "服务拒绝认证，请检查本次会话令牌。",
    integration_rejected: "服务明确拒绝请求，请检查目标和参数。",
    integration_response_invalid: "服务响应无效，无法确认是否接收，请到目标工具查看。",
    integration_connection_failed: "无法连接目标服务或请求超时，请检查服务地址和运行状态。"
  };
  return messages[code] || "外部工具操作失败，请检查目标配置和运行状态。";
}
