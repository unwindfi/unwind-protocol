/// A small seeded generator (mulberry32), so a persona's choices can be
/// replayed from its seed and a session number.
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /// An integer in [lo, hi].
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
    /// A pick weighted by the second element of each pair.
    weighted: <T>(xs: readonly (readonly [T, number])[]): T => {
      const total = xs.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [x, w] of xs) { r -= w; if (r <= 0) return x; }
      return xs[xs.length - 1][0];
    },
    shuffle: <T>(xs: readonly T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}
export type Rng = ReturnType<typeof rng>;

/// A string to a 32-bit seed (FNV-1a).
export function hash32(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
