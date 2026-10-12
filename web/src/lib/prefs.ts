// UI preferences live in this browser only. Reads and writes can fail (private
// browsing and the like); the defaults apply then.

export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`brushgraft.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`brushgraft.${key}`, JSON.stringify(value));
  } catch {
    // ignore
  }
}

export type Theme = "system" | "light" | "dark";

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
}
