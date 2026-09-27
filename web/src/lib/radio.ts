/*
 * The radio, and the only honest way to make the mark move with it.
 *
 * Two sources, tried in order.
 *
 * A file this site serves can be routed through Web Audio, and an analyser
 * on that graph gives real frequency data, so the mark can be driven by what
 * is actually playing. That needs a recording we are licensed to host.
 *
 * Failing that, YouTube's iframe. It is the licensed way to play somebody
 * else's recording on a page, but it is cross-origin: the player reports its
 * state and its position and never its samples. Nothing can read its
 * spectrum, so on that path the mark keeps its own time instead.
 *
 * Band energy is published as CSS custom properties on the document rather
 * than through React state. Sixty state updates a second would re-render the
 * page sixty times a second to set three numbers; a stylesheet can read them
 * straight off the root.
 */
const CANDIDATES = ["/audio/radio.mp3", "/audio/radio.wav"];
const TRACK = "fxdJInWWGtU";
const NODE = "wl-radio";

type Player = { mute(): void; unMute(): void; playVideo(): void; setVolume(v: number): void };
type YT = { Player: new (el: string, opts: unknown) => Player };
const yt = () => (window as unknown as { YT?: YT }).YT;

function loadYouTube() {
  return new Promise<YT>((done, fail) => {
    const have = yt();
    if (have?.Player) return done(have);
    const w = window as unknown as { onYouTubeIframeAPIReady?: () => void };
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      const api = yt();
      if (api) done(api);
      else fail(new Error("no YT"));
    };
    if (!document.getElementById("yt-api")) {
      const tag = document.createElement("script");
      tag.id = "yt-api";
      tag.src = "https://www.youtube.com/iframe_api";
      tag.onerror = () => fail(new Error("blocked"));
      document.head.appendChild(tag);
    }
  });
}

/*
 * The first candidate this deployment actually serves, if any.
 *
 * The content type is the test, not the status. A missing path under
 * /audio/ does not 404: the dev server and the production rewrite both
 * fall through to the SPA, which answers 200 with index.html. Trusting
 * `ok` here hands an HTML page to an audio element, which fails to decode
 * somewhere far away from the cause.
 */
async function findLocal() {
  for (const url of CANDIDATES) {
    try {
      const r = await fetch(url, { method: "HEAD" });
      if (r.ok && (r.headers.get("content-type") ?? "").startsWith("audio/")) return url;
    } catch { /* absent, or offline; fall through to the next */ }
  }
  return null;
}

/*
 * Seven bands, one per blade, log-spaced across the range music occupies.
 *
 * These are bins at an fftSize of 1024, so each is about 47Hz. The earlier
 * 256 was the mistake that made the mark look dead: a bin was 187Hz wide and
 * the first band began at bin 1, which put everything under 187Hz -- the
 * kick, the bass, the whole bottom a listener actually moves to -- outside
 * every band. The blades were being driven by the part of the mix that
 * carries the least energy.
 *
 * Spacing is geometric because pitch is. Even spacing would hand six blades
 * the treble and one the entire bottom end.
 */
const BANDS: Record<string, [number, number]> = {
  b0: [1, 2], b1: [2, 4], b2: [4, 8], b3: [8, 15],
  b4: [15, 29], b5: [29, 56], b6: [56, 110],
};

/*
 * A floor under the running average, so silence does not divide a band's
 * level by something near zero and pin it to full on the first sound.
 */
const FLOOR = 0.04;

/*
 * How fast the running average forgets. This is the other half of why the
 * mark sat still: at 0.02 a frame the average settled in under a second, so
 * it tracked the music nearly as fast as the music moved, every band read as
 * average, and the ratio below collapsed to one. At 0.0025 it takes about
 * eight seconds, which is long enough to measure the track rather than the
 * bar, and still short enough to absorb a change of section.
 */
const AVERAGE = 0.0025;

/*
 * A band's brightness is its own energy, and a hit on top of that.
 *
 * Excess alone was wrong. It is the right way to find a transient and the
 * wrong way to light a shape: between hits every band reads zero, so the
 * mark spent most of each bar dark and flicked. Carrying the absolute level
 * as well gives each blade a body that holds while its part of the mix is
 * sounding, and the excess then punches it above that.
 */
