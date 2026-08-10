// ─── Sound + desktop notifications for agents ────────────────
// Chimes are synthesized with WebAudio (no audio assets); desktop
// notifications fire only when the tab is not focused.

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

// Master output: a hot gain into a compressor — alerts play LOUD without
// clipping, and every synthesized sound routes through this one chain.
let boostNode: GainNode | null = null;

function output(ac: AudioContext): AudioNode {
  if (!boostNode) {
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 8;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    boostNode = ac.createGain();
    boostNode.gain.value = 1.9;
    boostNode.connect(comp);
    comp.connect(ac.destination);
  }
  return boostNode;
}

function tone(ac: AudioContext, freq: number, start: number, duration: number, peak: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(output(ac));
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

/** One short, dull knock: a low burst with a fast decay (wood-ish thud). */
function knock(ac: AudioContext, start: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'triangle';
  // Quick downward pitch drop gives the "tok" of a knuckle on a door.
  osc.frequency.setValueAtTime(200, start);
  osc.frequency.exponentialRampToValueAtTime(90, start + 0.06);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.6, start + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
  osc.connect(gain).connect(output(ac));
  osc.start(start);
  osc.stop(start + 0.16);
}

/** Mallet-style note: instant attack, fast wooden decay (marimba/jingle). */
function strike(ac: AudioContext, freq: number, start: number, peak: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.24);
  osc.connect(gain).connect(output(ac));
  osc.start(start);
  osc.stop(start + 0.27);
}

/** Flat square-wave beep (urgent alert). */
function beep(ac: AudioContext, freq: number, start: number, dur: number, peak: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + 0.006);
  gain.gain.setValueAtTime(peak, start + dur - 0.02);
  gain.gain.linearRampToValueAtTime(0, start + dur);
  osc.connect(gain).connect(output(ac));
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/** Upward frequency sweep — a birdie chirp. */
function chirp(ac: AudioContext, start: number, f0: number, f1: number, dur: number, peak: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(f0, start);
  osc.frequency.exponentialRampToValueAtTime(f1, start + dur);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + dur + 0.06);
  osc.connect(gain).connect(output(ac));
  osc.start(start);
  osc.stop(start + dur + 0.09);
}

/** Bubble pop: quick high→low pitch drop. */
function pop(ac: AudioContext, start: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(560, start);
  osc.frequency.exponentialRampToValueAtTime(150, start + 0.07);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.6, start + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
  osc.connect(gain).connect(output(ac));
  osc.start(start);
  osc.stop(start + 0.15);
}

/**
 * Sounds:
 *  - 'new-chat'  → pleasant two-note chime
 *  - 'message'   → single soft note
 *  - 'visitor'   → the agent's chosen new-visitor sound
 */
export function playChime(kind: 'new-chat' | 'message' | 'visitor' = 'new-chat'): void {
  if (kind === 'visitor') return playVisitorSound();
  const ac = audioCtx();
  if (!ac) return;
  const t = ac.currentTime;
  if (kind === 'new-chat') {
    tone(ac, 880, t, 0.35, 0.22);
    tone(ac, 1318.5, t + 0.14, 0.45, 0.18);
  } else {
    tone(ac, 740, t, 0.28, 0.14);
  }
}

// ─── Visitor-arrival sound preference (per browser) ──────────
export type VisitorSound =
  | 'knock'
  | 'doorbell'
  | 'chime'
  | 'bell'
  | 'ping'
  | 'marimba'
  | 'alert'
  | 'bird'
  | 'pop'
  | 'melody'
  | 'custom'
  | 'off';

const SOUND_PREF_KEY = 'livechat.visitorSound';
const SOUND_DATA_KEY = 'livechat.visitorSound.custom'; // uploaded audio data URL

export const VISITOR_SOUND_OPTIONS: { value: VisitorSound; label: string }[] = [
  { value: 'knock', label: 'Door knock' },
  { value: 'doorbell', label: 'Doorbell' },
  { value: 'chime', label: 'Chime' },
  { value: 'bell', label: 'Bell' },
  { value: 'ping', label: 'Ping' },
  { value: 'marimba', label: 'Marimba' },
  { value: 'alert', label: 'Alert' },
  { value: 'bird', label: 'Birdie' },
  { value: 'pop', label: 'Pop' },
  { value: 'melody', label: 'Melody' },
  { value: 'custom', label: 'My uploaded sound' },
  { value: 'off', label: 'Off (silent)' },
];

// Every alert plays its motif this many times so it can't be missed.
const REPEAT = 3;

