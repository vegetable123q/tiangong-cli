import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { EnvSpec } from './env.js';
import { resolveEnv } from './env.js';
import { CliError } from './errors.js';
import type { FetchLike } from './http.js';

export const UNSTRUCTURED_ENV_KEYS = {
  apiBaseUrl: 'TIANGONG_LCA_UNSTRUCTURED_API_BASE_URL',
  apiKey: 'TIANGONG_LCA_UNSTRUCTURED_API_KEY',
  provider: 'TIANGONG_LCA_UNSTRUCTURED_PROVIDER',
  model: 'TIANGONG_LCA_UNSTRUCTURED_MODEL',
  chunkType: 'TIANGONG_LCA_UNSTRUCTURED_CHUNK_TYPE',
  returnTxt: 'TIANGONG_LCA_UNSTRUCTURED_RETURN_TXT',
} as const;

export const UNSTRUCTURED_ENV_SPECS: EnvSpec[] = [
  {
    key: UNSTRUCTURED_ENV_KEYS.apiBaseUrl,
    required: true,
    description: 'TianGong unstructured service base URL',
  },
  {
    key: UNSTRUCTURED_ENV_KEYS.apiKey,
    required: true,
    description: 'TianGong unstructured service API key',
  },
  {
    key: UNSTRUCTURED_ENV_KEYS.provider,
    required: false,
    description: 'Preferred unstructured vision provider',
  },
  {
    key: UNSTRUCTURED_ENV_KEYS.model,
    required: false,
    description: 'Preferred unstructured vision model',
  },
  {
    key: UNSTRUCTURED_ENV_KEYS.chunkType,
    required: false,
    description: 'Default chunk_type query flag for unstructured parsing',
    defaultValue: 'false',
  },
  {
    key: UNSTRUCTURED_ENV_KEYS.returnTxt,
    required: false,
    description: 'Default return_txt query flag for unstructured parsing',
    defaultValue: 'true',
  },
] as const;

export type UnstructuredRuntimeEnv = {
  apiBaseUrl: string | null;
  apiKey: string | null;
  provider: string | null;
  model: string | null;
  chunkType: boolean;
  returnTxt: boolean;
};

export type ParseUnstructuredDocumentOptions = {
  env: UnstructuredRuntimeEnv;
  filePath: string;
  prompt?: string | null;
  provider?: string | null;
  model?: string | null;
  chunkType?: boolean;
  returnTxt?: boolean;
  timeoutMs: number;
  fetchImpl: FetchLike;
};

function parseBooleanFlag(value: string, fallback: boolean): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }

  return fallback;
}

function requireUnstructuredRuntime(env: UnstructuredRuntimeEnv): {
  apiBaseUrl: string;
  apiKey: string;
} {
  if (!env.apiBaseUrl) {
    throw new CliError(
      `Missing unstructured API base URL. Set ${UNSTRUCTURED_ENV_KEYS.apiBaseUrl}.`,
      {
        code: 'UNSTRUCTURED_API_BASE_URL_REQUIRED',
        exitCode: 2,
      },
    );
  }

  if (!env.apiKey) {
    throw new CliError(`Missing unstructured API key. Set ${UNSTRUCTURED_ENV_KEYS.apiKey}.`, {
      code: 'UNSTRUCTURED_API_KEY_REQUIRED',
      exitCode: 2,
    });
  }

  return {
    apiBaseUrl: env.apiBaseUrl,
    apiKey: env.apiKey,
  };
}

function buildUnstructuredUrl(
  apiBaseUrl: string,
  options: {
    chunkType: boolean;
    returnTxt: boolean;
  },
): string {
  const url = new URL(`${apiBaseUrl.replace(/\/+$/u, '')}/mineru_with_images`);
  url.searchParams.set('chunk_type', options.chunkType ? 'true' : 'false');
  url.searchParams.set('return_txt', options.returnTxt ? 'true' : 'false');
  return url.toString();
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function guessContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.md':
    case '.markdown':
      return 'text/markdown';
    default:
      return 'application/octet-stream';
  }
}

async function parseJsonResponse(response: Awaited<ReturnType<FetchLike>>): Promise<unknown> {
  const rawText = await response.text();
  const contentType = response.headers.get('content-type') ?? '';

  if (!contentType.toLowerCase().includes('application/json')) {
    throw new CliError('Unstructured service response was not valid JSON.', {
      code: 'UNSTRUCTURED_INVALID_JSON',
      exitCode: 1,
      details: rawText,
    });
  }

  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw new CliError('Unstructured service response was not valid JSON.', {
      code: 'UNSTRUCTURED_INVALID_JSON',
      exitCode: 1,
      details: String(error),
    });
  }
}

export function readUnstructuredRuntimeEnv(env: NodeJS.ProcessEnv): UnstructuredRuntimeEnv {
  const chunkTypeValue = resolveEnv(UNSTRUCTURED_ENV_SPECS[4], env).value as string;
  const returnTxtValue = resolveEnv(UNSTRUCTURED_ENV_SPECS[5], env).value as string;

  return {
    apiBaseUrl: resolveEnv(UNSTRUCTURED_ENV_SPECS[0], env).value,
    apiKey: resolveEnv(UNSTRUCTURED_ENV_SPECS[1], env).value,
    provider: resolveEnv(UNSTRUCTURED_ENV_SPECS[2], env).value,
    model: resolveEnv(UNSTRUCTURED_ENV_SPECS[3], env).value,
    chunkType: parseBooleanFlag(chunkTypeValue, false),
    returnTxt: parseBooleanFlag(returnTxtValue, true),
  };
}

export async function parseUnstructuredDocument(
  options: ParseUnstructuredDocumentOptions,
): Promise<unknown> {
  const runtime = requireUnstructuredRuntime(options.env);
  const filePath = normalizeOptionalText(options.filePath);
  if (!filePath) {
    throw new CliError('Missing unstructured input file path.', {
      code: 'UNSTRUCTURED_INPUT_REQUIRED',
      exitCode: 2,
    });
  }

  const fileName = path.basename(filePath);
  let fileContents: Uint8Array;
  try {
    fileContents = readFileSync(filePath);
  } catch (error) {
    throw new CliError(`Unstructured input file not found: ${filePath}`, {
      code: 'UNSTRUCTURED_INPUT_NOT_FOUND',
      exitCode: 2,
      details: String(error),
    });
  }

  const chunkType = options.chunkType ?? options.env.chunkType;
  const returnTxt = options.returnTxt ?? options.env.returnTxt;
  const provider = normalizeOptionalText(options.provider) ?? options.env.provider;
  const model = normalizeOptionalText(options.model) ?? options.env.model;
  const prompt = normalizeOptionalText(options.prompt);
  const url = buildUnstructuredUrl(runtime.apiBaseUrl, {
    chunkType,
    returnTxt,
  });

  const body = new FormData();
  const fileBytes = new Uint8Array(fileContents);
  body.set(
    'file',
    new File([fileBytes], fileName, {
      type: guessContentType(filePath),
    }),
  );
  if (provider) {
    body.set('provider', provider);
  }
  if (model) {
    body.set('model', model);
  }
  if (prompt) {
    body.set('prompt', prompt);
  }

  const response = await options.fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${runtime.apiKey}`,
    },
    body,
    signal: AbortSignal.timeout(options.timeoutMs),
  });

  const payload = await parseJsonResponse(response);
  if (!response.ok) {
    throw new CliError(`Unstructured request failed with HTTP ${response.status}.`, {
      code: 'UNSTRUCTURED_REQUEST_FAILED',
      exitCode: 1,
      details: payload,
    });
  }

  return payload;
}
