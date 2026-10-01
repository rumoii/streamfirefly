import { clampRect, initialRect, parseLayout } from "./floating-layout";

describe("floating layout boundaries", () => {
  it("keeps the title and controls reachable after moving between screen sizes", () => {
    for (const [width, height] of [[2560, 1440], [1366, 768], [430, 640], [280, 200]]) {
      for (const mode of ["panel", "workspace"] as const) {
        const rect = clampRect({ x: 2400, y: -400, width: 1800, height: 1200 }, mode, width, height);
        expect(rect.x).toBeGreaterThanOrEqual(12);
        expect(rect.y).toBeGreaterThanOrEqual(12);
        expect(rect.x + rect.width).toBeLessThanOrEqual(width - 12);
        expect(rect.y + rect.height).toBeLessThanOrEqual(height - 12);
      }
    }
    expect(initialRect("panel", 1920, 1080).width).toBe(420);
    expect(initialRect("workspace", 1920, 1080).width).toBe(1120);
  });
  it("discards corrupt geometry without losing valid preferences", () => {
    expect(parseLayout({ version: 2, panel: { x: 0, y: 0, width: 400, height: 500 } }).panel).toBeUndefined();
    const parsed = parseLayout({ version: 1, panel: { x: NaN, y: 0, width: 400, height: 500 }, workspace: { x: 12, y: 12, width: 1000, height: 600 }, launcher: { edge: "left", yRatio: 4 } });
    expect(parsed.panel).toBeUndefined();
    expect(parsed.workspace?.width).toBe(1000);
    expect(parsed.launcher).toEqual({ edge: "left", yRatio: 1 });
  });
});
