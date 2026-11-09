'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ROLE_COLOR, ROLE_LABEL } from '@/components/office';

/**
 * The animated office floor: rooms per department, a desk per agent, and small drawn employees that show what the
 * agents are doing — typing at their desk while a task runs, standing with a “!” when an action waits for approval,
 * asleep when paused, wandering or fetching coffee when idle, and walking an envelope to a colleague for every
 * message the engine delivered between agents. Inspired by Munder Difflin's office floor; every shape here is drawn
 * in code (no copied art). Respects prefers-reduced-motion (no walking, no flicker).
 */
export type SceneAgent = { id: string; role: string; name: string; status: string; breaker: string; enabled: boolean; currentTask: { id: string; title: string } | null; open: Record<string, number> };
export type SceneDepartment = { key: string; name: string; agents: SceneAgent[] };
export type SceneMessage = { id: string; fromRole: string; toRole: string; act: string; createdAt: string };

const W = 1200;
const H = 604;
const TOP = 56;
const ROOM_H = 242;
const CORRIDOR_Y = TOP + ROOM_H + 24; // centre line of the corridor between the two rows
const ROOM_W = (W - 40 - 3 * 24) / 4;
const ORDER = ['leadership', 'operations', 'sales', 'support', 'finance', 'marketing', 'people', 'research'];
const COFFEE = { x: W / 2, y: CORRIDOR_Y + 6 };
const SPEED = 60; // px per second

type Pt = { x: number; y: number };
type Room = { key: string; name: string; x: number; y: number; w: number; h: number; top: boolean; door: Pt; color: string };
type Desk = { agent: SceneAgent; room: Room; desk: Pt; seat: Pt; stand: Pt; half: number };
type Sim = { pos: Pt; path: Pt[]; restUntil: number; seated: boolean; carrying: string | null; facingUp: boolean; job: 'none' | 'deliver' | 'return'; bubble: string | null; bubbleUntil: number };

const ROOM_TINT: Record<string, string> = { leadership: '#ede9fe', operations: '#e0f2fe', sales: '#dcfce7', support: '#fef3c7', finance: '#ccfbf1', marketing: '#ffedd5', people: '#f3e8ff', research: '#e2e8f0' };
const ROOM_ACCENT: Record<string, string> = { leadership: '#7c3aed', operations: '#0369a1', sales: '#047857', support: '#b45309', finance: '#0f766e', marketing: '#c2410c', people: '#6d28d9', research: '#475569' };
const SKIN = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac'];
const SHORT: Record<string, string> = { qa: 'QA', support: 'Support' };
const ACT_TEXT: Record<string, string> = { request: 'Can you do this?', query: 'Quick question…', propose: 'Proposal for you', inform: 'FYI', done: 'Done ✓', agree: 'Agreed', refuse: 'Can’t do it' };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

function layout(departments: SceneDepartment[]): { rooms: Room[]; desks: Desk[] } {
  const sorted = [...departments].sort((a, b) => (ORDER.indexOf(a.key) + 99 * Number(!ORDER.includes(a.key))) - (ORDER.indexOf(b.key) + 99 * Number(!ORDER.includes(b.key)))).slice(0, 8);
  const rooms: Room[] = [];
  const desks: Desk[] = [];
  sorted.forEach((d, i) => {
    const col = i % 4;
    const top = i < 4;
    const x = 20 + col * (ROOM_W + 24);
    const y = top ? TOP : TOP + ROOM_H + 48;
    const room: Room = { key: d.key, name: d.name, x, y, w: ROOM_W, h: ROOM_H, top, door: { x: x + ROOM_W / 2, y: top ? y + ROOM_H : y }, color: ROOM_ACCENT[d.key] ?? '#475569' };
    rooms.push(room);
    const n = Math.max(1, d.agents.length);
    d.agents.slice(0, 3).forEach((agent, k) => {
      const dx = x + (ROOM_W * (k + 1)) / (Math.min(n, 3) + 1);
      // Top row: desk near the far (top) wall, chair below it. Bottom row: desk near the bottom wall, chair above.
      const deskY = top ? y + 84 : y + ROOM_H - 78;
      const seat = top ? { x: dx, y: deskY + 62 } : { x: dx, y: deskY + 6 };
      const half = Math.min(38, ROOM_W / (Math.min(n, 3) + 1) / 2 - 6);
      const stand = { x: dx + half + 6, y: seat.y + (top ? 4 : -2) };
      desks.push({ agent, room, desk: { x: dx, y: deskY }, seat, stand, half });
    });
  });
  return { rooms, desks };
}

