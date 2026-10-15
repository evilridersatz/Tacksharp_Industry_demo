'use client';

import type { ReactNode } from 'react';
import { MessageSquare } from 'lucide-react';
import type { Call, Message } from '@/lib/types';
import { dayLabel, timeOnly } from '@/lib/format';
import { Empty, cx } from './ui';

/** Only Meta's delivery receipts say delivered / read; "accepted" means WhatsApp took the request. */
const DELIVERY: Record<string, { label: string; bad?: boolean }> = {
  accepted: { label: 'sent to WhatsApp' },
  sent: { label: 'sent' },
  delivered: { label: 'delivered' },
  read: { label: 'read' },
  failed: { label: 'not delivered', bad: true },
  unknown: { label: 'delivery unknown', bad: true },
};

export function Thread({ messages, name }: { messages: Message[]; name: string }) {
  if (messages.length === 0) {
    return <Empty icon={<MessageSquare className="size-6" />} title="No WhatsApp messages yet">The thread appears here once {name} replies or the AI sends a message.</Empty>;
  }
  let lastDay = '';
  return (
    <div className="flex flex-col gap-2 rounded-[12px] bg-[#f6f8fb] p-4">
      {messages.map((m) => {
        const day = dayLabel(m.createdAt);
        const showDay = day !== lastDay;
        lastDay = day;
        const mine = m.role !== 'user';
        const template = m.content.startsWith('[template:');
        return (
          <div key={m.id}>
            {showDay && <p className="mx-auto my-2 w-fit rounded-full bg-white px-2.5 py-0.5 text-[11px] font-semibold text-muted shadow-sm">{day}</p>}
            <div className={cx('flex flex-col', mine ? 'items-end' : 'items-start')}>
              <p
                className={cx(
                  'max-w-[78%] rounded-[14px] px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap',
                  mine ? 'rounded-br-[4px] bg-brand text-white' : 'rounded-bl-[4px] bg-white text-ink shadow-sm',
                )}
              >
                {template ? `Template message sent (${m.content.slice(10, m.content.indexOf(']'))})` : m.content}
              </p>
              <span className="mt-0.5 text-[11px] text-faint">
                {mine ? 'AI · ' : ''}
                {timeOnly(m.createdAt)}
                {mine && m.deliveryStatus && DELIVERY[m.deliveryStatus] && (
                  <span className={cx('ml-1', DELIVERY[m.deliveryStatus].bad && 'font-semibold text-rose')}> · {DELIVERY[m.deliveryStatus].label}</span>
                )}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Transcript lines for one call: the voice messages saved between dialing and hang-up. */
export function transcriptFor(call: Call, voice: Message[]) {
  const start = new Date(call.createdAt).getTime();
  const end = call.endedAt ? new Date(call.endedAt).getTime() + 5000 : Infinity;
  return voice.filter((m) => {
    const t = new Date(m.createdAt).getTime();
    const id = (m.metadata as { callId?: unknown } | null | undefined)?.callId;
    if (typeof id === 'string') return id === call.id;
    return t >= start && t <= end;
  });
}

type TurnMeta = {
  path?: string;
  intent?: string;
  language?: string;
  languageChanged?: boolean;
  llmFallbackReason?: string;
  aiRequests?: number;
  ms?: number;
  booking?: string;
  deduped?: boolean;
  failed?: boolean;
};

const LANG: Record<string, string> = { ta: 'Tamil', tamil: 'Tamil', tanglish: 'Tanglish', en: 'English', english: 'English', mixed: 'Mixed' };
const REASON: Record<string, string> = {
  UNKNOWN_QUESTION: 'unknown question',
  FREE_FORM_PROPERTY_QUESTION: 'property question',
  AMBIGUOUS_INTENT: 'unclear intent',
  CONFIRMATION_SIDE_QUESTION: 'side question at confirmation',
  QUALIFICATION_FREE_FORM: 'free-form answer',
};

function Chip({ tone = 'muted', title, children }: { tone?: 'muted' | 'violet' | 'amber' | 'green' | 'red'; title?: string; children: ReactNode }) {
  const tones = {
    muted: 'bg-[#eef1f5] text-muted',
    violet: 'bg-violet-soft text-violet',
    amber: 'bg-amber-soft text-[#b45309]',
    green: 'bg-[#e7f6ee] text-[#15803d]',
    red: 'bg-[#fdecec] text-[#b91c1c]',
  } as const;
  return (
    <span title={title} className={cx('rounded-full px-2 py-px text-[10.5px] font-semibold', tones[tone])}>
      {children}
    </span>
  );
}

/** How the AI produced this reply: rules or model, why the model was needed, language, speed, booking result. */
export function TurnBadges({ meta }: { meta: TurnMeta | null | undefined }) {
  if (!meta || (!meta.path && !meta.intent)) return null;
  const llm = meta.path === 'llm';
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {meta.path && (
        <Chip tone={llm ? 'amber' : 'violet'} title={llm ? 'Answered by the language model' : 'Answered by the deterministic rules, no model call'}>
          {llm ? `AI model${meta.aiRequests ? ` ×${meta.aiRequests}` : ''}` : 'Rules'}
        </Chip>
      )}
      {llm && meta.llmFallbackReason && <Chip tone="amber" title="Why the rules handed this turn to the model">{REASON[meta.llmFallbackReason] ?? meta.llmFallbackReason}</Chip>}
      {meta.intent && meta.intent !== 'UNKNOWN' && <Chip title="What the customer meant">{meta.intent.toLowerCase().replace(/_/g, ' ')}</Chip>}
      {meta.language && (
        <Chip title={meta.languageChanged ? 'Customer switched language on this turn' : 'Reply language'}>
          {LANG[meta.language] ?? meta.language}
          {meta.languageChanged ? ' · switched' : ''}
        </Chip>
      )}
      {typeof meta.ms === 'number' && <Chip tone={meta.ms > 2500 ? 'red' : 'muted'} title="Time to produce the reply text (speech synthesis not included)">{(meta.ms / 1000).toFixed(1)} s</Chip>}
      {meta.deduped && <Chip title="The same question was about to be repeated, so the AI moved on">no repeat</Chip>}
      {meta.booking === 'booked' && <Chip tone="green">visit booked</Chip>}
      {meta.booking === 'duplicate' && <Chip tone="green">visit already booked</Chip>}
      {meta.booking === 'rejected' && <Chip tone="red" title="The booking failed validation and was not saved">booking rejected</Chip>}
      {meta.failed && <Chip tone="red">fallback reply</Chip>}
    </div>
  );
}

/** `debug` shows how each AI reply was produced (rules or model, language, speed); on by default for reviewers. */
export function Transcript({ lines, name, debug = true }: { lines: Message[]; name: string; debug?: boolean }) {
  if (lines.length === 0) return <p className="text-[12.5px] text-muted">No transcript. The customer didn&apos;t speak, or the call wasn&apos;t answered.</p>;
  const replies = lines.filter((m) => m.role !== 'user').map((m) => (m.metadata ?? {}) as TurnMeta);
  const byModel = replies.filter((m) => m.path === 'llm').length;
  const timed = replies.map((m) => m.ms).filter((x): x is number => typeof x === 'number');
  const langs = [...new Set(replies.map((m) => (m.language ? LANG[m.language] ?? m.language : '')).filter(Boolean))];
  return (
    <div>
      {debug && replies.some((m) => m.path) && (
        <p className="mb-3 rounded-[10px] bg-[#f6f8fb] px-3 py-2 text-[11.5px] text-muted">
          {replies.length} AI replies · <b className="text-ink">{replies.length - byModel}</b> by rules · <b className="text-ink">{byModel}</b> by the AI model
          {timed.length > 0 && <> · median {(median(timed) / 1000).toFixed(1)} s to reply</>}
          {langs.length > 0 && <> · languages: {langs.join(', ')}</>}
        </p>
      )}
    <ol className="flex flex-col gap-3">
      {lines.map((m) => (
        <li key={m.id} className="flex gap-2.5">
          <span className={cx('mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[10px] font-bold', m.role === 'user' ? 'bg-amber-soft text-[#b45309]' : 'bg-violet-soft text-violet')}>
            {m.role === 'user' ? name.charAt(0) : 'AI'}
          </span>
          <div className="min-w-0">
            <p className={cx('text-[11.5px] font-semibold', m.role === 'user' ? 'text-ink' : 'text-violet')}>
              {m.role === 'user' ? name : 'Tacksharp AI'} <span className="font-normal text-faint">{timeOnly(m.createdAt)}</span>
            </p>
            <p className="text-[13px] leading-relaxed text-body">{m.content}</p>
            {m.role !== 'user' && debug && <TurnBadges meta={m.metadata as TurnMeta | null} />}
          </div>
        </li>
      ))}
    </ol>
    </div>
  );
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

