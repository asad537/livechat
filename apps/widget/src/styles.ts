// ─── All widget styles live here as one template string ──────
// Injected into the Shadow DOM root; themed via CSS custom
// properties set on `.lc-root` (see app.tsx). No .css imports —
// the lib build must emit a single JS file.

export const WIDGET_CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

.lc-root {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  color: #0f172a;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
/* :where() keeps these resets at zero specificity so single-class
   component styles (.lc-accept, .lc-ctl, …) always win over them. */
:where(.lc-root) :where(button) { font: inherit; border: none; background: none; cursor: pointer; color: inherit; }
:where(.lc-root) :where(textarea, input) { font: inherit; color: inherit; }
.lc-root svg { display: block; }

/* ── Launcher ─────────────────────────────────────────────── */
.lc-launcher {
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
  width: 58px; height: 58px; border-radius: 50%;
  background: var(--lc-header);
  color: var(--lc-on-header);
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 8px 24px rgba(15, 23, 42, .24), 0 2px 6px rgba(15, 23, 42, .18);
  transition: transform .18s ease, box-shadow .18s ease;
  animation: lc-rise .3s cubic-bezier(.21, 1.02, .55, 1.01);
}
.lc-launcher:hover { transform: scale(1.07); box-shadow: 0 12px 30px rgba(15, 23, 42, .3); }
.lc-launcher:active { transform: scale(.97); }
.lc-launcher .lc-launcher-icon { transition: transform .2s ease; }
.lc-launcher.lc-pulse::before {
  content: ''; position: absolute; inset: 0; border-radius: 50%;
  animation: lc-pulse 1.7s ease-out infinite;
}
@keyframes lc-pulse {
  0%   { box-shadow: 0 0 0 0 var(--lc-glow); }
  70%  { box-shadow: 0 0 0 16px rgba(0, 0, 0, 0); }
  100% { box-shadow: 0 0 0 16px rgba(0, 0, 0, 0); }
}
@keyframes lc-rise { from { opacity: 0; transform: translateY(16px) scale(.7); } to { opacity: 1; transform: none; } }
.lc-badge {
  position: absolute; top: -3px; right: -3px;
  min-width: 21px; height: 21px; padding: 0 5px; border-radius: 11px;
  background: #ef4444; color: #fff; font-size: 11px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  border: 2px solid #ffffff;
  animation: lc-rise .25s ease;
}

/* ── Panel shell ──────────────────────────────────────────── */
.lc-panel, .lc-callwin {
  position: fixed; right: 20px; bottom: 92px; z-index: 2147483001;
  width: 380px; height: min(600px, calc(100vh - 120px));
  border-radius: 18px; overflow: hidden;
  display: flex; flex-direction: column;
  background: #f8fafc;
  box-shadow: 0 24px 64px rgba(15, 23, 42, .30), 0 4px 16px rgba(15, 23, 42, .12);
  animation: lc-pop .24s cubic-bezier(.21, 1.02, .55, 1.01);
  transform-origin: bottom right;
}
@keyframes lc-pop { from { opacity: 0; transform: translateY(14px) scale(.96); } to { opacity: 1; transform: none; } }

/* ── Header (premium) ─────────────────────────────────────── */
.lc-header {
  position: relative; flex-shrink: 0;
  background: var(--lc-header);
  color: var(--lc-on-header);
  padding: 16px 14px 16px 16px;
  display: flex; align-items: center; gap: 12px;
  box-shadow: 0 2px 10px rgba(15, 23, 42, .1);
}
.lc-logo {
  width: 42px; height: 42px; border-radius: 14px; flex-shrink: 0;
  background: rgba(255, 255, 255, .16);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, .25);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .25), 0 4px 10px rgba(0, 0, 0, .12);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.lc-logo img { width: 100%; height: 100%; object-fit: cover; display: block; }
