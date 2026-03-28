import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CliError } from '../src/lib/errors.js';
import { parseUnstructuredDocument, readUnstructuredRuntimeEnv } from '../src/lib/unstructured.js';

test('readUnstructuredRuntimeEnv returns canonical TianGong unstructured env keys', () => {
  const runtime = readUnstructuredRuntimeEnv({
    TIANGONG_LCA_UNSTRUCTURED_API_BASE_URL: 'https://thuenv.tiangong.world:7770',
    TIANGONG_LCA_UNSTRUCTURED_API_KEY: 'secret-token',
    TIANGONG_LCA_UNSTRUCTURED_PROVIDER: 'vllm',
    TIANGONG_LCA_UNSTRUCTURED_MODEL: 'Qwen/Qwen3.5-397B-A17B-GPTQ-Int4',
    TIANGONG_LCA_UNSTRUCTURED_CHUNK_TYPE: 'true',
    TIANGONG_LCA_UNSTRUCTURED_RETURN_TXT: 'false',
  });

  assert.deepEqual(runtime, {
    apiBaseUrl: 'https://thuenv.tiangong.world:7770',
    apiKey: 'secret-token',
    provider: 'vllm',
    model: 'Qwen/Qwen3.5-397B-A17B-GPTQ-Int4',
    chunkType: true,
    returnTxt: false,
  });
});

test('readUnstructuredRuntimeEnv applies boolean fallbacks for invalid values', () => {
  const runtime = readUnstructuredRuntimeEnv({
    TIANGONG_LCA_UNSTRUCTURED_API_BASE_URL: 'https://thuenv.tiangong.world:7770',
    TIANGONG_LCA_UNSTRUCTURED_API_KEY: 'secret-token',
    TIANGONG_LCA_UNSTRUCTURED_CHUNK_TYPE: 'not-bool',
    TIANGONG_LCA_UNSTRUCTURED_RETURN_TXT: '   ',
  });

  assert.equal(runtime.chunkType, false);
  assert.equal(runtime.returnTxt, true);
});

