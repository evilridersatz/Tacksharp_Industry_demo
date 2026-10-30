/**
 * Error responses must carry CORS headers, or the browser reports an opaque network failure instead of the real
 * reason (e.g. the video-session limit: 4 per visitor per 10 minutes).
 */
import { describe, expect, it } from 'vitest';
import { Controller, HttpCode, Module, Post, ServiceUnavailableException } from '@nestjs/common';
import request from 'supertest';

process.env.RATE_LIMIT_ASSISTANT_VIDEO_PER_10MIN = '4';
process.env.CORS_ORIGINS = 'https://tacksharp.example';

@Controller('assistant')
class FakeAssistant {
  @Post('video/session')
  @HttpCode(200)
  session() {
    return { sessionToken: 'tok' };
  }
  @Post('fail')
  fail() {
    throw new ServiceUnavailableException('Video is not available');
  }
}
@Module({ controllers: [FakeAssistant] })
class FakeModule {}

describe('CORS on error responses', () => {
  it('429 from the rate limiter and 503 from a route both carry Access-Control-Allow-Origin', async () => {
    const { NestFactory } = await import('@nestjs/core');
    const { configureApp } = await import('../bootstrap.js');
    const app = await NestFactory.create(FakeModule, { logger: false });
    configureApp(app as never);
    await app.init();
    const server = app.getHttpServer();
    const origin = 'https://tacksharp.example';
    for (let i = 0; i < 4; i++) expect((await request(server).post('/assistant/video/session').set('Origin', origin)).status).toBe(200);
    const limited = await request(server).post('/assistant/video/session').set('Origin', origin);
    expect(limited.status).toBe(429);
    expect(limited.headers['access-control-allow-origin']).toBe(origin);
    expect(limited.body.message).toMatch(/Too many requests/);
    const failed = await request(server).post('/assistant/fail').set('Origin', origin);
    expect(failed.status).toBe(503);
    expect(failed.headers['access-control-allow-origin']).toBe(origin);
    await app.close();
  });
});
