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

function tone(ac: AudioContext, freq: number, start: number, duration: number, peak: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(ac.destination);
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
  gain.gain.linearRampToValueAtTime(0.28, start + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.13);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + 0.16);
}

/**
 * Sounds:
 *  - 'new-chat'  → pleasant two-note chime
 *  - 'message'   → single soft note
 *  - 'visitor'   → two door knocks (a visitor just landed on a site)
 */
export function playChime(kind: 'new-chat' | 'message' | 'visitor' = 'new-chat'): void {
  const ac = audioCtx();
  if (!ac) return;
  const t = ac.currentTime;
  if (kind === 'new-chat') {
    tone(ac, 880, t, 0.35, 0.12);
    tone(ac, 1318.5, t + 0.14, 0.45, 0.1);
  } else if (kind === 'visitor') {
    // Door knock: knock-knock … knock-knock (~1.4s, unmistakable alert).
    knock(ac, t);
    knock(ac, t + 0.24);
    knock(ac, t + 0.9);
    knock(ac, t + 1.14);
  } else {
    tone(ac, 740, t, 0.28, 0.08);
  }
}

// ─── Visitor-arrival sound preference (per browser) ──────────
export type VisitorSound = 'knock' | 'chime' | 'ping' | 'bell' | 'custom' | 'off';

const SOUND_PREF_KEY = 'livechat.visitorSound';
const SOUND_DATA_KEY = 'livechat.visitorSound.custom'; // uploaded audio data URL

export const VISITOR_SOUND_OPTIONS: { value: VisitorSound; label: string }[] = [
  { value: 'knock', label: 'Door knock' },
  { value: 'chime', label: 'Chime' },
  { value: 'ping', label: 'Ping' },
  { value: 'bell', label: 'Bell' },
  { value: 'custom', label: 'My uploaded sound' },
  { value: 'off', label: 'Off (silent)' },
];

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

/** Play whatever the agent chose for new-visitor alerts. */
export function playVisitorSound(pref: VisitorSound = getVisitorSound()): void {
  if (pref === 'off') return;
  if (pref === 'custom') {
    const url = getCustomSound();
    if (!url) return playBuiltIn('knock');
    try {
      if (!customAudio) customAudio = new Audio();
      customAudio.src = url;
      customAudio.currentTime = 0;
      void customAudio.play();
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
  const t = ac.currentTime;
  if (pref === 'knock') {
    knock(ac, t);
    knock(ac, t + 0.24);
    knock(ac, t + 0.9);
    knock(ac, t + 1.14);
  } else if (pref === 'chime') {
    tone(ac, 880, t, 0.35, 0.12);
    tone(ac, 1318.5, t + 0.14, 0.45, 0.1);
  } else if (pref === 'ping') {
    tone(ac, 1046.5, t, 0.5, 0.14);
  } else if (pref === 'bell') {
    tone(ac, 660, t, 0.6, 0.12);
    tone(ac, 990, t + 0.02, 0.7, 0.08);
  }
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
