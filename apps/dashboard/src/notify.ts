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

/** Pleasant two-note chime for a new chat; single soft note for a message. */
export function playChime(kind: 'new-chat' | 'message' = 'new-chat'): void {
  const ac = audioCtx();
  if (!ac) return;
  const t = ac.currentTime;
  if (kind === 'new-chat') {
    tone(ac, 880, t, 0.35, 0.12);
    tone(ac, 1318.5, t + 0.14, 0.45, 0.1);
  } else {
    tone(ac, 740, t, 0.28, 0.08);
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