.lc-head-info { flex: 1; min-width: 0; }
.lc-title {
  font-size: 16px; font-weight: 800; letter-spacing: -.01em;
  text-shadow: 0 1px 2px rgba(0, 0, 0, .12);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.lc-subtitle { font-size: 12px; opacity: .92; margin-top: 2px; display: flex; align-items: center; gap: 6px; }
.lc-subtitle::before {
  content: ''; width: 7px; height: 7px; border-radius: 50%; background: #4ade80;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, .3);
  animation: lc-online 2.2s ease-in-out infinite;
}
.lc-agent-chip {
  display: inline-flex; align-items: center; gap: 7px; font-size: 12px; margin-top: 4px;
  background: rgba(255, 255, 255, .14);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, .22);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, .18);
  border-radius: 999px; padding: 3px 11px 3px 3px; max-width: 100%;
}
.lc-agent-chip .lc-agent-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
.lc-avatar-dot {
  width: 22px; height: 22px; border-radius: 50%; flex-shrink: 0;
  color: #fff; font-size: 9px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, .55);
}
.lc-online-dot {
  width: 7px; height: 7px; border-radius: 50%; background: #4ade80; flex-shrink: 0;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, .35);
  animation: lc-online 2.2s ease-in-out infinite;
}
@keyframes lc-online {
  0%, 100% { box-shadow: 0 0 0 2px rgba(255, 255, 255, .35), 0 0 0 0 rgba(74, 222, 128, .55); }
  55%      { box-shadow: 0 0 0 2px rgba(255, 255, 255, .35), 0 0 0 5px rgba(74, 222, 128, 0); }
}
.lc-iconbtn {
  width: 34px; height: 34px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(255, 255, 255, .1);
  border: 1px solid rgba(255, 255, 255, .16);
  opacity: .92;
  transition: background .15s ease, opacity .15s ease, transform .12s ease;
}
.lc-iconbtn:hover { opacity: 1; background: rgba(255, 255, 255, .22); transform: translateY(-1px); }
.lc-iconbtn:active { transform: translateY(0) scale(.95); }

