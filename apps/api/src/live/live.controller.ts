import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Org } from '../auth/decorators.js';
import { onLive } from '../common/live-events.js';

/**
 * GET /live/events: Server-Sent Events for the logged-in user's organization. The dashboard keeps one open and
 * reloads what it shows the moment an order, cart, message or call changes, from any channel (WhatsApp, phone,
 * dashboard assistant). Only that organization's events; a comment ping every 20 s keeps proxies from closing it.
 */
@Controller('live')
export class LiveController {
  @Get('events')
  events(@Org() organizationId: string, @Req() req: Request, @Res() res: Response) {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: do not buffer the stream
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    const off = onLive(organizationId, (e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    const close = () => { clearInterval(ping); off(); };
    req.on('close', close);
    res.on('error', close);
  }
}