const BODY = 0.70;
const PUNCH = 0.45;

/*
 * Recorded music is far louder at the bottom than the top, so an untilted
 * absolute reading leaves the outer blades permanently dim. These lift each
 * band into the same working range.
 *
 * They are measured, not guessed: each is roughly the gain that puts that
 * band's ninetieth percentile near the top of its travel. The two quietest
 * bands are capped well under what that fit asks for, because a band with
 * very little in it wants a gain that would amplify the noise floor and
 * strobe. A different master will sit differently, but the running average
 * below absorbs most of that.
 */
const TILT: Record<string, number> = {
  b0: 3.6, b1: 3.3, b2: 4.8, b3: 12.0, b4: 4.3, b5: 11.3, b6: 18.0,
};

/*
 * How hard each band's excess is driven. Per band, because they do not
 * behave alike: a kick swings far above its own average, while the top end
 * of a dense mix stays close to its, so a single gain leaves the rim nearly
 * still while the core is already clipping.
 */
const EXCESS: Record<string, number> = {
  b0: 1.5, b1: 1.7, b2: 2.0, b3: 2.3, b4: 2.7, b5: 3.2, b6: 3.8,
};

/*
 * An envelope follower over the top. The analyser's own smoothing rounds a
 * transient off in both directions, so a hit arrives late and leaves late.
 * Taking the maximum of the new value and a decaying previous one gives the
 * usual shape instead: instant attack, controlled release.
 */
const RELEASE = 0.90;

/*
 * How fast the wheel turns, in degrees a second: a floor it never drops
 * below, and what the bottom of the spectrum adds on top.
 *
 * Turning is the thing a pinwheel already wants to do, which is why the
 * music drives it here rather than driving brightness. Seven blades
 * flickering independently inside one bloom reads as twinkle, however
 * honest the numbers behind it are; the same seven turning together reads
 * as a wheel being pushed.
 *
 * The floor matters as much as the surge. A wheel that stops between kicks
 * looks broken rather than calm, so the beat modulates a turn that is
 * always happening instead of starting one.
 */
// The resting rate matches the 150s revolution the beams already had, so
// silence looks exactly as it always did and the music only leans on it.
const SPIN_BASE = 2.4;
const SPIN_SURGE = 7;

export class Radio {
  /// True once the graph is ours and the mark can follow the actual audio.
  analysed = false;
  private el?: HTMLAudioElement;
  private analyser?: AnalyserNode;
  private bins?: Uint8Array;
  private frame = 0;
  private player?: Player;
  private ctx?: AudioContext;

  private avg: Record<string, number> = Object.fromEntries(
    Object.keys(BANDS).map((k) => [k, FLOOR]));
  private env: Record<string, number> = Object.fromEntries(
    Object.keys(BANDS).map((k) => [k, 0]));
  private angle = 0;
  private last = 0;
  /// Whether the running averages hold a measurement yet, as opposed to the
  /// floor they are seeded with.
  private primed = false;