/** Waypoints from one point to another through the doors and the corridor (rooms have one door each). */
function route(from: Pt, fromRoom: Room | null, to: Pt, toRoom: Room | null): Pt[] {
  if (fromRoom && toRoom && fromRoom.key === toRoom.key) return [to];
  const pts: Pt[] = [];
  if (fromRoom) pts.push({ x: fromRoom.door.x, y: fromRoom.door.y + (fromRoom.top ? -14 : 14) }, fromRoom.door, { x: fromRoom.door.x, y: CORRIDOR_Y });
  else pts.push({ x: from.x, y: CORRIDOR_Y });
  if (toRoom) pts.push({ x: toRoom.door.x, y: CORRIDOR_Y }, toRoom.door, { x: toRoom.door.x, y: toRoom.door.y + (toRoom.top ? -14 : 14) });
  else pts.push({ x: to.x, y: CORRIDOR_Y });
  pts.push(to);
  return pts;
}

function wanderPoint(d: Desk): { pt: Pt; room: Room | null } {
  if (Math.random() < 0.18) return { pt: { x: COFFEE.x + rand(-40, 40), y: COFFEE.y + rand(-4, 6) }, room: null };
  const r = d.room;
  const y = r.top ? rand(d.seat.y + 22, r.y + r.h - 18) : rand(r.y + 70, d.seat.y - 48);
  return { pt: { x: rand(r.x + 26, r.x + r.w - 26), y }, room: r };
}

