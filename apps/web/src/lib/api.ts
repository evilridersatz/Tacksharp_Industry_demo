'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The response body (for example per-field validation errors). */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      credentials: 'include', // session cookie
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(`Can't reach the Tacksharp API at ${API_URL}. Start it with "npm run dev" in the repo root.`, 0);
  }
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (response.status === 401 && !path.startsWith('/auth/') && typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
  }
  if (!response.ok) {
    throw new ApiError(body?.message ?? `Request failed (${response.status})`, response.status, body);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
};

/**
 * Fetch + poll. Keeps the last good data on screen while refreshing,
 * so live calls and new leads appear without a page reload.
 */
export function useApi<T>(path: string | null, refreshMs = 10_000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(async () => {
    const current = pathRef.current;
    if (!current) return;
    try {
      const result = await api.get<T>(current);
      if (pathRef.current === current) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (pathRef.current === current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (pathRef.current === current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    void load();
    if (!refreshMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [path, refreshMs, load]);

  return { data, error, loading, reload: load };
}