  private publish = () => {
    const { analyser, bins } = this;
    if (!analyser || !bins) return;
    analyser.getByteFrequencyData(bins as Uint8Array<ArrayBuffer>);
    const root = document.documentElement.style;
    for (const [name, [from, to]] of Object.entries(BANDS)) {
      let sum = 0;
      for (let i = from; i < to; i++) sum += bins[i];
      const mean = sum / (to - from) / 255;
      /*
       * The first frame sets the average outright instead of easing towards
       * it. Seeded at the floor, the average needs about eight seconds to
       * reach a real track's level, and until it arrives every band divides
       * by something far too small and pins at full -- so the mark opened
       * blown out for the first seconds of every play, which is exactly
       * when somebody is looking at it.
       */
      const avg = this.primed
        ? Math.max(this.avg[name] * (1 - AVERAGE) + mean * AVERAGE, FLOOR)
        : Math.max(mean, FLOOR);
      this.avg[name] = avg;
      // Body is what the band is carrying; punch is how far above its own
      // recent average it has jumped, and nothing for being below it.
      const body = Math.min(1, mean * TILT[name]);
      const punch = Math.max(0, mean / avg - 1) * EXCESS[name];
      const level = Math.min(1, body * BODY + punch * PUNCH);
      this.env[name] = Math.max(level, this.env[name] * RELEASE);
      root.setProperty(`--${name}`, this.env[name].toFixed(3));
    }
    // The light behind the blades follows the bottom of the spectrum, which
    // is where a listener feels the beat rather than hears the detail.
    /*
     * Three figures out of the seven, because the mark has three things
     * that move: the bloom behind it, the crisp core, and the rim. Bands
     * exist at this resolution so each of those can be given the part of
     * the spectrum a listener would expect it to answer to, not so the
     * logo can be turned into a bar chart.
     */
    this.primed = true;

    const lo = Math.max(this.env.b0, this.env.b1);
    const mid = Math.max(this.env.b2, this.env.b3);
    const hi = Math.max(this.env.b4, this.env.b5, this.env.b6);
    root.setProperty("--lo", lo.toFixed(3));
    root.setProperty("--mid", mid.toFixed(3));
    root.setProperty("--hi", hi.toFixed(3));

    /*
     * Integrated rather than set, so the beat changes how fast the mark is
     * turning and never where it is pointing. Driving the angle itself from
     * the level would snap it back down on every decay, which is a twitch,
     * not a spin.
     *
     * The step is clamped because a backgrounded tab stops painting: coming
     * back to a two-second gap would otherwise apply two seconds of rotation
     * in one frame and the mark would jump.
     */
    const now = performance.now();
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0;
    this.last = now;
    this.angle = (this.angle + (SPIN_BASE + lo * SPIN_SURGE) * dt) % 360;
    root.setProperty("--spin", `${this.angle.toFixed(2)}deg`);
    this.frame = requestAnimationFrame(this.publish);
  };

  private clear() {
    cancelAnimationFrame(this.frame);
    // The angle stays where it stopped -- resetting it would spin the mark
    // back to twelve o'clock on a mute -- but the clock does not, or the
    // first frame after a resume would count the whole pause as elapsed.
    this.last = 0;
    this.primed = false;
    const root = document.documentElement.style;
    for (const name of Object.keys(BANDS)) root.setProperty(`--${name}`, "0");
    for (const name of ["--lo", "--mid", "--hi"]) root.setProperty(name, "0");
  }

  /// Starts on the first call and mutes or resumes on the rest. Returns
  /// whether anything is playing afterwards.
  async toggle(playing: boolean): Promise<boolean> {
    if (this.el) {
      if (playing) {
        this.el.pause();
        this.clear();
      } else {
        await this.ctx?.resume();
        await this.el.play();
        this.frame = requestAnimationFrame(this.publish);
      }
      return !playing;
    }
    if (this.player) {
      if (playing) this.player.mute();
      else {
        this.player.unMute();
        this.player.playVideo();
      }
      return !playing;
    }

    const local = await findLocal();
    if (local) {
      const el = new Audio(local);
      el.loop = true;
      /*
       * This context is built after an await, so the click that opened the
       * radio is no longer the current user activation and it starts
       * suspended. A suspended context runs no graph: the element plays, the
       * analyser is wired to it, and every bin reads zero forever. Resuming
       * is the whole difference between a mark that moves and one that does
       * not, and it has to happen on every later resume too.
       */
      const ctx = new AudioContext();
      await ctx.resume();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      // Without this the bands twitch on every frame and the mark strobes.
      analyser.smoothingTimeConstant = 0.55;
      ctx.createMediaElementSource(el).connect(analyser);
      analyser.connect(ctx.destination);
      el.volume = 0.35;
      await el.play();
      this.el = el;
      this.ctx = ctx;
      this.analyser = analyser;
      this.bins = new Uint8Array(analyser.frequencyBinCount);
      this.analysed = true;
      this.frame = requestAnimationFrame(this.publish);
      return true;
    }

    const api = await loadYouTube();
    this.player = new api.Player(NODE, {
      videoId: TRACK,
      playerVars: { autoplay: 1, controls: 0, loop: 1, playlist: TRACK, playsinline: 1 },
      events: {
        onReady: (e: { target: Player }) => {
          e.target.setVolume(35);
          e.target.unMute();
          e.target.playVideo();
        },
      },
    });
    return true;
  }
}

export const PLAYER_NODE = NODE;
