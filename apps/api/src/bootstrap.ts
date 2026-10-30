import type { NestExpressApplication } from '@nestjs/platform-express';
import { createRateLimiter } from './common/rate-limit.js';

/**
 * HTTP setup shared by production (main.ts) and the live test harness,
 * so tests always exercise exactly what production runs.
 */
export function configureApp(app: NestExpressApplication) {
  // Behind Nginx (and Cloudflare): use X-Forwarded-For for the client IP (rate limiting, logs).
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
  app.disable('x-powered-by');
  // CORS first: every response, including a 429 from the rate limiter and other errors, carries the CORS headers, so
  // the browser can read the error (e.g. "too many video sessions") instead of reporting an opaque network failure.
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3001').split(','),
    credentials: true,
  });
  app.use(createRateLimiter());
  // Voice uploads (assistant speech-to-text, Sarvam recognition tests) send up to ~2 MB of base64 WAV. Still bounded;
  // every route validates its own sizes. (rawBody for webhook signatures is kept by Nest's body parser.)
  app.useBodyParser('json', { limit: '3mb' });
  app.enableShutdownHooks();
  return app;
}
