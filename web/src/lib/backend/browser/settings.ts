// The visitor's API key and address, kept in this browser only. They are sent to the image
// service they point at and nowhere else; brushgraft's own site never sees them.
//
// "Remember on this device" keeps the key in localStorage; without it the key lives in
// sessionStorage and goes when the tab closes. Storage can be blocked (private windows), so
// everything falls back to memory.

import { spec } from "../spec";
import { userError } from "../errors";

const KEY = "brushgraft.apiKey";
const URL_KEY = "brushgraft.baseUrl";

interface Area {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

const memory = (): Area => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};

function area(name: "localStorage" | "sessionStorage"): Area {
  try {
    const a = window[name];
    a.getItem(KEY); // can throw when storage is blocked
    return a;
  } catch {
    return memory();
  }
}

export class BrowserSettings {
  #local: Area;
  #session: Area;

  constructor(local: Area = area("localStorage"), session: Area = area("sessionStorage")) {
    this.#local = local;
    this.#session = session;
  }

  get apiKey(): string {
    return (this.#session.getItem(KEY) ?? this.#local.getItem(KEY) ?? "").trim();
  }

  get baseUrl(): string {
    return (this.#local.getItem(URL_KEY) ?? "").trim() || spec.default_base_url;
  }

  /** the key is on this device, not only for this tab */
  get remember(): boolean {
    return this.#local.getItem(KEY) !== null || this.#session.getItem(KEY) === null;
  }

  /** ``remember`` moves the key between the two places; an empty key removes it. */
  save(p: { apiKey?: string; baseUrl?: string; remember?: boolean }): void {
    if (p.baseUrl !== undefined) {
      const url = p.baseUrl.trim();
      if (url && !/^https?:\/\/\S+$/.test(url)) {
        throw userError("invalid_base_url", "The base URL must start with http:// or https://");
      }
      if (url) this.#local.setItem(URL_KEY, url);
      else this.#local.removeItem(URL_KEY);
    }
    const key = p.apiKey !== undefined ? p.apiKey.trim() : this.apiKey;
    if (p.apiKey !== undefined || p.remember !== undefined) {
      const remember = p.remember ?? this.remember;
      this.#local.removeItem(KEY);
      this.#session.removeItem(KEY);
      if (key) (remember ? this.#local : this.#session).setItem(KEY, key);
    }
  }

  /** forget the key (keeps the address) */
  clearKey(): void {
    this.#local.removeItem(KEY);
    this.#session.removeItem(KEY);
  }
}
