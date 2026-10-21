'use client';

import Link from 'next/link';
import type { ComponentProps, ReactNode } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { initials, type Tone } from '@/lib/format';

export type { Tone };

export function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export function Card({ className, children, ...rest }: ComponentProps<'section'>) {
  return (
    <section
      className={cx('rounded-[var(--radius-card)] border border-line bg-white shadow-[var(--shadow-card)]', className)}
      {...rest}
    >
      {children}
    </section>
  );
}

export function CardHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {subtitle && <p className="mt-0.5 text-[12.5px] text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

const TONES: Record<Tone, string> = {
  brand: 'bg-brand-soft text-brand-dark',
  violet: 'bg-violet-soft text-violet',
  amber: 'bg-amber-soft text-[#b45309]',
  sky: 'bg-sky-soft text-[#0369a1]',
  rose: 'bg-rose-soft text-rose',
  slate: 'bg-slate-100 text-slate-600',
};

export function Badge({ tone = 'slate', children, dot, className }: { tone?: Tone; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold', TONES[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function IconTile({ tone = 'brand', children, size = 'md' }: { tone?: Tone; children: ReactNode; size?: 'sm' | 'md' }) {
  return (
    <span className={cx('grid shrink-0 place-items-center rounded-[10px]', TONES[tone], size === 'md' ? 'size-9' : 'size-7')}>
      {children}
    </span>
  );
}

const AVATAR_TONES: Tone[] = ['brand', 'violet', 'amber', 'sky', 'rose'];

export function Avatar({ person, size = 36 }: { person: { name?: string | null; phone?: string | null } | null | undefined; size?: number }) {
  const key = (person?.name ?? person?.phone ?? '#').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const tone = AVATAR_TONES[key % AVATAR_TONES.length];
  return (
    <span
      className={cx('grid shrink-0 place-items-center rounded-full font-semibold', TONES[tone])}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-hidden
    >
      {initials(person)}
    </span>
  );
}

type ButtonProps = ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean; href?: string };

const BUTTONS = {
  primary: 'bg-brand text-white shadow-sm hover:bg-brand-dark',
  secondary: 'border border-line bg-white text-ink hover:bg-slate-50',
  ghost: 'text-muted hover:bg-slate-100 hover:text-ink',
  danger: 'border border-rose-soft bg-white text-rose hover:bg-rose-soft',
};

export function Button({ variant = 'secondary', busy, className, children, href, disabled, ...rest }: ButtonProps) {
  const classes = cx(
    'inline-flex h-9 items-center justify-center gap-1.5 rounded-[10px] px-3.5 text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    BUTTONS[variant],
    className,
  );
  if (href) {
    const external = href.startsWith('http') || href.startsWith('tel:');
    return external ? (
      <a href={href} className={classes} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer">
        {children}
      </a>
    ) : (
      <Link href={href} className={classes}>
        {children}
      </Link>
    );
  }
  return (
    <button className={classes} disabled={disabled || busy} {...rest}>
      {busy && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  );
}

/** Pill-style switch used for Week / Month / Year and Board / List in the design. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: ReactNode }>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex max-w-full overflow-x-auto rounded-[10px] bg-slate-100 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[8px] px-3 text-[12.5px] font-semibold whitespace-nowrap sm:h-7',
            value === o.value ? 'bg-white text-ink shadow-sm' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Delta({ now, before }: { now: number; before: number }) {
  if (!before && !now) return null;
  const change = before ? Math.round(((now - before) / before) * 100) : 100;
  const up = change >= 0;
  return (
    <span className={cx('inline-flex items-center rounded-full px-1.5 py-0.5 text-[11.5px] font-bold', up ? 'bg-brand-soft text-brand-dark' : 'bg-rose-soft text-rose')}>
      {up ? '▲' : '▼'} {Math.abs(change)}%
    </span>
  );
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-3 rounded-[12px] border border-rose-soft bg-white px-4 py-3 text-[13px] text-ink">
      <AlertTriangle className="size-4 shrink-0 text-rose" />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry} className="h-8">
          Try again
        </Button>
      )}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {icon && <div className="mb-3 text-faint">{icon}</div>}
      <p className="text-[14px] font-semibold text-ink">{title}</p>
      {children && <div className="mt-1 max-w-sm text-[13px] text-muted">{children}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('animate-pulse rounded-md bg-slate-100', className)} />;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[13px]">
      <span className="shrink-0 whitespace-nowrap text-muted">{label}</span>
      <span className="text-right font-semibold text-ink">{children}</span>
    </div>
  );
}
