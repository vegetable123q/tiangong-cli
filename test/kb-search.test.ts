import assert from 'node:assert/strict';
import test from 'node:test';
import { CliError } from '../src/lib/errors.js';
import { executeKbSearch, readKbSearchRuntimeEnv } from '../src/lib/kb-search.js';

test('readKbSearchRuntimeEnv returns canonical KB search env keys', () => {
  const runtime = readKbSearchRuntimeEnv({
    TIANGONG_LCA_KB_SEARCH_API_BASE_URL: 'https://edge.example/functions/v1',
    TIANGONG_LCA_KB_SEARCH_API_KEY: 'secret-token',
  });

  assert.deepEqual(runtime, {
    apiBaseUrl: 'https://edge.example/functions/v1',
    apiKey: 'secret-token',
    region: 'us-east-1',
  });
});

test('executeKbSearch posts JSON to the selected edge function with x-api-key and x-region', async () => {
  const captured: { url?: string; init?: RequestInit } = {};

  const payload = await executeKbSearch({
    corpus: 'sci',
    payload: {
      query: 'industrial ecology',
      topK: 3,
      extK: 1,
    },
    env: {
      apiBaseUrl: 'https://edge.example/functions/v1/',
      apiKey: 'secret-token',
      region: 'us-east-1',
    },
    timeoutMs: 20,
    fetchImpl: async (url, init) => {
      captured.url = url;
      captured.init = init;
      return {
        ok: true,
        status: 200,
        headers: {
          get: () => 'application/json',
        },
        text: async () => '{"items":[1,2,3]}',
      };
    },
  });

  assert.deepEqual(payload, { items: [1, 2, 3] });
  assert.equal(captured.url, 'https://edge.example/functions/v1/sci_search');
  assert.deepEqual(captured.init?.headers, {
    'Content-Type': 'application/json',
    'x-api-key': 'secret-token',
    'x-region': 'us-east-1',
  });
  assert.equal(captured.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(captured.init?.body)), {
    query: 'industrial ecology',
    topK: 3,
    extK: 1,
  });
});

test('executeKbSearch omits x-region when it is not set and allows text payloads', async () => {
  const captured: { url?: string; init?: RequestInit } = {};

  const payload = await executeKbSearch({
    corpus: 'textbook',
    payload: {
      query: '减排',
      filter: {
        isbn_number: ['9787030641274'],
      },
    },
    env: {
      apiBaseUrl: 'https://edge.example/functions/v1',
      apiKey: 'secret-token',
      region: null,
    },
    timeoutMs: 20,
    fetchImpl: async (url, init) => {
      captured.url = url;
      captured.init = init;
      return {
        ok: true,
        status: 200,
        headers: {
          get: () => null,
        },
        text: async () => 'ok',
      };
    },
  });

  assert.equal(payload, 'ok');
  assert.equal(captured.url, 'https://edge.example/functions/v1/textbook_search');
  assert.deepEqual(captured.init?.headers, {
    'Content-Type': 'application/json',
    'x-api-key': 'secret-token',
  });
});

test('executeKbSearch validates required runtime config and unsupported corpus', async () => {
  await assert.rejects(
    () =>
      executeKbSearch({
        corpus: 'esg',
        payload: { query: 'co2' },
        env: {
          apiBaseUrl: null,
          apiKey: 'secret-token',
          region: 'us-east-1',
        },
        timeoutMs: 20,
        fetchImpl: async () => {
          throw new Error('should not fetch');
        },
      }),
    /TIANGONG_LCA_KB_SEARCH_API_BASE_URL/u,
  );

  await assert.rejects(
    () =>
      executeKbSearch({
        corpus: 'esg',
        payload: { query: 'co2' },
        env: {
          apiBaseUrl: 'https://edge.example/functions/v1',
          apiKey: null,
          region: 'us-east-1',
        },
        timeoutMs: 20,
        fetchImpl: async () => {
          throw new Error('should not fetch');
        },
      }),
    /TIANGONG_LCA_KB_SEARCH_API_KEY/u,
  );

  await assert.rejects(
    () =>
      executeKbSearch({
        corpus: 'unknown' as never,
        payload: { query: 'co2' },
        env: {
          apiBaseUrl: 'https://edge.example/functions/v1',
          apiKey: 'secret-token',
          region: 'us-east-1',
        },
        timeoutMs: 20,
        fetchImpl: async () => {
          throw new Error('should not fetch');
        },
      }),
    /Unsupported KB search corpus/u,
  );
});

test('executeKbSearch surfaces remote HTTP and invalid JSON failures', async () => {
  await assert.rejects(
    () =>
      executeKbSearch({
        corpus: 'report',
        payload: { query: 'flood risk' },
        env: {
          apiBaseUrl: 'https://edge.example/functions/v1',
          apiKey: 'secret-token',
          region: 'us-east-1',
        },
        timeoutMs: 20,
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          headers: {
            get: () => 'application/json',
          },
          text: async () => '{"detail":"boom"}',
        }),
      }),
    (error: unknown) => {
      assert.equal(error instanceof CliError, true);
      assert.equal((error as CliError).code, 'REMOTE_REQUEST_FAILED');
      return true;
    },
  );

  await assert.rejects(
    () =>
      executeKbSearch({
        corpus: 'standard',
        payload: { query: 'so2' },
        env: {
          apiBaseUrl: 'https://edge.example/functions/v1',
          apiKey: 'secret-token',
          region: 'us-east-1',
        },
        timeoutMs: 20,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: {
            get: () => 'application/json',
          },
          text: async () => '{invalid-json',
        }),
      }),
    /not valid JSON/u,
  );
});
