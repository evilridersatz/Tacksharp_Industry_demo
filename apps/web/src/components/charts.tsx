'use client';

import { useId } from 'react';

/** Small area sparkline used on KPI cards. */
export function Sparkline({ values, color, height = 34 }: { values: number[]; color: string; height?: number }) {
  const id = useId();
  const w = 200;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [values.length === 1 ? w / 2 : (i / (values.length - 1)) * w, height - 3 - (v / max) * (height - 8)]);
  if (pts.length === 0) return null;
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="h-[34px] w-full" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${w},${height} L0,${height} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** Two-series trend chart (leads vs AI calls) with gridlines and day labels. */
export function TrendChart({
  labels,
  series,
}: {
  labels: string[];
  series: Array<{ name: string; values: number[]; color: string; dashed?: boolean }>;
}) {
  const id = useId();
  const W = 640;
  const H = 220;
  const pad = { l: 32, r: 12, t: 12, b: 26 };
  const max = Math.max(4, ...series.flatMap((s) => s.values));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const x = (i: number) => pad.l + (labels.length === 1 ? 0.5 : i / (labels.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const every = Math.ceil(labels.length / 8);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[220px] w-full" role="img" aria-label={series.map((s) => s.name).join(' and ') + ' per day'}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={series[0]?.color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={series[0]?.color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3, 4].map((g) => (
        <g key={g}>
          <line x1={pad.l} x2={W - pad.r} y1={y(g * step)} y2={y(g * step)} stroke="#eef1f6" />
          <text x={pad.l - 8} y={y(g * step) + 4} textAnchor="end" className="fill-faint text-[10px]">
            {g * step}
          </text>
        </g>
      ))}
      {labels.map((l, i) =>
        (i % every === 0 && labels.length - 1 - i >= every / 2) || i === labels.length - 1 ? (
          <text key={l + i} x={x(i)} y={H - 6} textAnchor="middle" className="fill-faint text-[10px]">
            {l}
          </text>
        ) : null,
      )}
      {series.map((s, si) => {
        const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
        return (
          <g key={s.name}>
            {si === 0 && <path d={`${d} L${x(s.values.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={`url(#${id})`} />}
            <path d={d} fill="none" stroke={s.color} strokeWidth={s.dashed ? 1.6 : 2.4} strokeDasharray={s.dashed ? '5 5' : undefined} strokeLinejoin="round" />
            {!s.dashed && s.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="3.2" fill="white" stroke={s.color} strokeWidth="2" />)}
          </g>
        );
      })}
    </svg>
  );
}

/** Ring chart with a big centre number, as in the Channel mix card. */
export function Donut({ parts, total, label }: { parts: Array<{ value: number; color: string }>; total: number; label: string }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const sum = parts.reduce((s, p) => s + p.value, 0) || 1;
  let offset = 0;
  return (
    <svg viewBox="0 0 140 140" className="size-[150px]" role="img" aria-label={`${total} ${label}`}>
      <circle cx="70" cy="70" r={r} fill="none" stroke="#eef1f6" strokeWidth="16" />
      {parts.map((p, i) => {
        const len = (p.value / sum) * c;
        const el = (
          <circle
            key={i}
            cx="70"
            cy="70"
            r={r}
            fill="none"
            stroke={p.color}
            strokeWidth="16"
            strokeDasharray={`${Math.max(len - 2, 0)} ${c}`}
            strokeDashoffset={-offset}
            transform="rotate(-90 70 70)"
          />
        );
        offset += len;
        return el;
      })}
      <text x="70" y="70" textAnchor="middle" className="fill-ink text-[24px] font-bold">
        {total}
      </text>
      <text x="70" y="88" textAnchor="middle" className="fill-muted text-[10.5px]">
        {label}
      </text>
    </svg>
  );
}

/** Horizontal bar list: readable at any width (labels never rotate or overlap). */
export function BarList({ labels, values, color, format = (v) => String(v) }: { labels: string[]; values: number[]; color: string; format?: (v: number) => string }) {
  const max = Math.max(...values, 1);
  return (
    <ul className="flex flex-col gap-2.5" role="list">
      {labels.map((l, i) => (
        <li key={l + i} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-[12.5px]">
          <span className="truncate text-body" title={l}>{l}</span>
          <span className="font-semibold text-ink tabular">{format(values[i] ?? 0)}</span>
          <span className="col-span-2 h-2 overflow-hidden rounded-full bg-slate-100">
            <span className="block h-full rounded-full" style={{ width: `${Math.max(2, ((values[i] ?? 0) / max) * 100)}%`, background: color }} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Funnel: each stage as a bar with its share of the first stage. */
export function Funnel({ labels, values, color }: { labels: string[]; values: number[]; color: string }) {
  const first = values[0] || 0;
  return (
    <ol className="flex flex-col gap-2">
      {labels.map((l, i) => {
        const v = values[i] ?? 0;
        const share = first ? Math.round((v / first) * 100) : 0;
        return (
          <li key={l + i}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-[12.5px]">
              <span className="truncate text-body">{l}</span>
              <span className="shrink-0 font-semibold text-ink tabular">
                {v} {i > 0 && <span className="font-normal text-muted">· {share}%</span>}
              </span>
            </div>
            <div className="h-6 overflow-hidden rounded-[8px] bg-slate-100">
              <div className="h-full rounded-[8px]" style={{ width: `${first ? Math.max(3, (v / first) * 100) : 0}%`, background: color, opacity: 1 - i * (0.5 / Math.max(1, labels.length - 1)) }} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
