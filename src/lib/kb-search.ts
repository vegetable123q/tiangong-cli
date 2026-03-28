import type { EnvSpec } from './env.js';
import { resolveEnv } from './env.js';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';
import { postJson } from './http.js';

export const KB_SEARCH_ENV_KEYS = {
  apiBaseUrl: 'TIANGONG_LCA_KB_SEARCH_API_BASE_URL',
  apiKey: 'TIANGONG_LCA_KB_SEARCH_API_KEY',
  region: 'TIANGONG_LCA_KB_SEARCH_REGION',
} as const;

export const KB_SEARCH_ENV_SPECS: EnvSpec[] = [
  {
    key: KB_SEARCH_ENV_KEYS.apiBaseUrl,
    required: true,
    description: 'TianGong AI edge function base URL for KB search',
  },
  {
    key: KB_SEARCH_ENV_KEYS.apiKey,
    required: true,
    description: 'TianGong AI edge function x-api-key for KB search',
  },
  {
    key: KB_SEARCH_ENV_KEYS.region,
    required: false,
    description: 'Target TianGong AI edge region for KB search',
    defaultValue: 'us-east-1',
  },
] as const;

export type KbSearchCorpus = 'esg' | 'sci' | 'patent' | 'report' | 'standard' | 'textbook';

export type KbSearchRuntimeEnv = {
  apiBaseUrl: string | null;
  apiKey: string | null;
  region: string | null;
};

export type ExecuteKbSearchOptions = {
  corpus: KbSearchCorpus;
  payload: unknown;
  env: KbSearchRuntimeEnv;
  timeoutMs: number;
  fetchImpl: FetchLike;
};

const KB_SEARCH_ENDPOINTS: Record<KbSearchCorpus, string> = {
  esg: 'esg_search',
  sci: 'sci_search',
  patent: 'patent_search',
  report: 'report_search',
  standard: 'standard_search',
  textbook: 'textbook_search',
};

function buildKbSearchUrl(apiBaseUrl: string, corpus: KbSearchCorpus): string {
  const endpoint = KB_SEARCH_ENDPOINTS[corpus];
  if (!endpoint) {
    throw new CliError(`Unsupported KB search corpus: ${corpus}`, {
      code: 'KB_SEARCH_UNSUPPORTED_CORPUS',
      exitCode: 2,
    });
  }

  return `${apiBaseUrl.replace(/\/+$/u, '')}/${endpoint}`;
}

function buildKbSearchHeaders(apiKey: string, region: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
  };

  if (region) {
    headers['x-region'] = region;
  }

  return headers;
}

export function readKbSearchRuntimeEnv(env: NodeJS.ProcessEnv): KbSearchRuntimeEnv {
  return {
    apiBaseUrl: resolveEnv(KB_SEARCH_ENV_SPECS[0], env).value,
    apiKey: resolveEnv(KB_SEARCH_ENV_SPECS[1], env).value,
    region: resolveEnv(KB_SEARCH_ENV_SPECS[2], env).value,
  };
}

export async function executeKbSearch(options: ExecuteKbSearchOptions): Promise<unknown> {
  if (!options.env.apiBaseUrl) {
    throw new CliError(`Missing KB search API base URL. Set ${KB_SEARCH_ENV_KEYS.apiBaseUrl}.`, {
      code: 'KB_SEARCH_API_BASE_URL_REQUIRED',
      exitCode: 2,
    });
  }

  if (!options.env.apiKey) {
    throw new CliError(`Missing KB search API key. Set ${KB_SEARCH_ENV_KEYS.apiKey}.`, {
      code: 'KB_SEARCH_API_KEY_REQUIRED',
      exitCode: 2,
    });
  }

  return postJson({
    url: buildKbSearchUrl(options.env.apiBaseUrl, options.corpus),
    headers: buildKbSearchHeaders(options.env.apiKey, options.env.region),
    body: options.payload,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
}
