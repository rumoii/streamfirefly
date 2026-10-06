export type InstallBrowser = "chrome" | "edge" | "firefox";

export const INSTALL_GUIDE_URL = "https://github.com/rumoii/streamfirefly/blob/main/INSTALL.md";
const RELEASE_DOWNLOAD = "https://github.com/rumoii/streamfirefly/releases/download";
/** The Windows Run dialog (Win+R) accepts at most 259 characters. */
export const RUN_DIALOG_LIMIT = 259;

export function detectBrowser(api: any, userAgent: string): InstallBrowser {
  if (String(api?.runtime?.getURL?.("") || "").startsWith("moz-extension:")) return "firefox";
  return /\bEdg\//.test(userAgent) ? "edge" : "chrome";
}

/**
 * Builds the command pasted into Win+R. It downloads the installer published with the same release
 * as this extension and registers the helper for the running browser and extension ID.
 * Invoke-WebRequest follows the Windows system proxy, which curl.exe ignores.
 */
export function installCommand(version: string, browser: InstallBrowser, extensionId: string) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("extension_version_invalid");
  if (browser !== "firefox" && !/^[a-p]{32}$/.test(extensionId)) throw new Error("extension_id_invalid");
  const url = `${RELEASE_DOWNLOAD}/v${version}/StreamFirefly-install.ps1`;
  const target = browser === "firefox" ? "firefox" : `${browser} ${extensionId}`;
  return `powershell -nop -ep Bypass -c "$f=$env:TEMP+'\\sf-install.ps1';iwr '${url}' -useb -outf $f;if($?){& $f ${target}}"`;
}

export function currentInstallCommand(api: any, userAgent = globalThis.navigator?.userAgent || "") {
  const browser = detectBrowser(api, userAgent);
  return installCommand(String(api?.runtime?.getManifest?.().version || ""), browser, String(api?.runtime?.id || ""));
}