test('parseUnstructuredDocument posts file uploads to /mineru_with_images using canonical env defaults', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-unstructured-success-'));
  const filePath = path.join(dir, 'paper.pdf');
  writeFileSync(filePath, 'pdf-bytes', 'utf8');
  const captured: { url?: string; init?: RequestInit } = {};

  try {
    const payload = await parseUnstructuredDocument({
      env: {
        apiBaseUrl: 'https://thuenv.tiangong.world:7770/',
        apiKey: 'secret-token',
        provider: 'vllm',
        model: 'Qwen/Qwen3.5-397B-A17B-GPTQ-Int4',
        chunkType: false,
        returnTxt: true,
      },
      filePath,
      prompt: 'Extract supplementary information.',
      timeoutMs: 50,
      fetchImpl: async (url, init) => {
        captured.url = url;
        captured.init = init;
        return {
          ok: true,
          status: 200,
          headers: {
            get: () => 'application/json',
          },
          text: async () => '{"result":[{"text":"hello","page_number":1}],"txt":"hello"}',
        };
      },
    });

    assert.deepEqual(payload, {
      result: [{ text: 'hello', page_number: 1 }],
      txt: 'hello',
    });
    assert.equal(
      captured.url,
      'https://thuenv.tiangong.world:7770/mineru_with_images?chunk_type=false&return_txt=true',
    );
    assert.equal(captured.init?.method, 'POST');
    assert.deepEqual(captured.init?.headers, {
      Authorization: 'Bearer secret-token',
    });

    const form = captured.init?.body;
    assert.equal(form instanceof FormData, true);
    assert.equal((form as FormData).get('provider'), 'vllm');
    assert.equal((form as FormData).get('model'), 'Qwen/Qwen3.5-397B-A17B-GPTQ-Int4');
    assert.equal((form as FormData).get('prompt'), 'Extract supplementary information.');

    const file = (form as FormData).get('file');
    assert.equal(file instanceof File, true);
    assert.equal((file as File).name, 'paper.pdf');
    assert.equal((file as File).type, 'application/pdf');
    assert.equal(await (file as File).text(), 'pdf-bytes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseUnstructuredDocument supports explicit overrides and generic content types', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-unstructured-overrides-'));
  const filePath = path.join(dir, 'notes.bin');
  writeFileSync(filePath, 'raw', 'utf8');
  const captured: { url?: string; init?: RequestInit } = {};

  try {
    const payload = await parseUnstructuredDocument({
      env: {
        apiBaseUrl: 'https://thuenv.tiangong.world:7770',
        apiKey: 'secret-token',
        provider: null,
        model: null,
        chunkType: false,
        returnTxt: true,
      },
      filePath,
      provider: 'override-provider',
      model: 'override-model',
      chunkType: true,
      returnTxt: false,
      timeoutMs: 50,
      fetchImpl: async (url, init) => {
        captured.url = url;
        captured.init = init;
        return {
          ok: true,
          status: 200,
          headers: {
            get: () => 'application/json; charset=utf-8',
          },
          text: async () => '{"result":[]}',
        };
      },
    });

    assert.deepEqual(payload, { result: [] });
    assert.equal(
      captured.url,
      'https://thuenv.tiangong.world:7770/mineru_with_images?chunk_type=true&return_txt=false',
    );

    const form = captured.init?.body as FormData;
    const file = form.get('file');
    assert.equal((file as File).type, 'application/octet-stream');
    assert.equal(form.get('provider'), 'override-provider');
    assert.equal(form.get('model'), 'override-model');
    assert.equal(form.has('prompt'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseUnstructuredDocument maps common image extensions to image content types', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-unstructured-image-types-'));

  try {
    for (const [fileName, expectedType] of [
      ['figure.png', 'image/png'],
      ['photo.jpg', 'image/jpeg'],
    ] as const) {
      const filePath = path.join(dir, fileName);
      writeFileSync(filePath, 'img', 'utf8');
      let uploadedFile: File | undefined;

      await parseUnstructuredDocument({
        env: {
          apiBaseUrl: 'https://thuenv.tiangong.world:7770',
          apiKey: 'secret-token',
          provider: null,
          model: null,
          chunkType: false,
          returnTxt: true,
        },
        filePath,
        timeoutMs: 10,
        fetchImpl: async (_url, init) => {
          uploadedFile = (init?.body as FormData).get('file') as File;
          return {
            ok: true,
            status: 200,
            headers: {
              get: () => 'application/json',
            },
            text: async () => '{"result":[]}',
          };
        },
      });

      assert.ok(uploadedFile);
      assert.equal(uploadedFile.type, expectedType);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseUnstructuredDocument validates required runtime config and input path', async () => {
  await assert.rejects(
    () =>
      parseUnstructuredDocument({
        env: {
          apiBaseUrl: null,
          apiKey: 'secret-token',
          provider: null,
          model: null,
          chunkType: false,
          returnTxt: true,
        },
        filePath: '/tmp/file.pdf',
        timeoutMs: 10,
        fetchImpl: async () => {
          throw new Error('should not fetch');
        },
      }),
    /TIANGONG_LCA_UNSTRUCTURED_API_BASE_URL/u,
  );

  await assert.rejects(
    () =>
      parseUnstructuredDocument({
        env: {
          apiBaseUrl: 'https://thuenv.tiangong.world:7770',
          apiKey: null,
          provider: null,
          model: null,
          chunkType: false,
          returnTxt: true,
        },
        filePath: '/tmp/file.pdf',
        timeoutMs: 10,
        fetchImpl: async () => {
          throw new Error('should not fetch');
        },
      }),
    /TIANGONG_LCA_UNSTRUCTURED_API_KEY/u,
  );

  await assert.rejects(
    () =>
      parseUnstructuredDocument({
        env: {
          apiBaseUrl: 'https://thuenv.tiangong.world:7770',
          apiKey: 'secret-token',
          provider: null,
          model: null,
          chunkType: false,
          returnTxt: true,
        },
        filePath: '',
        timeoutMs: 10,
        fetchImpl: async () => {
          throw new Error('should not fetch');
        },
      }),
    /Missing unstructured input file path/u,
  );

  await assert.rejects(
    () =>
      parseUnstructuredDocument({
        env: {
          apiBaseUrl: 'https://thuenv.tiangong.world:7770',
          apiKey: 'secret-token',
          provider: null,
          model: null,
          chunkType: false,
          returnTxt: true,
        },
        filePath: '/tmp/missing-file.pdf',
        timeoutMs: 10,
        fetchImpl: async () => {
          throw new Error('should not fetch');
        },
      }),
    /Unstructured input file not found/u,
  );
});

test('parseUnstructuredDocument rejects invalid JSON responses and non-json content types', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-unstructured-invalid-json-'));
  const filePath = path.join(dir, 'paper.md');
  writeFileSync(filePath, '# hello', 'utf8');

  try {
    await assert.rejects(
      () =>
        parseUnstructuredDocument({
          env: {
            apiBaseUrl: 'https://thuenv.tiangong.world:7770',
            apiKey: 'secret-token',
            provider: null,
            model: null,
            chunkType: false,
            returnTxt: true,
          },
          filePath,
          timeoutMs: 10,
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: {
              get: () => 'text/plain',
            },
            text: async () => 'not-json',
          }),
        }),
      /not valid JSON/u,
    );

    await assert.rejects(
      () =>
        parseUnstructuredDocument({
          env: {
            apiBaseUrl: 'https://thuenv.tiangong.world:7770',
            apiKey: 'secret-token',
            provider: null,
            model: null,
            chunkType: false,
            returnTxt: true,
          },
          filePath,
          timeoutMs: 10,
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

    await assert.rejects(
      () =>
        parseUnstructuredDocument({
          env: {
            apiBaseUrl: 'https://thuenv.tiangong.world:7770',
            apiKey: 'secret-token',
            provider: null,
            model: null,
            chunkType: false,
            returnTxt: true,
          },
          filePath,
          timeoutMs: 10,
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: {
              get: () => null,
            },
            text: async () => '{"result":[]}',
          }),
        }),
      /not valid JSON/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseUnstructuredDocument surfaces HTTP failures with parsed payload details', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-unstructured-http-error-'));
  const filePath = path.join(dir, 'paper.jpeg');
  writeFileSync(filePath, 'img', 'utf8');

  try {
    await assert.rejects(
      () =>
        parseUnstructuredDocument({
          env: {
            apiBaseUrl: 'https://thuenv.tiangong.world:7770',
            apiKey: 'secret-token',
            provider: null,
            model: null,
            chunkType: false,
            returnTxt: true,
          },
          filePath,
          timeoutMs: 10,
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
        assert.equal((error as CliError).code, 'UNSTRUCTURED_REQUEST_FAILED');
        assert.deepEqual((error as CliError).details, { detail: 'boom' });
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
