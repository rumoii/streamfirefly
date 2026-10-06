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
const PANEL_WIDTH = 480;
// Panels saved at the former default width were never resized by the user, so they follow the new default.
const FORMER_PANEL_WIDTH = 420;
export const defaultLayout = (): FloatingLayout => ({ version: 1, launcher: { edge: "right", yRatio: .55 } });
export function clampRect(rect: Rect, mode: WindowMode, width: number, height: number): Rect {
  const availableWidth = Math.max(1, width - 24);
  const availableHeight = Math.max(1, height - 24);
  const w = Math.min(availableWidth, Math.max(mode === "panel" ? 360 : 760, rect.width));
  const h = Math.min(availableHeight, Math.max(mode === "panel" ? 300 : 420, rect.height));
  return { x: Math.min(Math.max(12, rect.x), width - w - 12), y: Math.min(Math.max(12, rect.y), height - h - 12), width: w, height: h };
}
export function initialRect(mode: WindowMode, width: number, height: number): Rect {
  const w = mode === "panel" ? PANEL_WIDTH : 1120;
  const h = mode === "panel" ? 640 : height * .8;
  return clampRect({ x: mode === "panel" ? width - w - 12 : (width - w) / 2, y: mode === "panel" ? 12 : (height - h) / 2, width: w, height: h }, mode, width, height);
}
export function parseLayout(value: unknown): FloatingLayout {
  const result = defaultLayout();
  if (!value || typeof value !== "object" || (value as any).version !== 1) return result;
  const stored = value as FloatingLayout;
  for (const mode of ["panel", "workspace"] as const) {
    const rect = stored[mode];
    if (rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0) result[mode] = { x: mode === "panel" && rect.width === FORMER_PANEL_WIDTH ? rect.x - (PANEL_WIDTH - FORMER_PANEL_WIDTH) : rect.x, y: rect.y, width: mode === "panel" && rect.width === FORMER_PANEL_WIDTH ? PANEL_WIDTH : rect.width, height: rect.height };
  }
  if (["left", "right"].includes(stored.launcher?.edge) && Number.isFinite(stored.launcher?.yRatio)) result.launcher = { edge: stored.launcher.edge, yRatio: Math.min(1, Math.max(0, stored.launcher.yRatio)) };
  return result;
}
