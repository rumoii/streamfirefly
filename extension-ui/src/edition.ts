export type Edition = "general" | "chrome-store";

/** Build-time edition injected by tools/edition.mjs. */
export const EDITION: Edition = typeof __STREAMFIREFLY_EDITION__ === "string" && __STREAMFIREFLY_EDITION__ === "chrome-store" ? "chrome-store" : "general";
export const EDITION_LABEL = EDITION === "chrome-store" ? "Chrome 应用商店版" : "通用版";
