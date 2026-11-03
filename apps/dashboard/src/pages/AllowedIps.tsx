import React, { useCallback, useEffect, useState } from 'react';
import { api, type AllowedIp } from '../api';
import { IconCheck, IconX } from '../icons';
import { formatWhen } from '../util';

/** Admin → Allowed IPs: networks (office, VPN) every IP-locked CSR / Team Lead
 *  may sign in from, on top of the IPs set on their own account. */
export default function AllowedIps() {
  const [ips, setIps] = useState<AllowedIp[]>([]);
  const [yourIp, setYourIp] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.allowedIps();
      setIps(res.ips);
      setYourIp(res.yourIp);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load allowed IPs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (v: string) => {
    setError(null);
    if (!v.trim()) return;
    setBusy(true);
    try {
      await api.addAllowedIp(v.trim(), note.trim() || undefined);
      setValue('');
      setNote('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add IP');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await api.removeAllowedIp(id);
      setIps((list) => list.filter((r) => r.id !== id));
    } catch {
      /* transient */
    } finally {
      setBusy(false);
    }
  };

  const alreadyListed = yourIp && ips.some((r) => r.value === yourIp);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Allowed IPs</h2>
          <p className="page-sub">
            Networks every agent may sign in from. A CSR or Team Lead whose account is locked to specific
            IPs can also log in from any address listed here — add the office or VPN once instead of on
            every account. Accounts without an IP lock are not affected.
          </p>
        </div>
      </div>

      {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="bl-grid">
        <div className="card bl-card">
          <h3 className="bl-card-title">
            <IconCheck size={16} /> Allowed IP addresses
          </h3>
          <div className="bl-add">
            <input
              placeholder="IP or CIDR (e.g. 203.0.113.5 or 203.0.113.0/24)"
              value={value}
              maxLength={64}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && value.trim()) void add(value);
              }}
            />
            <input
              placeholder="Note (e.g. Lahore office)"
              value={note}
              maxLength={120}
              onChange={(e) => setNote(e.target.value)}
            />
            <button className="btn btn-primary" disabled={busy || !value.trim()} onClick={() => void add(value)}>
              Allow
            </button>
          </div>
          {yourIp && (
            <div className="empty-hint" style={{ marginBottom: 8 }}>
              You are connecting from <span className="bl-mono">{yourIp}</span>
              {alreadyListed ? ' — already allowed.' : ' — '}
              {!alreadyListed && (
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void add(yourIp)}>
                  Allow this IP
                </button>
              )}
            </div>
          )}

          {ips.length === 0 ? (
            <div className="empty-hint">No IPs allowed yet. Agents can only use the IPs on their own account.</div>
          ) : (
            <ul className="bl-list">
              {ips.map((r) => (
                <li key={r.id} className="bl-item">
                  <span className="bl-item-main">
                    <span className="bl-item-value bl-mono">{r.value}</span>
                    {r.note && <span className="bl-item-note">{r.note}</span>}
                    <span className="bl-item-when">{formatWhen(r.createdAt)}</span>
                  </span>
                  <button className="icon-btn" title="Remove" disabled={busy} onClick={() => void remove(r.id)}>
                    <IconX size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {loading && ips.length === 0 && <div className="empty-hint">Loading…</div>}
    </div>
  );
}
