import type { ResponseLike } from '../../src/lib/http.js';

export type SupabaseTestSessionOptions = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  expiresIn?: number;
  email?: string;
  userId?: string;
};

function encodeUserApiKey(email: string, password: string): string {
  return Buffer.from(
    JSON.stringify({
      email,
      password,
    }),
    'utf8',
  ).toString('base64');
}

export function buildSupabaseTestEnv(
  overrides: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  const apiKeyOverride = overrides.TIANGONG_LCA_API_KEY;
  const resolvedApiKey =
    typeof apiKeyOverride === 'string'
      ? apiKeyOverride === ''
        ? ''
        : encodeUserApiKey('user@example.com', apiKeyOverride)
      : encodeUserApiKey('user@example.com', 'secret-password');

  return {
    TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
    TIANGONG_LCA_SUPABASE_PUBLISHABLE_KEY: 'sb-publishable-key',
    TIANGONG_LCA_SESSION_MEMORY_ONLY: '1',
    ...overrides,
    TIANGONG_LCA_API_KEY: resolvedApiKey,
  } as NodeJS.ProcessEnv;
}

export function isSupabaseAuthTokenUrl(url: string): boolean {
  return (
    url.includes('/auth/v1/token?grant_type=password') ||
    url.includes('/auth/v1/token?grant_type=refresh_token')
  );
}

export function makeSupabaseAuthResponse(options: SupabaseTestSessionOptions = {}): ResponseLike {
  const expiresAt = options.expiresAt ?? 4_102_444_800;
  const expiresIn = options.expiresIn ?? 3_600;
  const payload = {
    access_token: options.accessToken ?? 'access-token',
    refresh_token: options.refreshToken ?? 'refresh-token',
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: expiresAt,
    user: {
      id: options.userId ?? 'user-1',
      aud: 'authenticated',
      role: 'authenticated',
      email: options.email ?? 'user@example.com',
    },
  };

  return {
    ok: true,
    status: 200,
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === 'content-type' ? 'application/json' : null;
      },
    },
    async text(): Promise<string> {
      return JSON.stringify(payload);
    },
  };
}
