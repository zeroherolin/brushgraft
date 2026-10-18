// UI language: English or Simplified Chinese, remembered in this browser.

import { en } from "./locales/en";
import { zh, zhModelNotes } from "./locales/zh";
import { loadPref, savePref } from "./prefs";

export type Lang = "en" | "zh";
export type Key = keyof typeof en;
type Params = Record<string, string | number>;

const dictionaries: Record<Lang, Record<Key, string | ((p: Params) => string)>> = { en, zh };

function detect(): Lang {
  const saved = loadPref<Lang | null>("lang", null);
  if (saved === "en" || saved === "zh") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

class I18n {
  lang = $state<Lang>(detect());

  constructor() {
    this.#apply();
  }

  setLang(lang: Lang): void {
    this.lang = lang;
    savePref("lang", lang);
    this.#apply();
  }

  /** Translate ``key``, filling {param} placeholders. */
  t(key: Key, params: Params = {}): string {
    const entry = dictionaries[this.lang][key] ?? en[key];
    if (typeof entry === "function") return entry(params);
    return entry.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
  }

  /** Whether ``key`` exists, for codes that come from the server. */
  has(key: string): key is Key {
    return key in en;
  }

  /** The note of a measured model, in the UI language. */
  modelNote(name: string, english: string): string {
    return this.lang === "zh" ? (zhModelNotes[name] ?? english) : english;
  }

  /** A model's measured time, "25–45s", in the UI language ("25–45 秒"). */
  modelSeconds(english: string): string {
    return this.lang === "zh" ? english.replace(/s$/, " 秒") : english;
  }

  get locale(): string {
    return this.lang === "zh" ? "zh-CN" : "en";
  }

  #apply(): void {
    document.documentElement.lang = this.lang === "zh" ? "zh-CN" : "en";
  }
}

export const i18n = new I18n();
export const t = (key: Key, params?: Params): string => i18n.t(key, params);
