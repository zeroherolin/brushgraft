// The few statistics the paste-back needs, with numpy's conventions.

/** numpy's ``np.percentile`` (linear interpolation) of a sorted array. */
export function percentileSorted(sorted: Float64Array, q: number): number {
  const index = (sorted.length - 1) * (q / 100);
  const lo = Math.floor(index);
  const hi = Math.min(lo + 1, sorted.length - 1);
  const t = index - lo;
  const a = sorted[lo];
  const b = sorted[hi];
  return t >= 0.5 ? b - (b - a) * (1 - t) : a + (b - a) * t;
}

export function percentile(values: Float64Array, q: number): number {
  return percentileSorted(Float64Array.from(values).sort(), q);
}

export function median(values: Float64Array): number {
  return percentile(values, 50);
}

/** Percentiles of 8-bit samples, from their histogram. */
export function percentilesOfBytes(values: Uint8Array, qs: number[]): number[] {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[values[i]]++;
  const at = (k: number) => {
    let seen = 0;
    for (let v = 0; v < 256; v++) {
      seen += hist[v];
      if (k < seen) return v;
    }
    return 255;
  };
  return qs.map((q) => {
    const index = (values.length - 1) * (q / 100);
    const lo = Math.floor(index);
    const a = at(lo);
    const b = at(Math.min(lo + 1, values.length - 1));
    const t = index - lo;
    return t >= 0.5 ? b - (b - a) * (1 - t) : a + (b - a) * t;
  });
}

export function mean(values: Float64Array): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i];
  return s / values.length;
}

/** Python's ``round``: halves go to the even neighbour. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
