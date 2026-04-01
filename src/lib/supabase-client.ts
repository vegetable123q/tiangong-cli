import { createClient, type PostgrestError } from '@supabase/supabase-js';
import { CliError } from './errors.js';
import type { FetchLike, ResponseLike } from './http.js';

export type SupabaseRestRuntime = {
  apiBaseUrl: string;
  apiKey: string;
};

function trimToken(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function requireSupabaseRestRuntime(env: NodeJS.ProcessEnv): SupabaseRestRuntime {
  const apiBaseUrl = trimToken(env.TIANGONG_LCA_API_BASE_URL);
  const apiKey = trimToken(env.TIANGONG_LCA_API_KEY);
  const missing: string[] = [];

  if (!apiBaseUrl) {
    missing.push('TIANGONG_LCA_API_BASE_URL');
  }

  if (!apiKey) {
    missing.push('TIANGONG_LCA_API_KEY');
  }

  if (missing.length > 0) {
    throw new CliError(`Missing Supabase REST runtime env: ${missing.join(', ')}`, {
      code: 'SUPABASE_REST_ENV_REQUIRED',
      exitCode: 2,
      details: { missing },
    });
  }

  return {
    apiBaseUrl,
    apiKey,
  };
}

function normalizeBaseUrl(apiBaseUrl: string): string {
  const normalized = apiBaseUrl.trim().replace(/\/+$/u, '');
  if (!normalized) {
    throw new CliError('Cannot derive Supabase URLs from an empty API base URL.', {
      code: 'SUPABASE_REST_BASE_URL_INVALID',
      exitCode: 2,
    });
  }
  return normalized;
}

export function deriveSupabaseProjectBaseUrl(apiBaseUrl: string): string {
  const normalized = normalizeBaseUrl(apiBaseUrl);

  if (normalized.endsWith('/functions/v1')) {
    return normalized.replace(/\/functions\/v1$/u, '');
  }

  if (normalized.endsWith('/rest/v1')) {
    return normalized.replace(/\/rest\/v1$/u, '');
  }

  if (/^https?:\/\/[^/]+$/u.test(normalized)) {
    return normalized;
  }

  throw new CliError(
    'Cannot derive a Supabase project base URL from TIANGONG_LCA_API_BASE_URL. Use a Supabase project base URL, a /functions/v1 base URL, or a /rest/v1 base URL.',
    {
      code: 'SUPABASE_REST_BASE_URL_INVALID',
      exitCode: 2,
      details: normalized,
    },
  );
}

export function deriveSupabaseRestBaseUrl(apiBaseUrl: string): string {
  return `${deriveSupabaseProjectBaseUrl(apiBaseUrl)}/rest/v1`;
}

function mergeSignals(signal: AbortSignal | null | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export function buildSupabaseAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
    apikey: apiKey,
  };
}

async function toResponse(
  responseLike: ResponseLike,
  method: string | undefined,
): Promise<Response> {
  if (responseLike instanceof Response) {
    return responseLike;
  }

  const body = await responseLike.text();
  const contentType = responseLike.headers.get('content-type') ?? '';
  const normalizedBody =
    responseLike.ok &&
    method !== undefined &&
    !['GET', 'HEAD'].includes(method.toUpperCase()) &&
    body.length > 0 &&
    !contentType.includes('application/json')
      ? ''
      : body;
  const headers = new Headers();
  for (const headerName of ['content-type', 'content-range', 'location']) {
    const value = responseLike.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }

  return new Response(normalizedBody, {
    status: responseLike.status,
    headers,
  });
}

export function createSupabaseFetch(fetchImpl: FetchLike, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    let responseLike: ResponseLike;
    try {
      responseLike = await fetchImpl(url, {
        ...init,
        signal: mergeSignals(init?.signal, timeoutMs),
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    return toResponse(responseLike, init?.method);
  };
}

type SupabaseQueryResult<T> = {
  data: T | null;
  error: PostgrestError | null;
  status: number;
};

function formatPostgrestError(error: PostgrestError): {
  code: string | null;
  message: string;
  details: string | null;
  hint: string | null;
} {
  return {
    code: typeof error.code === 'string' ? error.code : null,
    message: error.message,
    details: typeof error.details === 'string' ? error.details : null,
    hint: typeof error.hint === 'string' ? error.hint : null,
  };
}

export async function runSupabaseArrayQuery<T>(
  queryPromise: PromiseLike<SupabaseQueryResult<T[]>>,
  sourceUrl: string,
): Promise<T[]> {
  const data = await runSupabaseQuery(queryPromise, sourceUrl);
  return (data ?? []) as T[];
}

export async function runSupabaseQuery<T>(
  queryPromise: PromiseLike<SupabaseQueryResult<T>>,
  sourceUrl: string,
): Promise<T | null> {
  try {
    const result = await queryPromise;
    if (result.error) {
      if (
        result.status === 0 &&
        result.error.code === '' &&
        /^SyntaxError:/u.test(result.error.message)
      ) {
        throw new CliError(`Remote response was not valid JSON for ${sourceUrl}`, {
          code: 'REMOTE_INVALID_JSON',
          exitCode: 1,
          details: result.error.details || result.error.message,
        });
      }

      throw new CliError(`HTTP ${result.status} returned from ${sourceUrl}`, {
        code: 'REMOTE_REQUEST_FAILED',
        exitCode: 1,
        details: formatPostgrestError(result.error),
      });
    }
    return result.data;
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    if (error instanceof SyntaxError) {
      throw new CliError(`Remote response was not valid JSON for ${sourceUrl}`, {
        code: 'REMOTE_INVALID_JSON',
        exitCode: 1,
        details: error.message,
      });
    }

    throw new CliError(`Supabase request failed for ${sourceUrl}`, {
      code: 'REMOTE_REQUEST_FAILED',
      exitCode: 1,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runSupabaseMutation(
  queryPromise: PromiseLike<{
    error: PostgrestError | null;
    status: number;
  }>,
  sourceUrl: string,
): Promise<void> {
  try {
    const result = await queryPromise;
    if (result.error) {
      if (
        result.status === 0 &&
        result.error.code === '' &&
        /^SyntaxError:/u.test(result.error.message)
      ) {
        throw new CliError(`Remote response was not valid JSON for ${sourceUrl}`, {
          code: 'REMOTE_INVALID_JSON',
          exitCode: 1,
          details: result.error.details || result.error.message,
        });
      }

      throw new CliError(`HTTP ${result.status} returned from ${sourceUrl}`, {
        code: 'REMOTE_REQUEST_FAILED',
        exitCode: 1,
        details: formatPostgrestError(result.error),
      });
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }

    if (error instanceof SyntaxError) {
      throw new CliError(`Remote response was not valid JSON for ${sourceUrl}`, {
        code: 'REMOTE_INVALID_JSON',
        exitCode: 1,
        details: error.message,
      });
    }

    throw new CliError(`Supabase request failed for ${sourceUrl}`, {
      code: 'REMOTE_REQUEST_FAILED',
      exitCode: 1,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export function createSupabaseDataClient(
  runtime: SupabaseRestRuntime,
  fetchImpl: FetchLike,
  timeoutMs: number,
) {
  return {
    client: createClient(deriveSupabaseProjectBaseUrl(runtime.apiBaseUrl), runtime.apiKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: buildSupabaseAuthHeaders(runtime.apiKey),
        fetch: createSupabaseFetch(fetchImpl, timeoutMs),
      },
    }),
    restBaseUrl: deriveSupabaseRestBaseUrl(runtime.apiBaseUrl),
  };
}
