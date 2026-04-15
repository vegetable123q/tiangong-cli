import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createClient, type Session } from '@supabase/supabase-js';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import { withStateFileLock } from './state-lock.js';
import {
  createSupabaseFetch,
  deriveSupabaseProjectBaseUrl,
  type SupabaseDataRuntime,
  type SupabaseRestRuntime,
} from './supabase-client.js';
import {
  fingerprintSecret,
  fingerprintUserApiKey,
  requireUserApiKeyCredentials,
} from './user-api-key.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const SESSION_REFRESH_WINDOW_SECONDS = 300;

export type CachedSupabaseSessionRecord = {
  schema_version: 1;
  supabase_url: string;
  publishable_key_fingerprint: string;
  user_api_key_fingerprint: string;
  user_email: string;
  access_token: string;
  refresh_token: string;
  expires_at: number | null;
  updated_at_utc: string;
};

export type ResolvedSupabaseUserSession = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  userEmail: string;
  projectBaseUrl: string;
  sessionFile: string | null;
  source: 'memory' | 'cache' | 'refresh' | 'signin';
};

type RuntimeIdentity = {
  projectBaseUrl: string;
  publishableKeyFingerprint: string;
  userApiKeyFingerprint: string;
  sessionFilePath: string | null;
  memoKey: string;
};

const SESSION_MEMORY_CACHE = new Map<string, CachedSupabaseSessionRecord>();
const SESSION_OPERATION_CHAINS = new Map<string, Promise<void>>();

function trimToken(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nowSeconds(now: Date): number {
  return Math.floor(now.getTime() / 1000);
}

function computeExpiresAt(session: Session, now: Date): number | null {
  if (typeof session.expires_at === 'number' && Number.isFinite(session.expires_at)) {
    return Math.floor(session.expires_at);
  }

  if (typeof session.expires_in === 'number' && Number.isFinite(session.expires_in)) {
    return nowSeconds(now) + Math.max(Math.floor(session.expires_in), 0);
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCachedSessionRecord(value: unknown): CachedSupabaseSessionRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value.schema_version !== 1) {
    return null;
  }

  const supabaseUrl = trimToken(value.supabase_url);
  const publishableKeyFingerprint = trimToken(value.publishable_key_fingerprint);
  const userApiKeyFingerprint = trimToken(value.user_api_key_fingerprint);
  const userEmail = trimToken(value.user_email);
  const accessToken = trimToken(value.access_token);
  const refreshToken = trimToken(value.refresh_token);
  const updatedAtUtc = trimToken(value.updated_at_utc);
  const expiresAt =
    typeof value.expires_at === 'number' && Number.isFinite(value.expires_at)
      ? Math.floor(value.expires_at)
      : value.expires_at === null
        ? null
        : NaN;

  if (
    !supabaseUrl ||
    !publishableKeyFingerprint ||
    !userApiKeyFingerprint ||
    !userEmail ||
    !accessToken ||
    !refreshToken ||
    !updatedAtUtc ||
    Number.isNaN(expiresAt)
  ) {
    return null;
  }

  return {
    schema_version: 1,
    supabase_url: supabaseUrl,
    publishable_key_fingerprint: publishableKeyFingerprint,
    user_api_key_fingerprint: userApiKeyFingerprint,
    user_email: userEmail,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    updated_at_utc: updatedAtUtc,
  };
}

function resolveDefaultSessionFilePath(options: {
  platform: NodeJS.Platform;
  homeDir: string;
  xdgStateHome: string | null;
  localAppData: string | null;
}): string {
  if (options.xdgStateHome) {
    return path.join(options.xdgStateHome, 'tiangong-lca-cli', 'session.json');
  }

  if (options.homeDir) {
    return path.join(options.homeDir, '.local', 'state', 'tiangong-lca-cli', 'session.json');
  }

  if (options.platform === 'darwin') {
    return path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'tiangong-lca-cli',
      'session.json',
    );
  }

  if (options.platform === 'win32' && options.localAppData) {
    return path.join(options.localAppData, 'tiangong-lca-cli', 'session.json');
  }

  return path.resolve('.tiangong-lca-session.json');
}

function resolveSessionFilePath(runtime: SupabaseRestRuntime): string | null {
  if (runtime.disableSessionCache) {
    return null;
  }

  if (runtime.sessionFile) {
    return path.resolve(runtime.sessionFile);
  }

  return resolveDefaultSessionFilePath({
    platform: process.platform,
    homeDir: trimToken(os.homedir()),
    xdgStateHome: trimToken(process.env.XDG_STATE_HOME) || null,
    localAppData: trimToken(process.env.LOCALAPPDATA) || null,
  });
}

