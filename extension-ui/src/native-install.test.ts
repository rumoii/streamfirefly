import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import ConnectionBanner from "./components/ConnectionBanner.vue";
import { RUN_DIALOG_LIMIT, detectBrowser, installCommand } from "./native-install";

const id = "abcdefghijklmnopabcdefghijklmnop";

describe("one-click helper install command", () => {
  it("pins the installer to the extension version and passes the browser and ID", () => {
    const command = installCommand("1.0.2", "edge", id);
    expect(command).toContain("https://github.com/rumoii/streamfirefly/releases/download/v1.0.2/StreamFirefly-install.ps1");
    expect(command).toContain(`& $f edge ${id}`);
    expect(command.startsWith("powershell -nop -ep Bypass -c \"")).toBe(true);
    // Invoke-WebRequest uses the Windows system proxy; curl.exe would bypass it.
    expect(command).toContain("iwr 'https://github.com/");
    expect(command).not.toContain("curl");
    expect(installCommand("1.0.2", "firefox", "streamfirefly@example.invalid")).toContain("& $f firefox}");
  });
  it("fits the Win+R dialog even for long versions", () => {
    expect(installCommand("10.10.10", "chrome", id).length).toBeLessThan(RUN_DIALOG_LIMIT);
  });
  it("rejects values that would break the command", () => {
    expect(() => installCommand("1.0.2", "chrome", "abc';calc;'")).toThrow("extension_id_invalid");
    expect(() => installCommand("1.0.2'", "chrome", id)).toThrow("extension_version_invalid");
  });
  it("detects the running browser", () => {
    expect(detectBrowser({ runtime: { getURL: () => "moz-extension://x/" } }, "Firefox/142")).toBe("firefox");
    expect(detectBrowser({ runtime: { getURL: () => "chrome-extension://x/" } }, "Chrome/141 Edg/141")).toBe("edge");
    expect(detectBrowser({ runtime: { getURL: () => "chrome-extension://x/" } }, "Chrome/141")).toBe("chrome");
  });
});

describe("connection banner", () => {
  it("keeps the install guide visible while reconnecting to a missing helper", () => {
    const wrapper = mount(ConnectionBanner, { props: { state: "connecting", error: "native_host_missing" } });
    expect(wrapper.text()).toContain("尚未安装本地助手");
    expect(wrapper.text()).toContain("一键安装本地下载助手");
    expect(wrapper.find("button.button:not(.primary)").exists()).toBe(false);
  });
  it("offers a plain reconnect for an ordinary disconnect", () => {
    const wrapper = mount(ConnectionBanner, { props: { state: "disconnected", error: "native_host_disconnected" } });
    expect(wrapper.text()).toContain("重新连接");
    expect(wrapper.text()).not.toContain("一键安装");
  });
});