function istClock() {
  const d = new Date(Date.now() + 330 * 60_000);
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

export function OfficeFloorScene({ departments, messages, paused }: { departments: SceneDepartment[]; messages: SceneMessage[]; paused: boolean }) {
  const router = useRouter();
  const { rooms, desks } = useMemo(() => layout(departments), [departments]);
  const sims = useRef(new Map<string, Sim>());
  const seen = useRef<Set<string> | null>(null);
  const [, setFrame] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [clock, setClock] = useState(istClock());
  const deskByRole = useMemo(() => new Map(desks.map((d) => [d.agent.role, d])), [desks]);

  useEffect(() => {
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(m.matches);
    on();
    m.addEventListener('change', on);
    const t = setInterval(() => setClock(istClock()), 30_000);
    return () => { m.removeEventListener('change', on); clearInterval(t); };
  }, []);

  // Place new agents at their seat.
  for (const d of desks) if (!sims.current.has(d.agent.id)) sims.current.set(d.agent.id, { pos: { ...d.seat }, path: [], restUntil: performance.now() + rand(500, 4000), seated: true, carrying: null, facingUp: d.room.top, job: 'none', bubble: null, bubbleUntil: 0 });

  // Every new message between agents: the sender walks an envelope to the recipient's desk and back.
  useEffect(() => {
    const now = Date.now();
    if (!seen.current) {
      seen.current = new Set(messages.filter((m) => now - new Date(m.createdAt).getTime() > 90_000).map((m) => m.id));
    }
    for (const m of messages) {
      if (seen.current.has(m.id)) continue;
      seen.current.add(m.id);
      const from = deskByRole.get(m.fromRole);
      const to = deskByRole.get(m.toRole);
      if (!from || !to || from === to) continue;
      const s = sims.current.get(from.agent.id);
      if (!s || s.job !== 'none') continue;
      const target = { x: to.stand.x - 6, y: to.stand.y };
      s.path = route(s.pos, roomAt(s.pos, rooms), target, to.room);
      s.seated = false;
      s.carrying = m.act;
      s.job = 'deliver';
      s.bubble = `To ${ROLE_LABEL[m.toRole] ?? m.toRole}: ${ACT_TEXT[m.act] ?? m.act}`;
      s.bubbleUntil = performance.now() + 4000;
    }
  }, [messages, deskByRole, rooms]);

  // Animation loop.
  useEffect(() => {
    if (reduced) {
      for (const d of desks) { const s = sims.current.get(d.agent.id)!; s.pos = { ...(d.agent.status === 'waiting' ? d.stand : d.seat) }; s.path = []; s.seated = d.agent.status !== 'waiting'; s.job = 'none'; s.carrying = null; }
      setFrame((f) => f + 1);
      return;
    }
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      for (const d of desks) {
        const s = sims.current.get(d.agent.id);
        if (!s) continue;
        const status = paused ? 'paused' : d.agent.status;
        // What the agent should be doing when it has no errand.
        if (s.job === 'none' && !s.path.length) {
          if (status === 'working' || status === 'paused' || status === 'off') {
            if (dist(s.pos, d.seat) > 2) s.path = route(s.pos, inRoom(s.pos, d.room) ? d.room : null, d.seat, d.room);
            else s.seated = true;
          } else if (status === 'waiting') {
            if (dist(s.pos, d.stand) > 2) { s.seated = false; s.path = route(s.pos, inRoom(s.pos, d.room) ? d.room : null, d.stand, d.room); }
          } else if (now > s.restUntil) {
            // Idle: sit a while, wander, or fetch coffee.
            if (Math.random() < 0.35) { s.path = route(s.pos, inRoom(s.pos, d.room) ? d.room : null, d.seat, d.room); }
            else { const w = wanderPoint(d); s.path = route(s.pos, inRoom(s.pos, d.room) ? d.room : null, w.pt, w.room); }
            s.seated = false;
            s.restUntil = now + rand(2500, 7000);
          }
        }
        if (s.path.length) {
          s.seated = false;
          const t = s.path[0];
          const dd = dist(s.pos, t);
          const move = SPEED * dt * (s.job !== 'none' ? 1.4 : 1);
          if (dd <= move) {
            s.pos = { ...t };
            s.path.shift();
            if (!s.path.length) {
              if (s.job === 'deliver') {
                s.job = 'return';
                s.carrying = null;
                s.bubble = 'Here you go!';
                s.bubbleUntil = now + 1600;
                const back = route(s.pos, roomAt(s.pos, rooms), d.seat, d.room);
                setTimeout(() => { s.path = back; }, 900);
              } else if (s.job === 'return') {
                s.job = 'none';
              }
              if (dist(s.pos, d.seat) < 2) s.seated = true;
              s.restUntil = Math.max(s.restUntil, now + rand(1500, 5000));
            }
          } else {
            s.facingUp = t.y < s.pos.y - 0.5 ? true : t.y > s.pos.y + 0.5 ? false : s.facingUp;
            s.pos = { x: s.pos.x + ((t.x - s.pos.x) / dd) * move, y: s.pos.y + ((t.y - s.pos.y) / dd) * move };
          }
        } else if (s.seated) {
          s.facingUp = d.room.top;
        }
      }
      acc += dt;
      if (acc > 1 / 30) { acc = 0; setFrame((f) => (f + 1) % 1_000_000); }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [desks, rooms, paused, reduced]);

  const t = typeof performance !== 'undefined' ? performance.now() : 0;
  const renderDesk = ({ agent, desk, room, half }: Desk) => {
        const working = !paused && agent.status === 'working';
        const flick = working && Math.floor(t / 220 + hash(agent.id)) % 3;
        return (
          <g key={`desk-${agent.id}`} aria-hidden>
            {/* chair */}
            {room.top && <rect x={desk.x - 10} y={desk.y + 36} width={20} height={14} rx={3} fill="#334155" />}
            <rect x={desk.x - half} y={desk.y} width={half * 2} height={28} fill="#a16207" />
            <rect x={desk.x - half} y={desk.y} width={half * 2} height={5} fill="#ca8a04" />
            <rect x={desk.x - half} y={desk.y + 28} width={half * 2} height={4} fill="#713f12" />
            {/* monitor */}
            <rect x={desk.x - 15} y={desk.y - 14} width={30} height={20} fill="#1e293b" />
            <rect x={desk.x - 12} y={desk.y - 11} width={24} height={14} fill={working ? ROLE_COLOR[agent.role] ?? '#475569' : agent.status === 'waiting' ? '#f59e0b' : '#334155'} opacity={working ? 0.85 : 0.9} />
            {working && <><rect x={desk.x - 9} y={desk.y - 8} width={flick ? 14 : 9} height={2} fill="#ffffff" opacity="0.85" /><rect x={desk.x - 9} y={desk.y - 4} width={flick === 1 ? 7 : 16} height={2} fill="#ffffff" opacity="0.7" /></>}
            <rect x={desk.x - 3} y={desk.y + 6} width={6} height={4} fill="#1e293b" />
            {/* mug + papers */}
            <rect x={desk.x + half - 12} y={desk.y + 8} width={7} height={8} fill="#f8fafc" stroke="#94a3b8" />
            <rect x={desk.x - half + 5} y={desk.y + 9} width={10} height={9} fill="#f8fafc" />
            {(agent.open.queued ?? 0) + (agent.open.blocked ?? 0) > 0 && <rect x={desk.x - half + 6} y={desk.y + 7} width={10} height={9} fill="#e2e8f0" stroke="#94a3b8" />}
          </g>
        );
      };

  const night = clock.h < 6 || clock.h >= 19;
  const time = `${String(clock.h).padStart(2, '0')}:${String(clock.m).padStart(2, '0')}`;
  // Draw back to front by y, so a character walking in front of a desk is drawn over it.
  const people = desks.map((d) => ({ d, s: sims.current.get(d.agent.id)! })).filter((p) => p.s).sort((a, b) => a.s.pos.y - b.s.pos.y);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full min-w-[760px] select-none" role="img" aria-label={`Animated office floor: ${desks.map((d) => `${d.agent.name} ${d.agent.status}`).join(', ')}`} shapeRendering="crispEdges">
      <defs>
        <pattern id="carpet" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#e7e5e4" /><rect width="8" height="8" fill="#e2e0de" /><rect x="8" y="8" width="8" height="8" fill="#e2e0de" /></pattern>
        <pattern id="tiles" width="24" height="24" patternUnits="userSpaceOnUse"><rect width="24" height="24" fill="#d6d3d1" /><rect width="23" height="23" fill="#e7e5e4" /></pattern>
        {rooms.map((r) => (
          <pattern key={r.key} id={`floor-${r.key}`} width="20" height="20" patternUnits="userSpaceOnUse"><rect width="20" height="20" fill={ROOM_TINT[r.key] ?? '#f1f5f9'} /><rect width="10" height="10" fill="#ffffff" opacity="0.35" /><rect x="10" y="10" width="10" height="10" fill="#ffffff" opacity="0.35" /></pattern>
        ))}
      </defs>

      {/* building: corridor tiles, outer wall with windows and a clock */}
      <rect width={W} height={H} fill="url(#tiles)" />
      <rect width={W} height={TOP - 8} fill="#334155" />
      {Array.from({ length: 10 }).map((_, i) => (
        <g key={i}>
          <rect x={40 + i * 116} y={10} width={80} height={26} fill={night ? '#1e293b' : '#bae6fd'} stroke="#cbd5e1" strokeWidth="3" />
          {night ? <><rect x={52 + i * 116} y={16} width={2} height={2} fill="#fef9c3" /><rect x={88 + i * 116} y={24} width={2} height={2} fill="#fef9c3" /></> : <rect x={44 + i * 116} y={13} width={22} height={6} fill="#ffffff" opacity="0.7" />}
          <rect x={79 + i * 116} y={10} width={3} height={26} fill="#cbd5e1" />
        </g>
      ))}
      <g>
        <rect x={W / 2 - 46} y={6} width={92} height={34} rx={6} fill="#0f172a" stroke="#64748b" strokeWidth="2" />
        <text x={W / 2} y={29} textAnchor="middle" fontSize="18" fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace" fill="#34d399">{time}</text>
      </g>

      {/* corridor props: coffee machine and water cooler (idle agents visit) */}
      <g transform={`translate(${COFFEE.x - 70} ${CORRIDOR_Y - 20})`} aria-hidden>
        <rect width="26" height="30" fill="#78716c" /><rect x="4" y="4" width="18" height="8" fill="#1c1917" /><rect x="9" y="18" width="8" height="8" fill="#f5f5f4" /><rect x="10" y="20" width="6" height="4" fill="#78350f" />
        <text x="13" y="44" textAnchor="middle" fontSize="9" fill="#57534e" fontFamily="system-ui">coffee</text>
      </g>
      <g transform={`translate(${COFFEE.x + 46} ${CORRIDOR_Y - 26})`} aria-hidden>
        <rect x="4" width="16" height="14" fill="#7dd3fc" opacity="0.8" /><rect y="14" width="24" height="24" fill="#e2e8f0" stroke="#94a3b8" />
        <text x="12" y="50" textAnchor="middle" fontSize="9" fill="#57534e" fontFamily="system-ui">water</text>
      </g>

      {rooms.map((r) => (
        <g key={r.key}>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={`url(#floor-${r.key})`} />
          <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke="#475569" strokeWidth="6" />
          {/* door gap */}
          <rect x={r.door.x - 20} y={r.door.y - 4} width={40} height={8} fill={`url(#floor-${r.key})`} />
          <rect x={r.door.x - 22} y={r.door.y - 4} width={3} height={8} fill="#92400e" /><rect x={r.door.x + 19} y={r.door.y - 4} width={3} height={8} fill="#92400e" />
          {/* name plate */}
          <rect x={r.x + 10} y={r.top ? r.y + 10 : r.y + r.h - 34} width={Math.min(r.w - 20, r.name.length * 7.4 + 22)} height={22} rx={4} fill="#ffffff" stroke={r.color} strokeWidth="2" />
          <rect x={r.x + 16} y={r.top ? r.y + 17 : r.y + r.h - 27} width={8} height={8} fill={r.color} />
          <text x={r.x + 30} y={r.top ? r.y + 25.5 : r.y + r.h - 18.5} fontSize="11.5" fontWeight="700" fill="#0f172a" fontFamily="system-ui" shapeRendering="auto">{r.name}</text>
          {/* plant */}
          <g transform={`translate(${r.x + r.w - 30} ${r.top ? r.y + 14 : r.y + r.h - 42})`} aria-hidden>
            <rect x="4" y="16" width="14" height="12" fill="#b45309" /><rect x="2" y="2" width="8" height="8" fill="#16a34a" /><rect x="11" y="0" width="8" height="10" fill="#22c55e" /><rect x="6" y="8" width="10" height="9" fill="#15803d" />
          </g>
          {/* rug, bookshelf, wall picture */}
          <rect x={r.x + r.w / 2 - 54} y={r.top ? r.y + r.h - 62 : r.y + 52} width={108} height={36} rx={6} fill={r.color} opacity="0.1" stroke={r.color} strokeOpacity="0.25" strokeDasharray="4 3" aria-hidden />
          <g transform={`translate(${r.x + 8} ${r.top ? r.y + r.h - 70 : r.y + 46})`} aria-hidden>
            <rect width="12" height="44" fill="#78350f" /><rect x="2" y="3" width="8" height="5" fill="#ef4444" /><rect x="2" y="12" width="8" height="5" fill="#3b82f6" /><rect x="2" y="21" width="8" height="5" fill="#eab308" /><rect x="2" y="30" width="8" height="5" fill="#10b981" />
          </g>
          {r.top && <g transform={`translate(${r.x + r.w - 76} ${r.y + 12})`} aria-hidden><rect width="30" height="20" fill="#fef3c7" stroke="#92400e" strokeWidth="2" /><path d="M4 16l7-8 6 6 4-4 6 6z" fill={r.color} opacity="0.7" /></g>}
        </g>
      ))}

      {/* desks: top-row desks are behind the people sitting below them */}
      {desks.filter((d) => d.room.top).map(renderDesk)}
      {desks.filter((d) => !d.room.top).map((d) => <rect key={`chair-${d.agent.id}`} x={d.desk.x - 11} y={d.desk.y - 34} width={22} height={26} rx={4} fill="#334155" aria-hidden />)}
      {/* people */}
      {people.map(({ d, s }) => {
        const status = paused ? 'paused' : d.agent.status;
        const asleep = (status === 'paused' || status === 'off') && s.seated;
        const walking = s.path.length > 0;
        const frame = Math.floor(t / 140) % 2;
        const shirt = ROLE_COLOR[d.agent.role] ?? '#475569';
        const skin = SKIN[hash(d.agent.id) % SKIN.length];
        const x = Math.round(s.pos.x);
        const y = Math.round(s.pos.y);
        const back = s.facingUp;
        const bob = status === 'working' && s.seated && !reduced ? (Math.floor(t / 260) % 2) : 0;
        const bubble = s.bubble && t < s.bubbleUntil ? s.bubble
          : status === 'working' && s.seated && d.agent.currentTask ? `${clip(d.agent.currentTask.title, 24)}${reduced ? '' : '.'.repeat(1 + (Math.floor(t / 400) % 3))}`
          : status === 'waiting' ? '! Needs your approval'
          : asleep ? 'z z z'
          : d.agent.breaker === 'stopped' ? 'Stopped by breaker' : null;
        const tone = status === 'waiting' ? '#f59e0b' : asleep ? '#94a3b8' : s.carrying ? '#0ea5e9' : '#334155';
        const bw = bubble ? Math.min(170, bubble.length * 5.6 + 14) : 0;
        return (
          <g key={d.agent.id} transform={`translate(${x} ${y}) scale(1.3) translate(${-x} ${-y})`} role="link" tabIndex={0} aria-label={`${d.agent.name}: ${status}${d.agent.currentTask ? `, ${d.agent.currentTask.title}` : ''}`} onClick={() => router.push(`/office/agents?agent=${d.agent.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') router.push(`/office/agents?agent=${d.agent.id}`); }} style={{ cursor: 'pointer', outline: 'none' }} opacity={status === 'off' ? 0.45 : 1}>
            <title>{`${d.agent.name} · ${status}${d.agent.currentTask ? ` · ${d.agent.currentTask.title}` : ''}`}</title>
            <ellipse cx={x} cy={y + 1} rx={9} ry={3} fill="#0f172a" opacity="0.18" />
            {/* legs (hidden behind the desk when seated) */}
            {!s.seated && <>
              <rect x={x - 5} y={y - 8 + (walking && frame ? -2 : 0)} width={4} height={8} fill="#1e293b" />
              <rect x={x + 1} y={y - 8 + (walking && !frame ? -2 : 0)} width={4} height={8} fill="#1e293b" />
            </>}
            {/* body + arms */}
            <rect x={x - 7} y={y - 19 + bob} width={14} height={12} fill={shirt} />
            <rect x={x - 10} y={y - 18 + bob + (walking && frame ? 1 : 0)} width={3} height={9} fill={shirt} />
            <rect x={x + 7} y={y - 18 + bob + (walking && !frame ? 1 : 0)} width={3} height={9} fill={shirt} />
            <rect x={x - 10} y={y - 10 + bob} width={3} height={2} fill={skin} /><rect x={x + 7} y={y - 10 + bob} width={3} height={2} fill={skin} />
            {/* head */}
            <rect x={x - 6} y={y - 31 + bob} width={12} height={12} fill={skin} />
            <rect x={x - 6} y={y - 32 + bob} width={12} height={back ? 10 : 4} fill={d.agent.role === 'ceo' ? '#1f2937' : hash(d.agent.id) % 2 ? '#3f2a1d' : '#111827'} />
            {!back && !asleep && <><rect x={x - 4} y={y - 26 + bob} width={2} height={2} fill="#0f172a" /><rect x={x + 2} y={y - 26 + bob} width={2} height={2} fill="#0f172a" /></>}
            {!back && asleep && <><rect x={x - 4} y={y - 25} width={3} height={1} fill="#0f172a" /><rect x={x + 1} y={y - 25} width={3} height={1} fill="#0f172a" /></>}
            {d.agent.role === 'ceo' && <path d={`M${x - 6} ${y - 33 + bob}l2-5 2 3 2-4 2 4 2-3 2 5z`} fill="#f59e0b" />}
            {/* envelope while carrying a message */}
            {s.carrying && <g><rect x={x - 6} y={y - 17} width={12} height={8} fill="#ffffff" stroke="#0ea5e9" /><path d={`M${x - 6} ${y - 17}l6 4 6-4`} fill="none" stroke="#0ea5e9" /></g>}
            {/* name */}
            <text x={x} y={y - 37} textAnchor="middle" fontSize="9" fontWeight="600" fill="#0f172a" fontFamily="system-ui" shapeRendering="auto" paintOrder="stroke" stroke="#ffffff" strokeWidth="3">{SHORT[d.agent.role] ?? d.agent.name}</text>
            {/* speech bubble */}
            {bubble && (
              <g shapeRendering="auto">
                <rect x={x - bw / 2} y={y - 68} width={bw} height={18} rx={6} fill="#ffffff" stroke={tone} strokeWidth="1.5" />
                <path d={`M${x - 4} ${y - 50.5}l4 5 4-5z`} fill="#ffffff" stroke={tone} strokeWidth="1.5" />
                <rect x={x - 3.5} y={y - 51.5} width={7} height={2} fill="#ffffff" />
                <text x={x} y={y - 55.5} textAnchor="middle" fontSize="10" fill={status === 'waiting' ? '#92400e' : '#0f172a'} fontFamily="system-ui" fontWeight={status === 'waiting' ? 700 : 500}>{bubble}</text>
              </g>
            )}
          </g>
        );
      })}

      {/* bottom-row desks are in front of the people sitting behind them */}
      {desks.filter((d) => !d.room.top).map(renderDesk)}

      {paused && (
        <g shapeRendering="auto">
          <rect width={W} height={H} fill="#0f172a" opacity="0.28" />
          <rect x={W / 2 - 150} y={H / 2 - 30} width={300} height={60} rx={12} fill="#fffbeb" stroke="#f59e0b" strokeWidth="3" />
          <text x={W / 2} y={H / 2 + 7} textAnchor="middle" fontSize="20" fontWeight="700" fill="#92400e" fontFamily="system-ui">Office paused</text>
        </g>
      )}
    </svg>
  );
}

function inRoom(p: Pt, r: Room) {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}
function roomAt(p: Pt, rooms: Room[]) {
  return rooms.find((r) => inRoom(p, r)) ?? null;
}
