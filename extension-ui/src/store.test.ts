import { isProxy, reactive } from "vue";
import { DEFAULT_SETTINGS, readSettings } from "./features/settings/state";

describe("settings loading", () => {
  it("reads known keys with a plain array and merges stored values over defaults", async () => {
    const get = vi.fn(async (keys: unknown) => {
      if (!Array.isArray(keys) || isProxy(keys)) throw new TypeError("StorageArea.get rejects Proxy arguments");
      expect(keys).toEqual(Object.keys(DEFAULT_SETTINGS));
      return { downloadThreads: 9, detectImages: true };
    });

    await expect(readSettings({ get } as any)).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      downloadThreads: 9,
      detectImages: true
    });
    expect(get).toHaveBeenCalledOnce();
  });

  it("does not pass Vue reactive defaults to strict Firefox storage", async () => {
    const proxyDefaults = reactive({ ...DEFAULT_SETTINGS });
    const strictStorage = {
      async get(keys: unknown) {
        if (!Array.isArray(keys) || isProxy(keys)) throw new TypeError("Invalid argument for StorageArea.get");
        return {};
      }
    };

    await expect(strictStorage.get(proxyDefaults)).rejects.toThrow("Invalid argument");
    await expect(readSettings(strictStorage as any)).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it("returns a mutable copy of defaults when storage is unavailable", async () => {
    const result = await readSettings(undefined);
    expect(result).toEqual(DEFAULT_SETTINGS);
    expect(result).not.toBe(DEFAULT_SETTINGS);
  });
});
