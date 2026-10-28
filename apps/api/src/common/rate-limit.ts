import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { log } from './logger.js';

type Bucket = { count: number; resetAt: number };

/**
 * Small in-memory fixed-window rate limiter (single server).
 * - login: brute-force protection
 * - webhooks (Meta / Plivo): generous, they burst
 * - everything else: per-IP API limit
 */
export function createRateLimiter(now: () => number = Date.now) {
  const buckets = new Map<string, Bucket>();
  const sweep = setInterval(() => {
    const t = now();
    for (const [k, b] of buckets) if (b.resetAt < t) buckets.delete(k);
  }, 60_000);
  sweep.unref();

  function rule(path: string): { name: string; limit: number; windowMs: number } {
    if (path.startsWith('/auth/login') || path.startsWith('/team/links/')) return { name: 'login', limit: config.rateLimit.loginPerWindow, windowMs: 5 * 60_000 };
    if (path.startsWith('/webhooks/') || /^\/voice\/(answer|inbound|turn|hangup|audio\/|ready\/|feedback\/)/.test(path)) {
      return { name: 'webhook', limit: config.rateLimit.webhookPerMinute, windowMs: 60_000 };
    }
    // Website → offer API (key-protected, still limited per IP).
    // VisionOps site agents: token-authenticated heartbeats / event batches (an offline queue may flush in bursts).
    if (path.startsWith('/monitoring/agent/')) return { name: 'monitoring_agent', limit: 120, windowMs: 60_000 };
    if (path.startsWith('/public/')) return { name: 'public_api', limit: config.rateLimit.publicApiPerMinute, windowMs: 60_000 };
    if (path === '/health') return { name: 'health', limit: 120, windowMs: 60_000 };
    return { name: 'api', limit: config.rateLimit.apiPerMinute, windowMs: 60_000 };
  }

  return function rateLimit(req: Request, res: Response, next: NextFunction) {
    const r = rule(req.path);
    const key = `${r.name}:${req.ip}`;
    const t = now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + r.windowMs };
      buckets.set(key, b);
    }
    b.count++;
    res.setHeader('RateLimit-Limit', r.limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, r.limit - b.count));
    if (b.count > r.limit) {
      res.setHeader('Retry-After', Math.ceil((b.resetAt - t) / 1000));
      if (b.count === r.limit + 1) log.warn('ratelimit.blocked', { rule: r.name, ip: req.ip, path: req.path });
      res.status(429).json({ statusCode: 429, message: 'Too many requests. Please wait and try again.' });
      return;
    }
    next();
  };
}
