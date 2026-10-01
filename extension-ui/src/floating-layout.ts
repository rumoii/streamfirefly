export type DisplayMode = "collapsed" | "panel" | "workspace" | "maximized";
export type WindowMode = "panel" | "workspace";
export interface Rect { x: number; y: number; width: number; height: number }
export interface FloatingLayout {
  version: 1;
  panel?: Rect;
  workspace?: Rect;
  launcher: { edge: "left" | "right"; yRatio: number };
}
export const LAYOUT_KEY = "floatingUiLayout";
export const defaultLayout = (): FloatingLayout => ({ version: 1, launcher: { edge: "right", yRatio: .55 } });
export function clampRect(rect: Rect, mode: WindowMode, width: number, height: number): Rect {
  const availableWidth = Math.max(1, width - 24);
  const availableHeight = Math.max(1, height - 24);
  const w = Math.min(availableWidth, Math.max(mode === "panel" ? 360 : 760, rect.width));
  const h = Math.min(availableHeight, Math.max(mode === "panel" ? 300 : 420, rect.height));
  return { x: Math.min(Math.max(12, rect.x), width - w - 12), y: Math.min(Math.max(12, rect.y), height - h - 12), width: w, height: h };
}
export function initialRect(mode: WindowMode, width: number, height: number): Rect {
  const w = mode === "panel" ? 420 : 1120;
  const h = mode === "panel" ? 640 : height * .8;
  return clampRect({ x: mode === "panel" ? width - w - 12 : (width - w) / 2, y: mode === "panel" ? 12 : (height - h) / 2, width: w, height: h }, mode, width, height);
}
export function parseLayout(value: unknown): FloatingLayout {
  const result = defaultLayout();
  if (!value || typeof value !== "object" || (value as any).version !== 1) return result;
  const stored = value as FloatingLayout;
  for (const mode of ["panel", "workspace"] as const) {
    const rect = stored[mode];
    if (rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0) result[mode] = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  if (["left", "right"].includes(stored.launcher?.edge) && Number.isFinite(stored.launcher?.yRatio)) result.launcher = { edge: stored.launcher.edge, yRatio: Math.min(1, Math.max(0, stored.launcher.yRatio)) };
  return result;
}
