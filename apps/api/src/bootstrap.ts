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
  app.use(createRateLimiter());
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:3001').split(','),
    credentials: true,
  });
  app.enableShutdownHooks();
  return app;
}
