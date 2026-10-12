// Blob URLs for images read from IndexedDB. A URL is made once per image and shared by everything
// that shows it; the oldest are released so a long session doesn't hold every image in memory.

export class UrlCache {
  #urls = new Map<string, Promise<string>>();

  constructor(
    private limit: number,
    private release: (url: string) => void = (u) => URL.revokeObjectURL(u),
  ) {}

  get(key: string, make: () => Promise<string>): Promise<string> {
    const hit = this.#urls.get(key);
    if (hit) {
      // most recently used goes last
      this.#urls.delete(key);
      this.#urls.set(key, hit);
      return hit;
    }
    const made = make();
    this.#urls.set(key, made);
    made.catch(() => this.#urls.delete(key));
    while (this.#urls.size > this.limit) {
      const [oldest, url] = this.#urls.entries().next().value!;
      this.#urls.delete(oldest);
      // Released a little later: an <img> or a new tab may still be picking it up
      void url.then((u) => setTimeout(() => this.release(u), 30_000), () => {});
    }
    return made;
  }

  /** forget everything (and release it), e.g. when data is cleared */
  clear(): void {
    for (const url of this.#urls.values()) void url.then((u) => this.release(u), () => {});
    this.#urls.clear();
  }
}
