/* eslint-disable no-console */

import { NextRequest } from 'next/server';

import { db } from './db';
import { lockManager } from './lock';

const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as
    | 'localstorage'
    | 'redis'
    | 'upstash'
    | 'kvrocks'
    | 'd1'
    | 'postgres'
    | undefined) || 'localstorage';

const USE_PERSISTENT_STORE = STORAGE_TYPE !== 'localstorage';
const LOGIN_RATE_LIMIT_PREFIX = 'security:login-rate-limit:v1:';
const PASSWORD_GATE_USERNAME = '__password_gate__';

function readPositiveIntEnv(name: string, fallback: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return fallback;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[LoginRateLimit] Invalid ${name}=${rawValue}, fallback to ${fallback}`
    );
    return fallback;
  }

  return parsed;
}

const WINDOW_MINUTES = readPositiveIntEnv('LOGIN_RATE_LIMIT_WINDOW_MINUTES', 10);
const BLOCK_DURATION_MINUTES = readPositiveIntEnv(
  'LOGIN_RATE_LIMIT_BLOCK_MINUTES',
  15
);
const WINDOW_MS = WINDOW_MINUTES * 60 * 1000;
const BLOCK_DURATION_MS = BLOCK_DURATION_MINUTES * 60 * 1000;
const MAX_FAILURES_PER_IP = readPositiveIntEnv(
  'LOGIN_RATE_LIMIT_MAX_FAILURES_PER_IP',
  20
);
const MAX_FAILURES_PER_IP_USERNAME = readPositiveIntEnv(
  'LOGIN_RATE_LIMIT_MAX_FAILURES_PER_IP_USERNAME',
  5
);
const PERMANENT_BAN_PER_IP =
  process.env.LOGIN_RATE_LIMIT_PERMANENT_BAN_PER_IP === 'true';

type RateLimitState = {
  failedAt: number[];
  blockedUntil?: number;
  permanentlyBlocked?: boolean;
  updatedAt: number;
};

type RateLimitDescriptor = {
  key: string;
  maxFailures: number;
  permanentBan: boolean;
};

export type LoginRateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
  message?: string;
  statusCode?: 403 | 429;
};

const globalStoreKey = Symbol.for('__MOONTV_LOGIN_RATE_LIMIT_STORE__');
type GlobalRateLimitStore = typeof globalThis & {
  [globalStoreKey]?: Map<string, RateLimitState>;
};

const globalRateLimitStore = globalThis as GlobalRateLimitStore;
let memoryStore: Map<string, RateLimitState> | undefined =
  globalRateLimitStore[globalStoreKey];

if (!memoryStore) {
  memoryStore = new Map<string, RateLimitState>();
  globalRateLimitStore[globalStoreKey] = memoryStore;
}

function getClientIp(request: NextRequest): string {
  const cfConnectingIp = request.headers.get('cf-connecting-ip');
  if (cfConnectingIp) {
    return cfConnectingIp.trim();
  }

  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const firstIp = forwardedFor.split(',')[0]?.trim();
    if (firstIp) {
      return firstIp;
    }
  }

  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    return realIp.trim();
  }

  return 'unknown';
}

function normalizeUsername(username?: string | null): string {
  const trimmed = username?.trim().toLowerCase();
  return trimmed || PASSWORD_GATE_USERNAME;
}

function buildDescriptors(
  request: NextRequest,
  username?: string | null
): RateLimitDescriptor[] {
  const ip = encodeURIComponent(getClientIp(request));
  const normalizedUsername = encodeURIComponent(normalizeUsername(username));

  return [
    {
      key: `${LOGIN_RATE_LIMIT_PREFIX}ip:${ip}`,
      maxFailures: MAX_FAILURES_PER_IP,
      permanentBan: PERMANENT_BAN_PER_IP,
    },
    {
      key: `${LOGIN_RATE_LIMIT_PREFIX}ip-user:${ip}:${normalizedUsername}`,
      maxFailures: MAX_FAILURES_PER_IP_USERNAME,
      permanentBan: false,
    },
  ];
}

function normalizeState(
  state: RateLimitState | null,
  now: number
): { state: RateLimitState | null; changed: boolean } {
  if (!state) {
    return { state: null, changed: false };
  }

  if (state.permanentlyBlocked) {
    return {
      state: {
        failedAt: [],
        permanentlyBlocked: true,
        updatedAt: state.updatedAt,
      },
      changed: state.failedAt.length > 0 || !!state.blockedUntil,
    };
  }

  const failedAt = state.failedAt.filter((timestamp) => now - timestamp < WINDOW_MS);
  const blockedUntil =
    state.blockedUntil && state.blockedUntil > now ? state.blockedUntil : undefined;

  const changed =
    failedAt.length !== state.failedAt.length || blockedUntil !== state.blockedUntil;

  if (failedAt.length === 0 && !blockedUntil) {
    return { state: null, changed: true };
  }

  return {
    state: {
      failedAt,
      blockedUntil,
      permanentlyBlocked: false,
      updatedAt: state.updatedAt,
    },
    changed,
  };
}

async function loadState(key: string): Promise<RateLimitState | null> {
  if (USE_PERSISTENT_STORE) {
    const raw = await db.getGlobalValue(key);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as RateLimitState;
    } catch (error) {
      console.error('[LoginRateLimit] Failed to parse state:', error);
      await db.deleteGlobalValue(key);
      return null;
    }
  }

  return memoryStore?.get(key) || null;
}

async function persistState(
  key: string,
  state: RateLimitState | null
): Promise<void> {
  if (USE_PERSISTENT_STORE) {
    if (!state) {
      await db.deleteGlobalValue(key);
      return;
    }

    await db.setGlobalValue(key, JSON.stringify(state));
    return;
  }

  if (!memoryStore) {
    return;
  }

  if (!state) {
    memoryStore.delete(key);
    return;
  }

  memoryStore.set(key, state);
}

async function withRateLimitLocks<T>(
  keys: string[],
  handler: () => Promise<T>
): Promise<T> {
  const sortedKeys = Array.from(new Set(keys)).sort();
  const releases: Array<() => void> = [];

  try {
    for (const key of sortedKeys) {
      const release = await lockManager.acquire(`login-rate-limit:${key}`);
      releases.push(release);
    }

    return await handler();
  } finally {
    for (const release of releases.reverse()) {
      release();
    }
  }
}

function buildTemporaryBlockedResult(blockedUntil: number): LoginRateLimitResult {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((blockedUntil - Date.now()) / 1000)
  );

  return {
    allowed: false,
    retryAfterSeconds,
    message: '登录尝试过于频繁，请稍后再试',
    statusCode: 429,
  };
}

function buildPermanentBlockedResult(): LoginRateLimitResult {
  return {
    allowed: false,
    retryAfterSeconds: 0,
    message: '该 IP 已被永久封禁',
    statusCode: 403,
  };
}

export async function checkLoginRateLimit(
  request: NextRequest,
  username?: string | null
): Promise<LoginRateLimitResult> {
  const descriptors = buildDescriptors(request, username);

  try {
    return await withRateLimitLocks(
      descriptors.map((descriptor) => descriptor.key),
      async () => {
        const now = Date.now();
        let blockedUntil = 0;

        for (const descriptor of descriptors) {
          const normalized = normalizeState(await loadState(descriptor.key), now);
          if (normalized.changed) {
            await persistState(descriptor.key, normalized.state);
          }

          if (normalized.state?.permanentlyBlocked) {
            return buildPermanentBlockedResult();
          }

          if (normalized.state?.blockedUntil) {
            blockedUntil = Math.max(blockedUntil, normalized.state.blockedUntil);
          }
        }

        if (blockedUntil > now) {
          return buildTemporaryBlockedResult(blockedUntil);
        }

        return {
          allowed: true,
          retryAfterSeconds: 0,
        };
      }
    );
  } catch (error) {
    console.error('[LoginRateLimit] Check failed, allowing request:', error);
    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  }
}

export async function recordFailedLoginAttempt(
  request: NextRequest,
  username?: string | null
): Promise<LoginRateLimitResult> {
  const descriptors = buildDescriptors(request, username);

  try {
    return await withRateLimitLocks(
      descriptors.map((descriptor) => descriptor.key),
      async () => {
        const now = Date.now();
        let blockedUntil = 0;

        for (const descriptor of descriptors) {
          const normalized = normalizeState(await loadState(descriptor.key), now);
          const state: RateLimitState = normalized.state || {
            failedAt: [],
            permanentlyBlocked: false,
            updatedAt: now,
          };

          state.failedAt.push(now);
          state.updatedAt = now;

          if (state.failedAt.length >= descriptor.maxFailures) {
            if (descriptor.permanentBan) {
              state.permanentlyBlocked = true;
              state.blockedUntil = undefined;
            } else {
              state.blockedUntil = now + BLOCK_DURATION_MS;
            }
            state.failedAt = [];
          }

          await persistState(descriptor.key, state);

          if (state.permanentlyBlocked) {
            return buildPermanentBlockedResult();
          }

          if (state.blockedUntil) {
            blockedUntil = Math.max(blockedUntil, state.blockedUntil);
          }
        }

        if (blockedUntil > now) {
          return buildTemporaryBlockedResult(blockedUntil);
        }

        return {
          allowed: true,
          retryAfterSeconds: 0,
        };
      }
    );
  } catch (error) {
    console.error('[LoginRateLimit] Record failed attempt error:', error);
    return {
      allowed: true,
      retryAfterSeconds: 0,
    };
  }
}

export async function clearLoginRateLimit(
  request: NextRequest,
  username?: string | null
): Promise<void> {
  const descriptors = buildDescriptors(request, username);
  const ipUserKey = descriptors[1]?.key;

  if (!ipUserKey) {
    return;
  }

  try {
    await withRateLimitLocks([ipUserKey], async () => {
      await persistState(ipUserKey, null);
    });
  } catch (error) {
    console.error('[LoginRateLimit] Clear failed:', error);
  }
}
