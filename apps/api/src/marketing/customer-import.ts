/**
 * Validating an uploaded customer list before anything is saved. Column names are matched loosely ("Mobile",
 * "Phone Number", "WhatsApp"); consent is only ever taken from an explicit yes/no column — a list without one
 * imports customers WITHOUT marketing consent (they cannot be messaged until consent is recorded).
 */
import { normalizePhone } from '../common/phone.js';
import type { Table } from './import-file.js';

export type ImportRow = {
  row: number;
  name: string | null;
  phone: string | null;
  email: string | null;
  language: 'tamil' | 'tanglish' | 'english' | null;
  tags: string[];
  marketingConsent: boolean | null;
  callingConsent: boolean | null;
  errors: string[];
};

export type ImportCheck = {
  total: number;
  valid: ImportRow[];
  invalid: ImportRow[];
  duplicatesInFile: number;
  columns: Record<string, string | null>;
  consentColumn: boolean;
};

const COLUMNS: Record<string, string[]> = {
  name: ['name', 'customer name', 'customer', 'full name'],
  phone: ['phone', 'mobile', 'phone number', 'mobile number', 'whatsapp', 'whatsapp number', 'contact', 'number'],
  email: ['email', 'email id', 'e-mail'],
  language: ['language', 'preferred language', 'lang'],
  tags: ['tags', 'tag', 'segment', 'segments', 'group', 'category'],
  marketingConsent: ['marketing consent', 'whatsapp consent', 'whatsapp opt in', 'whatsapp opt-in', 'opt in', 'opt-in', 'consent', 'marketing opt in'],
  callingConsent: ['calling consent', 'call consent', 'voice consent', 'call opt in', 'call opt-in'],
};

const key = (h: string) => h.toLowerCase().replace(/[_\-]+/g, ' ').replace(/\s+/g, ' ').trim();

export function slugTag(t: string): string {
  return t
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function yesNo(v: string | undefined): boolean | null | 'bad' {
  if (v === undefined || v.trim() === '') return null;
  const t = v.trim().toLowerCase();
  if (['yes', 'y', 'true', '1', 'opted in', 'opt in', 'ok', 'agreed'].includes(t)) return true;
  if (['no', 'n', 'false', '0', 'opted out', 'opt out'].includes(t)) return false;
  return 'bad';
}

function language(v: string | undefined): ImportRow['language'] | 'bad' {
  if (!v?.trim()) return null;
  const t = v.trim().toLowerCase();
  if (['tamil', 'ta', 'தமிழ்'].includes(t)) return 'tamil';
  if (['tanglish', 'tamil english', 'mixed'].includes(t)) return 'tanglish';
  if (['english', 'en'].includes(t)) return 'english';
  return 'bad';
}

export function checkImport(table: Table, extraTags: string[] = []): ImportCheck {
  const headers = table.header.map(key);
  const columns: Record<string, string | null> = {};
  const idx: Record<string, number> = {};
  for (const [field, names] of Object.entries(COLUMNS)) {
    const i = headers.findIndex((h) => names.includes(h));
    idx[field] = i;
    columns[field] = i >= 0 ? table.header[i] : null;
  }
  const seen = new Set<string>();
  let duplicatesInFile = 0;
  const valid: ImportRow[] = [];
  const invalid: ImportRow[] = [];
  table.rows.forEach((cells, n) => {
    const get = (f: string) => (idx[f] >= 0 ? cells[idx[f]] : undefined);
    const errors: string[] = [];
    const phone = normalizePhone(get('phone') ?? '') ?? null;
    if (idx.phone < 0) errors.push('no phone column');
    else if (!phone) errors.push(`invalid phone "${(get('phone') ?? '').slice(0, 20)}"`);
    const lang = language(get('language'));
    if (lang === 'bad') errors.push(`unknown language "${get('language')}" (use Tamil / Tanglish / English)`);
    const mc = yesNo(get('marketingConsent'));
    if (mc === 'bad') errors.push(`marketing consent must be yes / no, got "${get('marketingConsent')}"`);
    const cc = yesNo(get('callingConsent'));
    if (cc === 'bad') errors.push(`calling consent must be yes / no, got "${get('callingConsent')}"`);
    const email = (get('email') ?? '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push(`invalid email "${email.slice(0, 40)}"`);
    const tags = [...new Set([...(get('tags') ?? '').split(/[,;|/]/).map(slugTag), ...extraTags.map(slugTag)].filter(Boolean))].slice(0, 12);
    const row: ImportRow = {
      row: n + 2, // 1-based, after the header line
      name: (get('name') ?? '').trim().slice(0, 120) || null,
      phone,
      email: email || null,
      language: lang === 'bad' ? null : lang,
      tags,
      marketingConsent: mc === 'bad' ? null : mc,
      callingConsent: cc === 'bad' ? null : cc,
      errors,
    };
    if (phone && seen.has(phone)) {
      duplicatesInFile++;
      row.errors.push('duplicate phone in this file (first row kept)');
    }
    if (phone) seen.add(phone);
    (row.errors.length ? invalid : valid).push(row);
  });
  return { total: table.rows.length, valid, invalid, duplicatesInFile, columns, consentColumn: idx.marketingConsent >= 0 };
}
