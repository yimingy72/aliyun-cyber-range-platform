'use client';

import { createContext, type ReactNode, useContext, useMemo, useRef } from 'react';

const DEFAULT_STALE_TIME_MS = 20_000;

type CacheEntry = {
  data?: unknown;
  freshUntil: number;
  request?: Promise<unknown>;
};

type CacheOptions = {
  now?: () => number;
  staleTimeMs?: number;
};

type CacheReadResult<T> = {
  data: T;
  isFresh: boolean;
};

type CacheLoadOptions = {
  force?: boolean;
};

export type AdminScreenCache = {
  read<T>(key: string): CacheReadResult<T> | null;
  load<T>(key: string, load: () => Promise<T>, options?: CacheLoadOptions): Promise<T>;
  invalidate(prefix?: string): void;
};

export function createAdminScreenCache(options: CacheOptions = {}): AdminScreenCache {
  const entries = new Map<string, CacheEntry>();
  const now = options.now ?? Date.now;
  const staleTimeMs = options.staleTimeMs ?? DEFAULT_STALE_TIME_MS;

  return {
    read<T>(key: string): CacheReadResult<T> | null {
      const entry = entries.get(key);

      if (!entry || !('data' in entry)) {
        return null;
      }

      return {
        data: entry.data as T,
        isFresh: entry.freshUntil > now(),
      };
    },

    load<T>(key: string, load: () => Promise<T>, loadOptions: CacheLoadOptions = {}): Promise<T> {
      const existing = entries.get(key);

      if (existing?.request) {
        return existing.request as Promise<T>;
      }

      if (!loadOptions.force && existing && 'data' in existing && existing.freshUntil > now()) {
        return Promise.resolve(existing.data as T);
      }

      const nextEntry: CacheEntry =
        existing && 'data' in existing
          ? {
              data: existing.data,
              freshUntil: existing.freshUntil,
            }
          : {
              freshUntil: 0,
            };
      const request = load().then(
        (data) => {
          if (entries.get(key) === nextEntry) {
            nextEntry.data = data;
            nextEntry.freshUntil = now() + staleTimeMs;
            delete nextEntry.request;
          }

          return data;
        },
        (error: unknown) => {
          if (entries.get(key) === nextEntry) {
            delete nextEntry.request;

            if (!('data' in nextEntry)) {
              entries.delete(key);
            }
          }

          throw error;
        },
      );

      nextEntry.request = request;
      entries.set(key, nextEntry);

      return request;
    },

    invalidate(prefix = '') {
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) {
          entries.delete(key);
        }
      }
    },
  };
}

type AdminScreenCacheContextValue = {
  read<T>(apiBaseUrl: string, token: string | null, resource: string): CacheReadResult<T> | null;
  load<T>(
    apiBaseUrl: string,
    token: string,
    resource: string,
    load: () => Promise<T>,
    options?: CacheLoadOptions,
  ): Promise<T>;
  invalidate(apiBaseUrl: string, token: string | null, resourcePrefix?: string): void;
};

const AdminScreenCacheContext = createContext<AdminScreenCacheContextValue | null>(null);

function buildCacheKey(apiBaseUrl: string, token: string, resource: string) {
  return `${apiBaseUrl}\u0000${token}\u0000${resource}`;
}

export function AdminScreenCacheProvider({ children }: { children: ReactNode }) {
  const cacheRef = useRef<AdminScreenCache | null>(null);

  if (!cacheRef.current) {
    cacheRef.current = createAdminScreenCache();
  }

  const cache = cacheRef.current;
  const value = useMemo<AdminScreenCacheContextValue>(
    () => ({
      read<T>(apiBaseUrl: string, token: string | null, resource: string): CacheReadResult<T> | null {
        return token ? cache.read<T>(buildCacheKey(apiBaseUrl, token, resource)) : null;
      },

      load<T>(
        apiBaseUrl: string,
        token: string,
        resource: string,
        load: () => Promise<T>,
        options?: CacheLoadOptions,
      ): Promise<T> {
        return cache.load<T>(buildCacheKey(apiBaseUrl, token, resource), load, options);
      },

      invalidate(apiBaseUrl: string, token: string | null, resourcePrefix = '') {
        if (token) {
          cache.invalidate(buildCacheKey(apiBaseUrl, token, resourcePrefix));
        }
      },
    }),
    [cache],
  );

  return <AdminScreenCacheContext.Provider value={value}>{children}</AdminScreenCacheContext.Provider>;
}

export function useAdminScreenCache() {
  return useContext(AdminScreenCacheContext);
}
