import React from 'react';
import type { ReportsOverview } from '../api';
import { formatSeconds } from '../util';

export const hourLabel = (h: number): string => {
  const ampm = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh} ${ampm}`;
};

export const dayLabel = (day: string): string =>
  new Date(`${day}T00:00:00`).toLocaleDateString([], { weekday: 'short' }).slice(0, 2);

export const dayFull = (day: string): string =>
  new Date(`${day}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });

// Outcome donut — fixed categorical order and colors.
export const OUTCOME_META = [
  { key: 'resolved', label: 'Resolved', color: '#7c3aed' },
  { key: 'transferred', label: 'Transferred', color: '#0ea5e9' },
  { key: 'open', label: 'Still open', color: '#f59e0b' },
  { key: 'missed', label: 'Missed', color: '#ef4444' },
] as const;

/** Two-series line chart (SVG) for the 14-day response trend. */
export function TrendLines({ detail }: { detail: NonNullable<ReportsOverview['trendDetail']> }) {
  const W = 320;
  const H = 130;
  const PAD = 8;
  const frt = detail.map((d) => d.frtSeconds ?? null);
  const dur = detail.map((d) => d.durationSeconds ?? null);
  const max = Math.max(
    60,
    ...frt.filter((v): v is number => v != null),
    ...dur.filter((v): v is number => v != null),
  );
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / Math.max(1, detail.length - 1);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const path = (vals: (number | null)[]) =>
    vals
      .map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
      .filter(Boolean)
      .join(' ');
  const hasAny = frt.some((v) => v != null) || dur.some((v) => v != null);
  if (!hasAny) return <p className="rp-empty">No response data yet.</p>;
  return (
    <>
      <div className="rp-legend">
        <span>
          <i className="rp-swatch" style={{ background: '#7c3aed' }} /> Avg first response
        </span>
        <span>
          <i className="rp-swatch" style={{ background: '#0ea5e9' }} /> Avg chat duration
        </span>
        <span className="rp-legend-max">peak {formatSeconds(max)}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="rp-lines" preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={PAD}
            x2={W - PAD}
            y1={PAD + f * (H - PAD * 2)}
            y2={PAD + f * (H - PAD * 2)}
            stroke="#e2e8f0"
            strokeWidth="1"
            strokeDasharray="3 4"
          />
        ))}
        <polyline points={path(frt)} fill="none" stroke="#7c3aed" strokeWidth="2" strokeLinejoin="round" />
        <polyline points={path(dur)} fill="none" stroke="#0ea5e9" strokeWidth="2" strokeLinejoin="round" />
        {detail.map((d, i) =>
          d.frtSeconds != null ? (
            <circle key={`f${i}`} cx={x(i)} cy={y(d.frtSeconds)} r="2.6" fill="#7c3aed">
              <title>{`${dayFull(d.day)} — first response ${formatSeconds(d.frtSeconds)}`}</title>
            </circle>
          ) : null,
        )}
        {detail.map((d, i) =>
          d.durationSeconds != null ? (
            <circle key={`d${i}`} cx={x(i)} cy={y(d.durationSeconds)} r="2.6" fill="#0ea5e9">
              <title>{`${dayFull(d.day)} — duration ${formatSeconds(d.durationSeconds)}`}</title>
            </circle>
          ) : null,
        )}
      </svg>
      <div className="rp-lines-x">
        <span>{dayFull(detail[0].day)}</span>
        <span>{dayFull(detail[Math.floor(detail.length / 2)].day)}</span>
        <span>{dayFull(detail[detail.length - 1].day)}</span>
      </div>
    </>
  );
}

/** Donut chart via SVG stroke arcs — generic segments. */
export function Donut({
  segments,
  centerLabel,
  centerSub,
}: {
  segments: { label: string; value: number; color: string }[];
  centerLabel: string;
  centerSub: string;
}) {
  const total = segments.reduce((s, m) => s + m.value, 0);
  if (total === 0) return <p className="rp-empty">No data in this period.</p>;
  const R = 44;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="rp-donut-row">
      <svg viewBox="0 0 120 120" className="rp-donut">
        {segments.map((m) => {
          const frac = m.value / total;
          const seg = (
            <circle
              key={m.label}
              cx="60"
              cy="60"
              r={R}
              fill="none"
              stroke={m.color}
              strokeWidth="14"
              strokeDasharray={`${Math.max(0, frac * C - 2)} ${C}`}
              strokeDashoffset={-offset * C}
              transform="rotate(-90 60 60)"
              strokeLinecap="butt"
            >
              <title>{`${m.label}: ${m.value}`}</title>
            </circle>
          );
          offset += frac;
          return seg;
        })}
        <text x="60" y="57" textAnchor="middle" className="rp-donut-total">
          {centerLabel}
        </text>
        <text x="60" y="73" textAnchor="middle" className="rp-donut-sub">
          {centerSub}
        </text>
      </svg>
      <div className="rp-donut-legend">
        {segments.map((m) => (
          <div key={m.label} className="rp-donut-item">
            <i className="rp-swatch" style={{ background: m.color }} />
            <span className="rp-donut-label">{m.label}</span>
            <span className="rp-donut-val">
              {Math.round((m.value / total) * 100)}% ({m.value})
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OutcomeDonut({ outcomes }: { outcomes: NonNullable<ReportsOverview['outcomes']> }) {
  const total = OUTCOME_META.reduce((s, m) => s + outcomes[m.key], 0);
  return (
    <Donut
      segments={OUTCOME_META.map((m) => ({ label: m.label, value: outcomes[m.key], color: m.color }))}
      centerLabel={String(total)}
      centerSub="Total chats"
    />
  );
}

/** Area + line chart for chats-over-time (14 days). */
export function AreaChart({ trend }: { trend: { day: string; count: number }[] }) {
  const W = 640;
  const H = 170;
  const PAD = 10;
  if (trend.length === 0) return <p className="rp-empty">No data yet.</p>;
  const max = Math.max(1, ...trend.map((t) => t.count));
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / Math.max(1, trend.length - 1);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);
  const pts = trend.map((t, i) => `${x(i).toFixed(1)},${y(t.count).toFixed(1)}`).join(' ');
  const area = `${PAD},${H - PAD} ${pts} ${(W - PAD).toFixed(1)},${H - PAD}`;
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="db-area" preserveAspectRatio="none">
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={PAD}
            x2={W - PAD}
            y1={PAD + f * (H - PAD * 2)}
            y2={PAD + f * (H - PAD * 2)}
            stroke="#e2e8f0"
            strokeWidth="1"
            strokeDasharray="3 4"
          />
        ))}
        <polygon points={area} fill="rgba(124, 58, 237, 0.09)" />
        <polyline points={pts} fill="none" stroke="#7c3aed" strokeWidth="2.2" strokeLinejoin="round" />
        {trend.map((t, i) => (
          <circle key={t.day} cx={x(i)} cy={y(t.count)} r="3" fill="#7c3aed">
            <title>{`${dayFull(t.day)} — ${t.count} chat${t.count === 1 ? '' : 's'}`}</title>
          </circle>
        ))}
      </svg>
      <div className="rp-lines-x">
        <span>{dayFull(trend[0].day)}</span>
        <span>{dayFull(trend[Math.floor(trend.length / 2)].day)}</span>
        <span>{dayFull(trend[trend.length - 1].day)}</span>
      </div>
    </>
  );
}
