'use client';

/**
 * “Live · updated 1:20:15 am”: shows that the numbers on the page come from the server just now. Pages refresh on
 * every live event from the server (new order, call, message, agent step) and on a timer as a backstop.
 */
export function LiveStamp({ at, every }: { at: Date | null | undefined; every?: string }) {
  if (!at) return null;
  return (
    <p className="mb-3 -mt-1 flex items-center gap-1.5 text-[11.5px] text-muted" aria-live="polite">
      <span className="relative flex size-2" aria-hidden>
        <span className="absolute inline-flex size-full rounded-full bg-emerald-400 opacity-60 motion-safe:animate-ping" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
      </span>
      Live · real data · updated {at.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}
      {every ? <span className="text-faint">· {every}</span> : null}
    </p>
  );
}