/* ── Status strips ────────────────────────────────────────── */
.lc-strip {
  flex-shrink: 0; padding: 8px 14px; font-size: 12.5px;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  background: var(--lc-soft); color: #334155; border-bottom: 1px solid rgba(15, 23, 42, .06);
}
.lc-strip-warn { background: #fffbeb; color: #92400e; border-bottom-color: #fde68a; }
.lc-spin {
  width: 13px; height: 13px; border-radius: 50%; flex-shrink: 0;
  border: 2px solid rgba(0, 0, 0, .12); border-top-color: var(--lc-primary);
  animation: lc-rot .8s linear infinite;
}
@keyframes lc-rot { to { transform: rotate(360deg); } }

/* ── Messages area ────────────────────────────────────────── */
.lc-body {
  flex: 1; overflow-y: auto; overflow-x: hidden;
  padding: 16px 14px 12px;
  display: flex; flex-direction: column; gap: 10px;
  scroll-behavior: smooth;
}
.lc-body::-webkit-scrollbar { width: 6px; }
.lc-body::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
.lc-body::-webkit-scrollbar-track { background: transparent; }

.lc-day {
  align-self: center; margin: 6px 0 2px;
  font-size: 11px; font-weight: 600; color: #64748b;
  background: #e2e8f0; padding: 3px 11px; border-radius: 999px;
}

.lc-row { display: flex; flex-direction: column; max-width: 84%; animation: lc-msg .2s ease; }
@keyframes lc-msg { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.lc-row-v { align-self: flex-end; align-items: flex-end; }
.lc-row-a { align-self: flex-start; }
.lc-arow { display: flex; align-items: flex-end; gap: 8px; }
.lc-arow .lc-avatar-dot { margin-bottom: 2px; }

.lc-bubble {
  padding: 9px 13px; border-radius: 16px;
  font-size: 13.5px; white-space: pre-wrap; word-break: break-word;
  box-shadow: 0 1px 2px rgba(15, 23, 42, .07);
}
.lc-bubble-v {
  background: var(--lc-primary);
  color: var(--lc-on-primary); border-bottom-right-radius: 5px;
}
.lc-bubble-a { background: #ffffff; color: #1e293b; border: 1px solid #e2e8f0; border-bottom-left-radius: 5px; }
.lc-pending { opacity: .65; }
.lc-meta { display: flex; align-items: center; gap: 4px; font-size: 10.5px; color: #94a3b8; margin-top: 3px; padding: 0 3px; }
.lc-ticks { display: inline-flex; color: #94a3b8; }
.lc-ticks-read { color: var(--lc-primary); }

.lc-system {
  align-self: center; max-width: 92%; text-align: center;
  font-size: 11.5px; color: #64748b;
  background: #eef2f7; border: 1px solid #e2e8f0;
  padding: 5px 13px; border-radius: 999px;
}

.lc-greet {
  align-self: flex-start; max-width: 88%;
  background: var(--lc-soft); border: 1px solid rgba(15, 23, 42, .05);
  color: #1e293b; border-radius: 16px; border-bottom-left-radius: 5px;
  padding: 11px 14px; font-size: 13.5px;
  animation: lc-msg .3s ease;
}

/* typing dots */
.lc-dots { display: inline-flex; gap: 4px; padding: 4px 2px; }
.lc-dots span {
  width: 6px; height: 6px; border-radius: 50%; background: #94a3b8;
  animation: lc-blink 1.2s infinite ease-in-out;
}
.lc-dots span:nth-child(2) { animation-delay: .15s; }
.lc-dots span:nth-child(3) { animation-delay: .3s; }
@keyframes lc-blink { 0%, 60%, 100% { opacity: .35; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-3px); } }

/* ── Pre-chat info form ───────────────────────────────────── */
.lc-form {
  background: #fff; border: 1px solid #e2e8f0; border-radius: 14px;
  padding: 13px; display: flex; flex-direction: column; gap: 8px;
  box-shadow: 0 2px 8px rgba(15, 23, 42, .06);
  animation: lc-msg .25s ease;
}
.lc-form-title { font-size: 13px; font-weight: 700; color: #334155; }
.lc-form-sub { font-size: 11.5px; color: #64748b; margin-top: -4px; }
.lc-input {
  border: 1px solid #cbd5e1; border-radius: 9px; padding: 8px 11px;
  font-size: 13px; background: #f8fafc; outline: none; width: 100%;
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.lc-input:focus { border-color: var(--lc-primary); background: #fff; box-shadow: 0 0 0 3px var(--lc-soft); }
.lc-form-row { display: flex; gap: 8px; align-items: center; }
.lc-btn {
  background: var(--lc-primary); color: var(--lc-on-primary);
  border-radius: 9px; padding: 8px 14px; font-size: 13px; font-weight: 600;
  transition: filter .15s ease, transform .1s ease;
}
.lc-btn:hover { filter: brightness(1.08); }
.lc-btn:active { transform: scale(.98); }
.lc-btn-ghost { background: none; color: #64748b; font-weight: 500; }
.lc-btn-ghost:hover { color: #334155; filter: none; }

/* ── File + call message cards ────────────────────────────── */
.lc-file {
  display: flex; align-items: center; gap: 10px;
  background: #fff; border: 1px solid #e2e8f0; border-radius: 14px;
  padding: 10px 13px; min-width: 190px; max-width: 100%;
  box-shadow: 0 1px 2px rgba(15, 23, 42, .07);
}
.lc-file-icon {
  width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0;
  background: var(--lc-soft); color: var(--lc-primary);
  display: flex; align-items: center; justify-content: center;
}
.lc-file-info { min-width: 0; flex: 1; }
.lc-file-name { font-size: 12.5px; font-weight: 600; color: #1e293b; word-break: break-all; }
.lc-file-sub { font-size: 11px; color: #64748b; margin-top: 1px; }
.lc-file-dl {
  color: var(--lc-primary); font-size: 12px; font-weight: 700; text-decoration: none;
  flex-shrink: 0; padding: 5px 8px; border-radius: 8px; transition: background .15s ease;
}
.lc-file-dl:hover { background: var(--lc-soft); }
.lc-file-blocked { color: #b91c1c; font-size: 11px; font-weight: 600; flex-shrink: 0; }

.lc-callmsg {
  display: flex; align-items: center; gap: 10px;
  background: #fff; border: 1px solid #e2e8f0; border-radius: 14px;
  padding: 10px 13px; box-shadow: 0 1px 2px rgba(15, 23, 42, .07);
}
.lc-callmsg-sub { font-size: 11px; color: #64748b; }
.lc-callmsg-body { font-size: 12.5px; font-weight: 600; color: #1e293b; }

/* ── Composer ─────────────────────────────────────────────── */
.lc-composer {
  flex-shrink: 0; padding: 10px 12px;
  background: #fff; border-top: 1px solid #e2e8f0;
  display: flex; align-items: flex-end; gap: 8px;
}
.lc-ta {
  flex: 1; resize: none; outline: none;
  border: 1px solid #dbe2ea; border-radius: 13px;
  padding: 9px 13px; max-height: 110px; min-height: 38px;
  font-size: 13.5px; line-height: 1.4; background: #f8fafc;
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.lc-ta:focus { border-color: var(--lc-primary); background: #fff; box-shadow: 0 0 0 3px var(--lc-soft); }
.lc-ta::placeholder { color: #94a3b8; }
.lc-attach {
  width: 36px; height: 36px; border-radius: 10px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  color: #64748b; transition: color .15s ease, background .15s ease;
  margin-bottom: 1px;
}
.lc-attach:hover:not(:disabled) { color: var(--lc-primary); background: var(--lc-soft); }
.lc-attach:disabled { opacity: .4; cursor: default; }
.lc-send {
  width: 38px; height: 38px; border-radius: 50%; flex-shrink: 0;
  background: var(--lc-primary); color: var(--lc-on-primary);
  display: flex; align-items: center; justify-content: center;
  transition: transform .12s ease, filter .15s ease, opacity .15s ease;
  box-shadow: 0 2px 6px var(--lc-glow);
}
.lc-send:hover:not(:disabled) { filter: brightness(1.08); transform: scale(1.05); }
.lc-send:disabled { opacity: .45; cursor: default; box-shadow: none; }

/* ── Closed / ended bar ───────────────────────────────────── */
.lc-closedbar {
  flex-shrink: 0; padding: 14px; background: #fff; border-top: 1px solid #e2e8f0;
  display: flex; flex-direction: column; align-items: center; gap: 9px;
  font-size: 12.5px; color: #64748b; text-align: center;
}

/* ── Links inside messages ────────────────────────────────── */
.lc-bubble .lc-link { word-break: break-all; text-decoration: underline; }
.lc-bubble-a .lc-link { color: var(--lc-primary); font-weight: 600; }
.lc-bubble-v .lc-link { color: inherit; }

/* ── CSAT rating card ─────────────────────────────────────── */
.lc-ratebox { display: flex; flex-direction: column; align-items: center; gap: 8px; width: 100%; }
.lc-rate-title { font-size: 13.5px; font-weight: 700; color: #0f172a; }
.lc-stars { display: flex; gap: 4px; }
.lc-star {
  font-size: 28px; line-height: 1; color: #d7dee8; padding: 2px 3px;
  transition: color .12s ease, transform .12s ease;
}
.lc-star:hover { transform: scale(1.18); }
.lc-star-on { color: #f59e0b; text-shadow: 0 2px 8px rgba(245, 158, 11, .35); }
.lc-rate-comment {
  width: 100%; resize: none; border: 1.5px solid #e2e8f0; border-radius: 10px;
  padding: 8px 10px; font-size: 13px; outline: none; background: #f8fafc;
}
.lc-rate-comment:focus { border-color: var(--lc-primary); background: #fff; }
.lc-rate-submit { width: 100%; }

/* ── Toast ────────────────────────────────────────────────── */
.lc-toast {
  position: absolute; top: 74px; left: 50%; transform: translateX(-50%);
  max-width: 90%; z-index: 30;
  background: #0f172a; color: #f1f5f9; font-size: 12px;
  padding: 8px 14px; border-radius: 10px;
  box-shadow: 0 8px 20px rgba(15, 23, 42, .35);
  animation: lc-msg .2s ease; text-align: center;
}

/* ── Incoming call card ───────────────────────────────────── */
.lc-invite {
  position: fixed; right: 20px; bottom: 92px; z-index: 2147483002;
  width: 320px; background: #fff; border-radius: 16px;
  box-shadow: 0 24px 64px rgba(15, 23, 42, .35), 0 4px 16px rgba(15, 23, 42, .15);
  padding: 16px; display: flex; flex-direction: column; gap: 14px;
  animation: lc-pop .25s cubic-bezier(.21, 1.02, .55, 1.01);
}
.lc-invite-head { display: flex; align-items: center; gap: 12px; }
.lc-invite-icon {
  width: 44px; height: 44px; border-radius: 50%; flex-shrink: 0;
  background: var(--lc-soft); color: var(--lc-primary);
  display: flex; align-items: center; justify-content: center;
  animation: lc-ring 1.2s ease-in-out infinite;
}
@keyframes lc-ring { 0%, 100% { transform: rotate(0); } 10% { transform: rotate(-12deg); } 20% { transform: rotate(10deg); } 30% { transform: rotate(-8deg); } 40% { transform: rotate(6deg); } 50% { transform: rotate(0); } }
.lc-invite-title { font-size: 14px; font-weight: 700; color: #0f172a; }
.lc-invite-sub { font-size: 12px; color: #64748b; margin-top: 1px; }
.lc-invite-actions { display: flex; gap: 10px; }
.lc-invite-actions button {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 7px;
  padding: 10px; border-radius: 11px; font-size: 13px; font-weight: 700; color: #fff;
  transition: filter .15s ease, transform .1s ease;
}
.lc-invite-actions button:hover { filter: brightness(1.1); }
.lc-invite-actions button:active { transform: scale(.98); }
.lc-accept { background: #16a34a; }
.lc-decline { background: #ef4444; }

/* ── In-call overlay ──────────────────────────────────────── */
.lc-callwin { background: #0f172a; color: #e2e8f0; z-index: 2147483003; }
.lc-callhead {
  flex-shrink: 0; padding: 13px 16px; color: #e2e8f0;
  display: flex; align-items: center; gap: 10px; font-size: 13px;
  background: rgba(255, 255, 255, .04);
}
.lc-callhead-title { font-weight: 700; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lc-callhead-status { font-size: 11.5px; color: #94a3b8; display: flex; align-items: center; gap: 6px; }
.lc-livedot { width: 7px; height: 7px; border-radius: 50%; background: #4ade80; animation: lc-blink 1.4s infinite; }
.lc-tiles {
  flex: 1; min-height: 0; display: grid; gap: 8px;
  padding: 10px 10px 84px; /* bottom room so tiles never hide behind the floating control bar */
  grid-template-columns: 1fr; grid-auto-rows: minmax(0, 1fr);
  overflow-y: auto;
}
.lc-tiles-many { grid-template-columns: 1fr 1fr; }
.lc-tile { position: relative; background: #1e293b; border-radius: 12px; overflow: hidden; min-height: 110px; }
.lc-tile video { width: 100%; height: 100%; object-fit: cover; display: block; background: #1e293b; }
.lc-tile-avatar {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
}
.lc-tile-avatar .lc-bigdot {
  width: 64px; height: 64px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: #fff; font-size: 22px; font-weight: 700;
  box-shadow: 0 0 0 8px rgba(255, 255, 255, .07);
}
.lc-tile-label {
  position: absolute; left: 8px; bottom: 8px;
  background: rgba(15, 23, 42, .6); color: #e2e8f0;
  font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px;
  max-width: calc(100% - 16px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.lc-callbar {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 5;
  display: flex; align-items: center; justify-content: center; gap: 14px;
  padding: 16px 15px calc(16px + env(safe-area-inset-bottom, 0px));
  background: linear-gradient(to top, rgba(15, 23, 42, .96) 55%, rgba(15, 23, 42, 0));
}
.lc-ctl {
  width: 46px; height: 46px; border-radius: 50%;
  background: rgba(255, 255, 255, .13); color: #fff;
  display: flex; align-items: center; justify-content: center;
  transition: background .15s ease, transform .1s ease;
}
.lc-ctl:hover { background: rgba(255, 255, 255, .22); }
.lc-ctl:active { transform: scale(.94); }
.lc-ctl-off { background: #f8fafc; color: #0f172a; }
.lc-ctl-off:hover { background: #e2e8f0; }
.lc-ctl-end { background: #ef4444; }
.lc-ctl-end:hover { background: #dc2626; }

/* ── Queue animation (Finding an agent…) ──────────────────── */
.lc-strip-queue {
  display: flex; align-items: center; gap: 10px;
  font-weight: 600; color: #334155;
  background: linear-gradient(90deg, var(--lc-soft), #ffffff, var(--lc-soft));
  background-size: 200% 100%;
  animation: lc-shimmer 2.4s linear infinite;
}
@keyframes lc-shimmer { from { background-position: 0% 0; } to { background-position: -200% 0; } }
.lc-radar { position: relative; width: 22px; height: 22px; flex-shrink: 0; }
.lc-radar::after {
  content: ''; position: absolute; inset: 7px; border-radius: 50%;
  background: var(--lc-primary);
}
.lc-radar span {
  position: absolute; inset: 0; border-radius: 50%;
  border: 2px solid var(--lc-primary); opacity: 0;
  animation: lc-radar 1.8s ease-out infinite;
}
.lc-radar span:nth-child(2) { animation-delay: .6s; }
.lc-radar span:nth-child(3) { animation-delay: 1.2s; }
@keyframes lc-radar {
  0%   { transform: scale(.35); opacity: .9; }
  70%  { opacity: .3; }
  100% { transform: scale(1.25); opacity: 0; }
}
.lc-dots i { display: inline-block; font-style: normal; animation: lc-dotbounce 1.2s infinite; }
.lc-dots i:nth-child(2) { animation-delay: .15s; }
.lc-dots i:nth-child(3) { animation-delay: .3s; }
@keyframes lc-dotbounce {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-3px); }
}

/* ── End-chat header button ───────────────────────────────── */
/* Static outlined circle — no hover effect */
.lc-endbtn,
.lc-endbtn:hover {
  background: transparent;
  border: 1.5px solid currentColor;
  box-shadow: none;
  transform: none;
  opacity: 0.9;
  color: inherit;
}

/* ── Mobile: full-screen panel ────────────────────────────── */
@media (max-width: 480px) {
  .lc-panel, .lc-callwin {
    right: 0; bottom: 0; width: 100vw;
    height: 100vh; height: 100dvh;
    border-radius: 0;
  }
  .lc-invite { right: 10px; left: 10px; width: auto; bottom: 14px; }
}


/* Inline end-chat confirmation */
:where(.lc-root) .lc-confirm {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: #fef2f2;
  border-bottom: 1px solid #fecaca;
  color: #991b1b;
  font-size: 13px;
  font-weight: 600;
  animation: lc-fade 0.15s ease;
}
:where(.lc-root) .lc-confirm span { flex: 1; }
:where(.lc-root) .lc-confirm-yes {
  background: #dc2626;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 6px 12px;
  font: inherit;
  font-size: 12.5px;
  font-weight: 700;
  cursor: pointer;
}
:where(.lc-root) .lc-confirm-yes:hover { background: #b91c1c; }
:where(.lc-root) .lc-confirm-no {
  background: transparent;
  color: #6b7280;
  border: none;
  padding: 6px 8px;
  font: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
}
:where(.lc-root) .lc-confirm-no:hover { color: #111827; }
@keyframes lc-fade { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

:where(.lc-root) .lc-avatar-img { object-fit: cover; padding: 0; border: none; }
`;