function buildRuntimeIdentity(runtime: SupabaseRestRuntime): RuntimeIdentity {
  const projectBaseUrl = deriveSupabaseProjectBaseUrl(runtime.apiBaseUrl);
  const publishableKeyFingerprint = fingerprintSecret(runtime.publishableKey);
  const userApiKeyFingerprint = fingerprintUserApiKey(runtime.userApiKey);
  const sessionFilePath = resolveSessionFilePath(runtime);

  return {
    projectBaseUrl,
    publishableKeyFingerprint,
    userApiKeyFingerprint,
    sessionFilePath,
    memoKey: [
      projectBaseUrl,
      publishableKeyFingerprint,
      userApiKeyFingerprint,
      sessionFilePath ?? 'memory-only',
    ].join('|'),
  };
}

function recordMatchesRuntime(
  record: CachedSupabaseSessionRecord,
  runtime: RuntimeIdentity,
): boolean {
  return (
    record.supabase_url === runtime.projectBaseUrl &&
    record.publishable_key_fingerprint === runtime.publishableKeyFingerprint &&
    record.user_api_key_fingerprint === runtime.userApiKeyFingerprint
  );
}

function isSessionFresh(record: CachedSupabaseSessionRecord, now: Date): boolean {
  return (
    typeof record.expires_at === 'number' &&
    Number.isFinite(record.expires_at) &&
    record.expires_at > nowSeconds(now) + SESSION_REFRESH_WINDOW_SECONDS
  );
}

function buildCachedSessionRecord(options: {
  runtime: RuntimeIdentity;
  session: Session;
  userEmail: string;
  now: Date;
}): CachedSupabaseSessionRecord {
  const accessToken = trimToken(options.session.access_token);
  const refreshToken = trimToken(options.session.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new CliError('Supabase auth did not return a usable session.', {
      code: 'SUPABASE_AUTH_SESSION_INVALID',
      exitCode: 1,
    });
  }

  return {
    schema_version: 1,
    supabase_url: options.runtime.projectBaseUrl,
    publishable_key_fingerprint: options.runtime.publishableKeyFingerprint,
    user_api_key_fingerprint: options.runtime.userApiKeyFingerprint,
    user_email: options.userEmail,
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: computeExpiresAt(options.session, options.now),
    updated_at_utc: options.now.toISOString(),
  };
}

function toResolvedSession(
  record: CachedSupabaseSessionRecord,
  runtime: RuntimeIdentity,
  source: ResolvedSupabaseUserSession['source'],
): ResolvedSupabaseUserSession {
  return {
    accessToken: record.access_token,
    refreshToken: record.refresh_token,
    expiresAt: record.expires_at,
    userEmail: record.user_email,
    projectBaseUrl: runtime.projectBaseUrl,
    sessionFile: runtime.sessionFilePath,
    source,
  };
}

