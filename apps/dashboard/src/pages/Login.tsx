import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../state';
import { LogoMark } from '../icons';

export default function Login() {
  const { login } = useApp();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      {/* Left brand panel */}
      <aside className="auth-brand">
        <div className="auth-brand-top">
          <span className="auth-brand-logo">
            <LogoMark size={30} />
          </span>
          <span className="auth-brand-name">
            TCB <span>Connect</span>
          </span>
        </div>
        <div className="auth-brand-hero">
          <h2>Every customer conversation, one calm workspace.</h2>
          <p>Live chat, visitors, reports and your whole team — together in TCB Connect.</p>
        </div>
        <ul className="auth-brand-points">
          <li>
            <span className="auth-dot" /> Real-time visitor tracking
          </li>
          <li>
            <span className="auth-dot" /> Team roles &amp; smart routing
          </li>
          <li>
            <span className="auth-dot" /> AI assistant while you&apos;re away
          </li>
        </ul>
        <div className="auth-brand-foot">The Custom Boxes — Support Platform</div>
      </aside>

      {/* Right sign-in form */}
      <main className="auth-main">
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-card-logo">
            <LogoMark size={40} />
          </div>
          <h1 className="auth-title">Welcome back</h1>
          <p className="auth-sub">Sign in to your agent dashboard</p>

          {error && <div className="form-error auth-error">{error}</div>}

          <label className="field auth-field">
            <span>Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@thecustomboxes.com"
              autoComplete="email"
              autoFocus
              required
            />
          </label>

          <label className="field auth-field">
            <span>Password</span>
            <div className="auth-pw">
              <input
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                autoComplete="current-password"
                required
              />
              <button
                type="button"
                className="auth-pw-toggle"
                onClick={() => setShowPw((s) => !s)}
                aria-label={showPw ? 'Hide password' : 'Show password'}
                tabIndex={-1}
              >
                {showPw ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </label>

          <button className="btn btn-primary btn-block auth-submit" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>

          <p className="auth-help">Trouble signing in? Ask your admin to reset your password.</p>
        </form>
        <div className="auth-copyright">© {new Date().getFullYear()} The Custom Boxes</div>
      </main>
    </div>
  );
}
