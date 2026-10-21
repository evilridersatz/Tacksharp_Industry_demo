import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';

/** Shared helpers for the food, hotel and hospital modules. All dates are interpreted in IST. */
export const IST_MS = 330 * 60_000;
export const DAY_MS = 86_400_000;
export const money = (v: number) => Math.round(v * 100) / 100;
export const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Short human reference, e.g. HB-7K2Q9X (no 0/O/1/I to avoid misreading). */
export function reference(prefix: string) {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}-${s}`;
}

/** "YYYY-MM-DD" of a moment in IST. */
export function istDay(d: Date) {
  return new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
}
/** A calendar date ("YYYY-MM-DD") as a UTC-midnight Date (how Prisma @db.Date values are stored). */
export function dateOnly(day: string) {
  return new Date(`${day}T00:00:00.000Z`);
}
export function addDays(day: string, k: number) {
  return new Date(dateOnly(day).getTime() + k * DAY_MS).toISOString().slice(0, 10);
}
export function daysBetween(a: string, b: string) {
  return Math.round((dateOnly(b).getTime() - dateOnly(a).getTime()) / DAY_MS);
}
export const isDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(dateOnly(v).getTime());
/** IST wall-clock "HH:mm" on a day -> UTC instant. */
export function istInstant(day: string, hhmm: string) {
  return new Date(dateOnly(day).getTime() + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) * 60_000 - IST_MS);
}
export function istTime(d: Date) {
  return new Date(d.getTime() + IST_MS).toISOString().slice(11, 16);
}
export function prettyDay(day: string) {
  return dateOnly(day).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
export function prettyTime(d: Date) {
  return d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
}
export const inr = (v: number) => `₹${money(v).toLocaleString('en-IN', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

/** Durable per-conversation state for the vertical assistants (one row per key). */
@Injectable()
export class AgentSessionStore {
  constructor(private readonly prisma: PrismaService) {}

  async get<T>(key: string): Promise<T | undefined> {
    const row = await this.prisma.agentSession.findUnique({ where: { id: key } });
    return row ? (row.data as T) : undefined;
  }

  async set(key: string, organizationId: string, kind: string, data: unknown) {
    await this.prisma.agentSession.upsert({
      where: { id: key },
      create: { id: key, organizationId, kind, data: data as never },
      update: { data: data as never },
    });
  }

  async clear(key: string) {
    await this.prisma.agentSession.deleteMany({ where: { id: key } });
  }
}