function readCachedSessionRecord(sessionFilePath: string): CachedSupabaseSessionRecord | null {
  try {
    const text = readFileSync(sessionFilePath, 'utf8').trim();
    if (!text) {
      return null;
    }

    return parseCachedSessionRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function writeCachedSessionRecord(
  sessionFilePath: string,
  record: CachedSupabaseSessionRecord,
): void {
  mkdirSync(path.dirname(sessionFilePath), {
    recursive: true,
    mode: 0o700,
  });

  const tempPath = `${sessionFilePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(tempPath, sessionFilePath);
    chmodSync(sessionFilePath, 0o600);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function getMemoizedRecord(runtime: RuntimeIdentity): CachedSupabaseSessionRecord | null {
  return SESSION_MEMORY_CACHE.get(runtime.memoKey) ?? null;
}

function memoizeRecord(runtime: RuntimeIdentity, record: CachedSupabaseSessionRecord): void {
  SESSION_MEMORY_CACHE.set(runtime.memoKey, record);
}

function dropMemoizedRecord(runtime: RuntimeIdentity): void {
  SESSION_MEMORY_CACHE.delete(runtime.memoKey);
}

async function withSessionOperationLock<T>(memoKey: string, task: () => Promise<T>): Promise<T> {
  const previous = SESSION_OPERATION_CHAINS.get(memoKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => gate);
  SESSION_OPERATION_CHAINS.set(memoKey, chain);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (SESSION_OPERATION_CHAINS.get(memoKey) === chain) {
      SESSION_OPERATION_CHAINS.delete(memoKey);
    }
  }
}

function createSupabaseAuthClient(
  runtime: RuntimeIdentity,
  publishableKey: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
) {
  return createClient(runtime.projectBaseUrl, publishableKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      fetch: createSupabaseFetch(fetchImpl, timeoutMs),
    },
  });
}

async function signInWithUserApiKey(options: {
  runtime: SupabaseRestRuntime;
  runtimeIdentity: RuntimeIdentity;
  fetchImpl: FetchLike;
  timeoutMs: number;
  now: Date;
}): Promise<CachedSupabaseSessionRecord> {
  const credentials = requireUserApiKeyCredentials(options.runtime.userApiKey);
  const authClient = createSupabaseAuthClient(
    options.runtimeIdentity,
    options.runtime.publishableKey,
    options.fetchImpl,
    options.timeoutMs,
  );
  const { data, error } = await authClient.auth.signInWithPassword({
    email: credentials.email,
    password: credentials.password,
  });

  if (error || !data.session) {
    throw new CliError('Failed to sign in with TIANGONG_LCA_API_KEY.', {
      code: 'SUPABASE_AUTH_SIGN_IN_FAILED',
      exitCode: 1,
      details: error?.message ?? 'Supabase auth session missing from sign-in response.',
    });
  }

  return buildCachedSessionRecord({
    runtime: options.runtimeIdentity,
    session: data.session,
    userEmail: trimToken(data.user?.email) || credentials.email,
    now: options.now,
  });
}

async function refreshWithRefreshToken(options: {
  runtime: SupabaseRestRuntime;
  runtimeIdentity: RuntimeIdentity;
  refreshToken: string;
  userEmail: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
  now: Date;
}): Promise<CachedSupabaseSessionRecord | null> {
  const normalizedRefreshToken = trimToken(options.refreshToken);
  if (!normalizedRefreshToken) {
    return null;
  }

  try {
    const authClient = createSupabaseAuthClient(
      options.runtimeIdentity,
      options.runtime.publishableKey,
      options.fetchImpl,
      options.timeoutMs,
    );
    const { data, error } = await authClient.auth.refreshSession({
      refresh_token: normalizedRefreshToken,
    });

    if (error || !data.session) {
      return null;
    }

    return buildCachedSessionRecord({
      runtime: options.runtimeIdentity,
      session: data.session,
      userEmail: trimToken(data.user?.email) || options.userEmail,
      now: options.now,
    });
  } catch {
    return null;
  }
}

async function resolveAndPersistSession(options: {
  runtime: SupabaseRestRuntime;
  runtimeIdentity: RuntimeIdentity;
  fetchImpl: FetchLike;
  timeoutMs: number;
  now: Date;
  forceRefresh: boolean;
}): Promise<ResolvedSupabaseUserSession> {
  const { runtime, runtimeIdentity } = options;
  const memoized = getMemoizedRecord(runtimeIdentity);
  if (
    !options.forceRefresh &&
    !runtime.forceReauth &&
    memoized &&
    recordMatchesRuntime(memoized, runtimeIdentity) &&
    isSessionFresh(memoized, options.now)
  ) {
    return toResolvedSession(memoized, runtimeIdentity, 'memory');
  }

  const cachedFromDisk =
    runtimeIdentity.sessionFilePath !== null
      ? readCachedSessionRecord(runtimeIdentity.sessionFilePath)
      : null;
  if (
    !options.forceRefresh &&
    !runtime.forceReauth &&
    cachedFromDisk &&
    recordMatchesRuntime(cachedFromDisk, runtimeIdentity) &&
    isSessionFresh(cachedFromDisk, options.now)
  ) {
    memoizeRecord(runtimeIdentity, cachedFromDisk);
    return toResolvedSession(cachedFromDisk, runtimeIdentity, 'cache');
  }

  if (!runtime.forceReauth) {
    const refreshCandidate =
      cachedFromDisk &&
      recordMatchesRuntime(cachedFromDisk, runtimeIdentity) &&
      trimToken(cachedFromDisk.refresh_token)
        ? cachedFromDisk
        : memoized &&
            recordMatchesRuntime(memoized, runtimeIdentity) &&
            trimToken(memoized.refresh_token)
          ? memoized
          : null;

    if (refreshCandidate) {
      const refreshed = await refreshWithRefreshToken({
        runtime,
        runtimeIdentity,
        refreshToken: refreshCandidate.refresh_token,
        userEmail: refreshCandidate.user_email,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
        now: options.now,
      });

      if (refreshed) {
        if (runtimeIdentity.sessionFilePath) {
          writeCachedSessionRecord(runtimeIdentity.sessionFilePath, refreshed);
        }
        memoizeRecord(runtimeIdentity, refreshed);
        return toResolvedSession(refreshed, runtimeIdentity, 'refresh');
      }
    }
  }

  const signedIn = await signInWithUserApiKey({
    runtime,
    runtimeIdentity,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    now: options.now,
  });

  if (runtimeIdentity.sessionFilePath) {
    writeCachedSessionRecord(runtimeIdentity.sessionFilePath, signedIn);
  }
  memoizeRecord(runtimeIdentity, signedIn);
  return toResolvedSession(signedIn, runtimeIdentity, 'signin');
}

export async function resolveSupabaseUserSession(options: {
  runtime: SupabaseRestRuntime;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  now?: Date;
  forceRefresh?: boolean;
}): Promise<ResolvedSupabaseUserSession> {
  const runtimeIdentity = buildRuntimeIdentity(options.runtime);
  const now = options.now ?? new Date();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const forceRefresh = Boolean(options.forceRefresh);

  if (!forceRefresh && !options.runtime.forceReauth) {
    const memoized = getMemoizedRecord(runtimeIdentity);
    if (
      memoized &&
      recordMatchesRuntime(memoized, runtimeIdentity) &&
      isSessionFresh(memoized, now)
    ) {
      return toResolvedSession(memoized, runtimeIdentity, 'memory');
    }

    if (runtimeIdentity.sessionFilePath) {
      const cached = readCachedSessionRecord(runtimeIdentity.sessionFilePath);
      if (cached && recordMatchesRuntime(cached, runtimeIdentity) && isSessionFresh(cached, now)) {
        memoizeRecord(runtimeIdentity, cached);
        return toResolvedSession(cached, runtimeIdentity, 'cache');
      }
    }
  }

  return withSessionOperationLock(runtimeIdentity.memoKey, async () => {
    if (runtimeIdentity.sessionFilePath) {
      return withStateFileLock(
        runtimeIdentity.sessionFilePath,
        {
          reason: forceRefresh ? 'refresh_supabase_user_session' : 'resolve_supabase_user_session',
        },
        () =>
          resolveAndPersistSession({
            runtime: options.runtime,
            runtimeIdentity,
            fetchImpl: options.fetchImpl,
            timeoutMs,
            now,
            forceRefresh,
          }),
      );
    }

    return resolveAndPersistSession({
      runtime: options.runtime,
      runtimeIdentity,
      fetchImpl: options.fetchImpl,
      timeoutMs,
      now,
      forceRefresh,
    });
  });
}

export function createSupabaseDataRuntime(options: {
  runtime: SupabaseRestRuntime;
  fetchImpl: FetchLike;
  timeoutMs?: number;
  now?: Date;
}): SupabaseDataRuntime {
  return {
    apiBaseUrl: options.runtime.apiBaseUrl,
    publishableKey: options.runtime.publishableKey,
    getAccessToken: async () =>
      (
        await resolveSupabaseUserSession({
          runtime: options.runtime,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
          now: options.now,
        })
      ).accessToken,
    refreshAccessToken: async () =>
      (
        await resolveSupabaseUserSession({
          runtime: options.runtime,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
          now: options.now,
          forceRefresh: true,
        })
      ).accessToken,
  };
}

export const __testInternals = {
  SESSION_MEMORY_CACHE,
  SESSION_OPERATION_CHAINS,
  buildCachedSessionRecord,
  buildRuntimeIdentity,
  computeExpiresAt,
  createSupabaseAuthClient,
  dropMemoizedRecord,
  getMemoizedRecord,
  isSessionFresh,
  memoizeRecord,
  parseCachedSessionRecord,
  readCachedSessionRecord,
  recordMatchesRuntime,
  refreshWithRefreshToken,
  resolveDefaultSessionFilePath,
  resolveAndPersistSession,
  resolveSessionFilePath,
  signInWithUserApiKey,
  withSessionOperationLock,
  writeCachedSessionRecord,
};
