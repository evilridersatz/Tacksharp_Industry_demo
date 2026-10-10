import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { config, productionProblems, productionWarnings } from './common/config.js';
import { log } from './common/logger.js';
import { configureApp } from './bootstrap.js';

async function bootstrap() {
  const problems = productionProblems();
  if (problems.length) {
    log.error('startup.unsafe_config', { problems });
    console.error(`\nRefusing to start in production:\n - ${problems.join('\n - ')}\n`);
    process.exit(1);
  }

  for (const warning of productionWarnings()) log.warn('startup.config_warning', { warning });

  // rawBody is needed to verify Meta webhook signatures.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  configureApp(app);
  await app.listen(config.port);
  log.info('api.started', { port: config.port, publicBaseUrl: config.publicBaseUrl, workers: config.runWorkers, production: config.isProduction });

  // Graceful shutdown safety net: if closing hangs (e.g. a stuck job), exit after 25 s.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info('api.stopping', { signal });
      setTimeout(() => {
        log.error('api.forced_exit', { signal });
        process.exit(1);
      }, 25_000).unref();
    });
  }
}

void bootstrap();
