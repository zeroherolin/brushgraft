import { i18n, t } from "./i18n.svelte";

export function elapsed(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? t("time.seconds", { s }) : t("time.minutes", { m: Math.floor(s / 60), s: s % 60 });
}

export function clock(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const time = d.toLocaleTimeString(i18n.locale, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(i18n.locale, { month: "short", day: "numeric" })} ${time}`;
}

/** Model name without the common prefixes, for tight spots. */
export function shortModel(name: string): string {
  return name.replace(/^gpt-image-/, "gpt-").replace(/^gemini-/, "");
}

/** A version number kept short for tight spots: 1.1.1.1.1.1 → …1.1.1.1 (the last levels tell versions apart). */
export function shortVersion(version: string | undefined, keep = 4): string {
  const parts = (version ?? "?").split(".");
  return parts.length > keep ? `…${parts.slice(-keep).join(".")}` : parts.join(".");
}

/** A version number as a figure label, such as "Fig. 1.2". */
export const fig = (version: string | undefined): string => t("common.fig", { v: version ?? "?" });

/** A zoom as Photoshop shows it: 66.7%, 8.3%, 200% */
export function zoomText(scale: number): string {
  const pct = scale * 100;
  return `${pct < 100 && Math.abs(pct - Math.round(pct)) >= 0.05 ? pct.toFixed(1) : Math.round(pct)}%`;
}
