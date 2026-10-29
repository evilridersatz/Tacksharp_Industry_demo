'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Menu, X } from 'lucide-react';
import { cx } from './ui';

/** Public website palette (see the site design notes in ENTERPRISE.md). */
export const SITE = { ink: '#16183d', green: '#0f9f6e', paper: '#fbfcfe', mist: '#ebeaf6', marigold: '#f2a516' };

const NAV = [
  { href: '/product', label: 'Product' },
  { href: '/solutions', label: 'Industries' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/docs', label: 'Getting started' },
  { href: '/demo', label: 'Demos' },
];

export function Mark({ light }: { light?: boolean }) {
  return (
    <Link href="/welcome" className="flex items-center gap-2.5 rounded-[8px]" aria-label="Tacksharp.ai home">
      <span className="grid size-8 place-items-center rounded-full bg-[conic-gradient(from_200deg,#7c5cf0,#e11d48,#f2a516,#0f9f6e,#7c5cf0)]">
        <span className={cx('size-3 rounded-full border-[3px] border-white', light ? 'bg-[#16183d]' : 'bg-[#16183d]')} />
      </span>
      <span className={cx('text-[17px] font-extrabold tracking-[-0.02em]', light ? 'text-white' : 'text-[#16183d]')}>Tacksharp.ai</span>
    </Link>
  );
}

function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <header className="sticky top-0 z-40 border-b border-[#16183d]/8 bg-[#fbfcfe]/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-6 px-4 sm:px-6">
        <Mark />
        <nav aria-label="Main" className="hidden flex-1 items-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={pathname === n.href ? 'page' : undefined} className={cx('rounded-[8px] px-3 py-2 text-[14px] font-medium hover:bg-[#ebeaf6]', pathname === n.href ? 'text-[#16183d]' : 'text-[#16183d]/70')}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto hidden items-center gap-2 md:flex">
          <Link href="/login" className="rounded-[8px] px-3 py-2 text-[14px] font-semibold text-[#16183d] hover:bg-[#ebeaf6]">Log in</Link>
          <Link href="/signup" className="rounded-[10px] bg-[#16183d] px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-[#262a63]">Create an account</Link>
        </div>
        <button className="ml-auto grid size-11 place-items-center rounded-[10px] md:hidden" aria-label={open ? 'Close menu' : 'Open menu'} aria-expanded={open} aria-controls="site-menu" onClick={() => setOpen(!open)}>
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>
      {open && (
        <nav id="site-menu" aria-label="Main" className="border-t border-[#16183d]/8 bg-[#fbfcfe] px-4 pb-4 md:hidden">
          {NAV.map((n) => <Link key={n.href} href={n.href} className="block rounded-[8px] px-2 py-3 text-[15px] font-medium text-[#16183d]">{n.label}</Link>)}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Link href="/login" className="rounded-[10px] border border-[#16183d]/15 px-3 py-3 text-center text-[14px] font-semibold text-[#16183d]">Log in</Link>
            <Link href="/signup" className="rounded-[10px] bg-[#16183d] px-3 py-3 text-center text-[14px] font-semibold text-white">Create an account</Link>
          </div>
        </nav>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer className="bg-[#16183d] text-white/75">
      <div className="mx-auto grid max-w-[1200px] gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          <Mark light />
          <p className="mt-3 max-w-xs text-[13.5px] leading-relaxed">AI employees for WhatsApp, phone and operations, built in Chennai for businesses that talk to customers in Tamil and English.</p>
          <p className="mt-4 text-[12.5px] text-white/55">Tacksharp AI Private Limited<br />53 B, SPE Monocity, Parivakkam, Poonamallee, Chennai 600056</p>
        </div>
        <FooterCol title="Product" links={[['/product', 'How it works'], ['/solutions', 'Industries'], ['/pricing', 'Pricing'], ['/demo', 'Demos']]} />
        <FooterCol title="Start" links={[['/signup', 'Create an account'], ['/login', 'Log in'], ['/docs', 'Getting started'], ['/forgot-password', 'Password help']]} />
        <FooterCol title="Legal" links={[['/privacy', 'Privacy policy'], ['/terms', 'Terms of service']]} />
      </div>
      <p className="border-t border-white/10 py-5 text-center text-[12px] text-white/45">© {new Date().getFullYear()} Tacksharp AI Private Limited</p>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: Array<[string, string]> }) {
  return (
    <div>
      <h2 className="text-[13px] font-semibold text-white">{title}</h2>
      <ul className="mt-3 grid gap-2 text-[13.5px]">
        {links.map(([href, label]) => <li key={href}><Link href={href} className="rounded-[4px] hover:text-white">{label}</Link></li>)}
      </ul>
    </div>
  );
}

/** Layout for every public page: header, content, footer. */
export function SitePage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-[#fbfcfe] text-[#16183d]">
      <a href="#content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-[8px] focus:bg-white focus:px-3 focus:py-2">Skip to content</a>
      <Header />
      <main id="content">{children}</main>
      <Footer />
    </div>
  );
}

/** A page title block for inner pages. */
export function SiteHero({ title, lead, children }: { title: string; lead: string; children?: ReactNode }) {
  return (
    <section className="border-b border-[#16183d]/8 bg-[#ebeaf6]/60">
      <div className="mx-auto max-w-[1200px] px-4 py-14 sm:px-6 sm:py-20">
        <h1 className="max-w-3xl text-[34px] leading-[1.05] font-extrabold tracking-[-0.035em] sm:text-[52px]">{title}</h1>
        <p className="mt-4 max-w-2xl text-[17px] leading-relaxed text-[#16183d]/70">{lead}</p>
        {children}
      </div>
    </section>
  );
}

export function Prose({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-[760px] px-4 py-12 text-[15.5px] leading-[1.75] text-[#16183d]/85 sm:px-6 [&_h2]:mt-10 [&_h2]:mb-2 [&_h2]:text-[21px] [&_h2]:font-bold [&_h2]:tracking-[-0.01em] [&_h2]:text-[#16183d] [&_li]:ml-5 [&_li]:list-disc [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:grid [&_ul]:gap-1.5">{children}</div>;
}
