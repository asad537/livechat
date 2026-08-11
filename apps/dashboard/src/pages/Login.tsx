import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../state';
import { LogoMark } from '../icons';

// Small inline dashboard mock shown on the marketing side of the login.
function DashboardPreview() {
  return (
    <div className="lp-preview">
      <aside className="lp-side">
        <div className="lp-side-brand">
          <span className="lp-side-logo">
            <LogoMark size={14} />
          </span>
          <span>
            <b>TCB Connect</b>
            <i>The Custom Boxes</i>
          </span>
        </div>
        <div className="lp-side-label">Workspace</div>
        {['Dashboard', 'Inbox', 'Visitors', 'Visitor History', 'Chat History', 'Monitoring', 'Reports'].map(
          (n, i) => (
            <div key={n} className={`lp-nav ${i === 0 ? 'active' : ''}`}>
              <span className="lp-nav-ic" />
              {n}
              {n === 'Inbox' && <span className="lp-nav-badge">6</span>}
            </div>
          ),
        )}
        <div className="lp-side-label lp-side-label-admin">Admin</div>
        <div className="lp-nav">
          <span className="lp-nav-ic" />
          Agents
        </div>
      </aside>
      <div className="lp-main">
        <div className="lp-main-head">
          <div>
            <div className="lp-h1">Dashboard</div>
            <div className="lp-h2">Overview of your live chat performance</div>
          </div>
        </div>
        <div className="lp-tiles">
          {[
            { l: 'Active chats', v: '4', c: '#16a34a', t: '#dcfce7' },
            { l: 'In queue', v: '11', c: '#ea580c', t: '#ffedd5' },
            { l: 'Closed chats', v: '7', c: '#2563eb', t: '#dbeafe', d: '↑ 17%' },
          ].map((t) => (
            <div key={t.l} className="lp-tile">
              <div className="lp-tile-top">
                <span className="lp-tile-l">{t.l}</span>
                <span className="lp-tile-ic" style={{ background: t.t, color: t.c }} />
              </div>
              <span className="lp-tile-v">{t.v}</span>
              {t.d && <span className="lp-tile-d">{t.d}</span>}
            </div>
          ))}
        </div>
        <div className="lp-chart">
          <div className="lp-chart-head">
            Chats over time <span>— last 14 days</span>
          </div>
          <svg viewBox="0 0 300 90" preserveAspectRatio="none" className="lp-chart-svg">
            <defs>
              <linearGradient id="lpFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#5865f2" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#5865f2" stopOpacity="0" />
              </linearGradient>
            </defs>
            <polygon
              points="6,80 6,78 40,78 74,77 108,78 142,76 176,77 210,74 244,70 268,40 294,10 294,80"
              fill="url(#lpFill)"
            />
            <polyline
              points="6,78 40,78 74,77 108,78 142,76 176,77 210,74 244,70 268,40 294,10"
              fill="none"
              stroke="#5865f2"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <circle cx="294" cy="10" r="3" fill="#5865f2" />
          </svg>
        </div>
        <div className="lp-bottom">
          <div className="lp-mini-card">
            <div className="lp-mini-head">Response Time Trend</div>
            <div className="lp-legend">
              <span>
                <i style={{ background: '#5865f2' }} /> First Response
              </span>
              <span>
                <i style={{ background: '#2563eb' }} /> Response Time
              </span>
            </div>
            <svg viewBox="0 0 160 60" className="lp-mini-svg">
              <polyline points="8,12 40,40 72,46 104,48 136,48" fill="none" stroke="#5865f2" strokeWidth="2" />
              <polyline points="8,30 40,50 72,52 104,52 136,52" fill="none" stroke="#2563eb" strokeWidth="2" />
            </svg>
          </div>
          <div className="lp-mini-card lp-donut-card">
            <div className="lp-mini-head">Chats by status</div>
            <div className="lp-donut">
              <svg viewBox="0 0 42 42">
                <circle cx="21" cy="21" r="15.9" fill="none" stroke="#5865f2" strokeWidth="6" strokeDasharray="45 55" strokeDashoffset="0" transform="rotate(-90 21 21)" />
                <circle cx="21" cy="21" r="15.9" fill="none" stroke="#ea580c" strokeWidth="6" strokeDasharray="30 70" strokeDashoffset="-45" transform="rotate(-90 21 21)" />
                <circle cx="21" cy="21" r="15.9" fill="none" stroke="#22c55e" strokeWidth="6" strokeDasharray="12 88" strokeDashoffset="-75" transform="rotate(-90 21 21)" />
                <circle cx="21" cy="21" r="15.9" fill="none" stroke="#ef4444" strokeWidth="6" strokeDasharray="8 92" strokeDashoffset="-87" transform="rotate(-90 21 21)" />
              </svg>
              <div className="lp-donut-c">
                <b>21</b>
                <i>Total</i>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const MailIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2" />
    <path d="m22 7-10 6L2 7" />
  </svg>
);
const LockIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="11" width="18" height="11" rx="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);
export default function Login() {
  const { login } = useApp();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password, remember);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth2">
      {/* ── Left: welcome + dashboard preview ── */}
      <section className="auth2-left">
        <div className="auth2-brand">
          <span className="auth2-brand-logo">
            <LogoMark size={26} />
          </span>
          <span className="auth2-brand-text">
            <b>TCB Connect</b>
            <i>The Custom Boxes</i>
          </span>
        </div>
        <div className="auth2-welcome">
          <h1>Welcome back! 👋</h1>
          <p>Sign in to your account and continue managing your live chat conversations.</p>
        </div>
        <DashboardPreview />
        <div className="auth2-foot">© {new Date().getFullYear()} TCB Connect. All rights reserved.</div>
      </section>

      {/* ── Right: sign-in form ── */}
      <section className="auth2-right">
        <form className="auth2-form" onSubmit={submit}>
          <div className="auth2-form-head">
            <h2>Sign in to your account</h2>
            <p>Enter your credentials to access your workspace</p>
          </div>

          {error && <div className="form-error auth2-err">{error}</div>}

          <label className="auth2-label">Email address</label>
          <div className="auth2-input">
            <span className="auth2-input-ic">
              <MailIcon />
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email"
              autoComplete="email"
              autoFocus
              required
            />
          </div>

          <label className="auth2-label">Password</label>
          <div className="auth2-input">
            <span className="auth2-input-ic">
              <LockIcon />
            </span>
            <input
              type={showPw ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              className="auth2-eye"
              onClick={() => setShowPw((s) => !s)}
              aria-label={showPw ? 'Hide password' : 'Show password'}
              tabIndex={-1}
            >
              {showPw ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              )}
            </button>
          </div>

          <div className="auth2-row">
            <label className="auth2-remember">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span className="auth2-check" />
              Remember me
            </label>
          </div>

          <button className="btn btn-primary auth2-submit" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="auth2-help">Trouble signing in? Ask your admin to reset your password.</p>
        </form>
      </section>
    </div>
  );
}