// Each builder plays ONE pass of its motif at `t` and returns the pass
// length (including the little pause before the next repeat).
const BUILDERS: Record<Exclude<VisitorSound, 'custom' | 'off'>, (ac: AudioContext, t: number) => number> = {
  knock: (ac, t) => {
    knock(ac, t);
    knock(ac, t + 0.22);
    return 0.78;
  },
  doorbell: (ac, t) => {
    tone(ac, 659.25, t, 0.45, 0.5); // ding…
    tone(ac, 523.25, t + 0.28, 0.55, 0.45); // …dong
    return 1.05;
  },
  chime: (ac, t) => {
    tone(ac, 880, t, 0.3, 0.45);
    tone(ac, 1318.5, t + 0.13, 0.4, 0.4);
    return 0.85;
  },
  bell: (ac, t) => {
    tone(ac, 660, t, 0.5, 0.45);
    tone(ac, 990, t + 0.02, 0.55, 0.28);
    tone(ac, 1980, t + 0.02, 0.3, 0.1);
    return 0.95;
  },
  ping: (ac, t) => {
    tone(ac, 1046.5, t, 0.35, 0.55);
    return 0.7;
  },
  marimba: (ac, t) => {
    strike(ac, 523.25, t, 0.5);
    strike(ac, 659.25, t + 0.12, 0.5);
    strike(ac, 783.99, t + 0.24, 0.55);
    return 0.82;
  },
  alert: (ac, t) => {
    beep(ac, 1175, t, 0.11, 0.35);
    beep(ac, 1175, t + 0.18, 0.11, 0.35);
    return 0.75;
  },
  bird: (ac, t) => {
    chirp(ac, t, 900, 1800, 0.12, 0.45);
    chirp(ac, t + 0.2, 1100, 2100, 0.12, 0.4);
    return 0.75;
  },
  pop: (ac, t) => {
    pop(ac, t);
    pop(ac, t + 0.16);
    return 0.7;
  },
  melody: (ac, t) => {
    strike(ac, 523.25, t, 0.45);
    strike(ac, 659.25, t + 0.14, 0.45);
    strike(ac, 783.99, t + 0.28, 0.45);
    strike(ac, 1046.5, t + 0.42, 0.5);
    return 1.1;
  },
};

export function getVisitorSound(): VisitorSound {
  try {
    return (localStorage.getItem(SOUND_PREF_KEY) as VisitorSound) || 'knock';
  } catch {
    return 'knock';
  }
}

export function setVisitorSound(v: VisitorSound): void {
  try {
    localStorage.setItem(SOUND_PREF_KEY, v);
  } catch {
    /* ignore */
  }
}

export function getCustomSound(): string | null {
  try {
    return localStorage.getItem(SOUND_DATA_KEY);
  } catch {
    return null;
  }
}

/** Store an uploaded sound (data URL). Returns false if too large for storage. */
export function setCustomSound(dataUrl: string): boolean {
  try {
    localStorage.setItem(SOUND_DATA_KEY, dataUrl);
    return true;
  } catch {
    return false; // quota exceeded
  }
}

let customAudio: HTMLAudioElement | null = null;

/** Play whatever the agent chose for new-visitor alerts (motif × 3, loud). */
export function playVisitorSound(pref: VisitorSound = getVisitorSound()): void {
  if (pref === 'off') return;
  if (pref === 'custom') {
    const url = getCustomSound();
    if (!url) return playBuiltIn('knock');
    try {
      if (!customAudio) customAudio = new Audio();
      const a = customAudio;
      a.src = url;
      a.volume = 1; // full volume
      let left = REPEAT;
      a.onended = () => {
        if (--left > 0) {
          a.currentTime = 0;
          void a.play();
        }
      };
      a.currentTime = 0;
      void a.play();
    } catch {
      /* autoplay blocked until a gesture */
    }
    return;
  }
  playBuiltIn(pref);
}

function playBuiltIn(pref: Exclude<VisitorSound, 'custom' | 'off'>): void {
  const ac = audioCtx();
  if (!ac) return;
  const build = BUILDERS[pref] ?? BUILDERS.knock;
  let t = ac.currentTime + 0.02;
  for (let i = 0; i < REPEAT; i++) t += build(ac, t);
}

/** Ask once for permission (call after login, on a user-gesture-adjacent path). */
export function ensureNotifyPermission(): void {
  if ('Notification' in window && Notification.permission === 'default') {
    void Notification.requestPermission();
  }
}

/** Desktop notification — only when the dashboard tab is not focused. */
export function desktopNotify(title: string, body: string, tag: string): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.hasFocus()) return;
  try {
    const n = new Notification(title, { body, tag, icon: undefined });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* some browsers require a service worker — ignore */
  }
}
