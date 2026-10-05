/*
 * A gust of wind for the mark's spin, made in the browser rather than loaded:
 * a burst of noise through a band-pass filter that sweeps down as it fades,
 * shaped to the 1.4s spin, so the sound rises with the whirl and dies as the
 * mark settles. Quiet on purpose.
 *
 * Browsers only start audio after the visitor has clicked or pressed a key
 * on the page, and hovering is neither. Until then the context stays
 * suspended and the spin is silent; the first click or key press anywhere
 * unlocks it for the rest of the visit.
 */
let ctx: AudioContext | null = null;
let noise: AudioBuffer | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC() as AudioContext;
  const unlock = () => { void ctx?.resume(); };
  window.addEventListener("pointerdown", unlock, { once: true, capture: true });
  window.addEventListener("keydown", unlock, { once: true, capture: true });
  return ctx;
}

// Called once at load so the unlock listeners are in place before any hover.
export function primeWind() {
  if (typeof window !== "undefined") context();
}

export function playWind(duration = 1.4) {
  const c = context();
  if (!c || c.state !== "running") return;
  if (!noise) {
    noise = c.createBuffer(1, Math.floor(c.sampleRate * 2), c.sampleRate);
    const d = noise.getChannelData(0);
    // Brown-ish noise: softer than white, closer to moving air.
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.5;
    }
  }
  const t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noise;

  const band = c.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 0.9;
  band.frequency.setValueAtTime(1400, t);
  band.frequency.exponentialRampToValueAtTime(320, t + duration);

  const gain = c.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.22, t + 0.12);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

  src.connect(band).connect(gain).connect(c.destination);
  src.start(t);
  src.stop(t + duration + 0.05);
}
