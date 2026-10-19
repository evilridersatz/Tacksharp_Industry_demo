/** Types for the reference local agent (agent.mjs). */
export type CheckResult = { ok: boolean; latencyMs: number; detail?: string };
export type AgentEvent = { eventId: string; device?: string; deviceType?: 'camera' | 'recorder' | 'site'; check: string; ok: boolean; observedAt: string; latencyMs?: number; detail?: string };
export type AgentConfig = {
  cloudUrl?: string; token?: string; hostLabel?: string; intervalSeconds?: number; timeoutMs?: number; queueFile?: string; backupLink?: boolean;
  gateway?: { host: string; port?: number };
  devices?: Array<{ code: string; type?: 'camera' | 'recorder'; host?: string; port?: number; rtspPort?: number; healthUrl?: string; checks?: string[] }>;
};
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
export const VERSION: string;
export function tcpCheck(host: string, port: number, timeoutMs?: number): Promise<CheckResult>;
export function rtspOptions(host: string, port?: number, timeoutMs?: number): Promise<CheckResult>;
export function httpCheck(url: string, timeoutMs?: number): Promise<CheckResult>;
export class Queue {
  constructor(file: string);
  push(events: AgentEvent[]): void;
  all(): AgentEvent[];
  size(): number;
  drop(n: number): void;
}
export function scrub(text: string | null | undefined): string | undefined;
export function runChecks(cfg: AgentConfig, now?: () => Date): Promise<AgentEvent[]>;
export function sync(cfg: AgentConfig, queue: Queue, fetchImpl?: FetchLike, batch?: number): Promise<{ sent: number; ok: boolean; error?: string }>;
export function heartbeat(cfg: AgentConfig, queue: Queue, fetchImpl?: FetchLike, link?: string): Promise<any>;
export function verifyUpdate(manifestJson: string, signatureB64: string, fileBuffer: Buffer, publicKeyPem: string | Buffer): { ok: boolean; version?: string; reason?: string };
