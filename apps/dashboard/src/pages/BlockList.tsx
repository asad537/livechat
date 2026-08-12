import React, { useCallback, useEffect, useState } from 'react';
import { api, type BlockRule } from '../api';
import { IconGlobe, IconAlert, IconX } from '../icons';
import { flagEmoji, formatWhen } from '../util';

// Common countries for the picker; any valid ISO-3166 alpha-2 code also works.
const COUNTRIES: { code: string; name: string }[] = [
  { code: 'PK', name: 'Pakistan' }, { code: 'IN', name: 'India' }, { code: 'BD', name: 'Bangladesh' },
  { code: 'US', name: 'United States' }, { code: 'GB', name: 'United Kingdom' }, { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' }, { code: 'DE', name: 'Germany' }, { code: 'FR', name: 'France' },
  { code: 'NL', name: 'Netherlands' }, { code: 'AE', name: 'United Arab Emirates' }, { code: 'SA', name: 'Saudi Arabia' },
  { code: 'CN', name: 'China' }, { code: 'RU', name: 'Russia' }, { code: 'NG', name: 'Nigeria' },
  { code: 'ID', name: 'Indonesia' }, { code: 'PH', name: 'Philippines' }, { code: 'BR', name: 'Brazil' },
  { code: 'ZA', name: 'South Africa' }, { code: 'EG', name: 'Egypt' }, { code: 'TR', name: 'Turkey' },
  { code: 'VN', name: 'Vietnam' }, { code: 'UA', name: 'Ukraine' }, { code: 'IR', name: 'Iran' },
  { code: 'IE', name: 'Ireland' }, { code: 'ES', name: 'Spain' }, { code: 'IT', name: 'Italy' },
  { code: 'MY', name: 'Malaysia' }, { code: 'SG', name: 'Singapore' }, { code: 'NZ', name: 'New Zealand' },
];
const COUNTRY_NAME = new Map(COUNTRIES.map((c) => [c.code, c.name]));
const countryName = (code: string) => COUNTRY_NAME.get(code.toUpperCase()) ?? code.toUpperCase();

export default function BlockList() {
  const [rules, setRules] = useState<BlockRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [ipValue, setIpValue] = useState('');
  const [ipNote, setIpNote] = useState('');
  const [country, setCountry] = useState('');
  const [countryNote, setCountryNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.blocklist();
      setRules(res.rules);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load blocklist');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (type: 'IP' | 'COUNTRY', value: string, note: string) => {
    setError(null);
    if (!value.trim()) return;
    setBusy(true);
    try {
      await api.addBlock(type, value.trim(), note.trim() || undefined);
      if (type === 'IP') {
        setIpValue('');
        setIpNote('');
      } else {
        setCountry('');
        setCountryNote('');
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add rule');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await api.removeBlock(id);
      setRules((rs) => rs.filter((r) => r.id !== id));
    } catch {
      /* transient */
    } finally {
      setBusy(false);
    }
  };

  const ipRules = rules.filter((r) => r.type === 'IP');
  const countryRules = rules.filter((r) => r.type === 'COUNTRY');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Access Blocking</h2>
          <p className="page-sub">
            Block the live chat by country or IP address. Blocked visitors can&apos;t open the widget on any of your websites.
          </p>
        </div>
      </div>

      {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="bl-grid">
        {/* ── Countries ── */}
        <div className="card bl-card">
          <h3 className="bl-card-title">
            <IconGlobe size={16} /> Blocked countries
          </h3>
          <div className="bl-add">
            <input
              list="bl-country-list"
              placeholder="Country or code (e.g. PK)"
              value={country}
              maxLength={40}
              onChange={(e) => setCountry(e.target.value)}
            />
            <datalist id="bl-country-list">
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </datalist>
            <input
              placeholder="Note (optional)"
              value={countryNote}
              maxLength={120}
              onChange={(e) => setCountryNote(e.target.value)}
            />
            <button
              className="btn btn-primary"
              disabled={busy || !country.trim()}
              onClick={() => {
                // Accept either a 2-letter code or a picked country name.
                const match = COUNTRIES.find(
                  (c) => c.name.toLowerCase() === country.trim().toLowerCase(),
                );
                void add('COUNTRY', match ? match.code : country, countryNote);
              }}
            >
              Block
            </button>
          </div>

          {countryRules.length === 0 ? (
            <div className="empty-hint">No countries blocked.</div>
          ) : (
            <ul className="bl-list">
              {countryRules.map((r) => (
                <li key={r.id} className="bl-item">
                  <span className="bl-item-main">
                    <span className="bl-flag">{flagEmoji(r.value)}</span>
                    <span className="bl-item-value">{countryName(r.value)}</span>
                    <span className="bl-item-code">{r.value}</span>
                    {r.note && <span className="bl-item-note">{r.note}</span>}
                  </span>
                  <button className="icon-btn" title="Remove" disabled={busy} onClick={() => void remove(r.id)}>
                    <IconX size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── IP addresses ── */}
        <div className="card bl-card">
          <h3 className="bl-card-title">
            <IconAlert size={16} /> Blocked IP addresses
          </h3>
          <div className="bl-add">
            <input
              placeholder="IP or CIDR (e.g. 203.0.113.5 or 203.0.113.0/24)"
              value={ipValue}
              maxLength={64}
              onChange={(e) => setIpValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && ipValue.trim()) void add('IP', ipValue, ipNote);
              }}
            />
            <input
              placeholder="Note (optional)"
              value={ipNote}
              maxLength={120}
              onChange={(e) => setIpNote(e.target.value)}
            />
            <button
              className="btn btn-primary"
              disabled={busy || !ipValue.trim()}
              onClick={() => void add('IP', ipValue, ipNote)}
            >
              Block
            </button>
          </div>

          {ipRules.length === 0 ? (
            <div className="empty-hint">No IPs blocked.</div>
          ) : (
            <ul className="bl-list">
              {ipRules.map((r) => (
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

      {loading && rules.length === 0 && <div className="empty-hint">Loading…</div>}
    </div>
  );
}
