import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runProcessRefreshReferences } from '../src/lib/process-refresh-references.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

function lang(text: string, langCode = 'en') {
  return { '@xml:lang': langCode, '#text': text };
}

function makeJsonResponse(options: {
  ok?: boolean;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: {
      get(name: string): string | null {
        const key = name.toLowerCase();
        if (options.headers && key in options.headers) {
          return options.headers[key] ?? null;
        }
        return key === 'content-type' ? 'application/json' : null;
      },
    },
    async text(): Promise<string> {
      if (typeof options.body === 'string') {
        return options.body;
      }
      return JSON.stringify(options.body ?? null);
    },
  };
}

function withSupabaseAuthBootstrap(fetchImpl: FetchLike): FetchLike {
  return async (url, init) => {
    if (isSupabaseAuthTokenUrl(String(url))) {
      return makeSupabaseAuthResponse({
        userId: 'user-1',
      });
    }

    return fetchImpl(String(url), init);
  };
}

function buildProcessPayload(flowId: string, flowVersion: string, shortDescription: string) {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          'common:UUID': 'proc-draft',
          name: {
            baseName: [lang('Draft process')],
            treatmentStandardsRoutes: [lang('draft route')],
            mixAndLocationTypes: [lang('draft mix')],
            functionalUnitFlowProperties: [lang('draft fu')],
          },
        },
      },
      exchanges: {
        exchange: [
          {
            referenceToFlowDataSet: {
              '@type': 'flow data set',
              '@refObjectId': flowId,
              '@version': flowVersion,
              'common:shortDescription': [lang(shortDescription)],
            },
          },
        ],
      },
      administrativeInformation: {
        publicationAndOwnership: {
          'common:dataSetVersion': '01.00.001',
        },
      },
    },
  };
}

function buildFlowPayload(baseName: string) {
  return {
    flowDataSet: {
      flowInformation: {
        dataSetInformation: {
          name: {
            baseName: [lang(baseName)],
            treatmentStandardsRoutes: [lang('hydration')],
            mixAndLocationTypes: [lang('at plant')],
            flowProperties: [lang('kg')],
          },
        },
      },
    },
  };
}

test('runProcessRefreshReferences dry-run refreshes reachable refs and skips public rows', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-refresh-'));
  try {
    const fetchImpl = withSupabaseAuthBootstrap(async (url) => {
      const parsed = new URL(String(url));

      if (parsed.pathname === '/auth/v1/user') {
        return makeJsonResponse({
          body: { id: 'user-1' },
        });
      }

      if (parsed.pathname === '/rest/v1/processes') {
        const select = parsed.searchParams.get('select');
        if (select === 'id,version,modified_at,state_code,model_id') {
          return makeJsonResponse({
            body: [
              {
                id: 'proc-draft',
                version: '01.00.001',
                modified_at: '2026-04-18T00:00:00.000Z',
                state_code: 0,
                model_id: 'model-1',
              },
              {
                id: 'proc-public',
                version: '01.00.001',
                modified_at: '2026-04-17T00:00:00.000Z',
                state_code: 100,
                model_id: null,
              },
            ],
            headers: {
              'content-type': 'application/json',
              'content-range': '0-1/2',
            },
          });
        }

        if (
          select === 'id,version,json,modified_at,state_code,model_id,user_id' &&
          parsed.searchParams.get('id') === 'eq.proc-draft'
        ) {
          return makeJsonResponse({
            body: [
              {
                id: 'proc-draft',
                version: '01.00.001',
                modified_at: '2026-04-18T00:00:00.000Z',
                state_code: 0,
                model_id: 'model-1',
                user_id: 'user-1',
                json: buildProcessPayload('flow-1', '01.00.000', 'Old flow short'),
              },
            ],
          });
        }
      }

      if (parsed.pathname === '/rest/v1/flows') {
        return makeJsonResponse({
          body: [
            {
              id: 'flow-1',
              version: '01.00.000',
              json: buildFlowPayload('Old flow'),
            },
            {
              id: 'flow-1',
              version: '01.00.002',
              json: buildFlowPayload('Updated flow'),
            },
          ],
        });
      }

      throw new Error(`Unexpected URL: ${String(url)}`);
    });

    const report = await runProcessRefreshReferences({
      outDir: tempDir,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
      }),
      fetchImpl,
      validateProcessPayloadImpl: () => ({
        ok: true,
        validator: 'test-validator',
        issue_count: 0,
        issues: [],
      }),
    });

    assert.equal(report.status, 'completed_process_reference_refresh');
    assert.equal(report.mode, 'dry_run');
    assert.equal(report.masked_user_email, 'us****@example.com');
    assert.deepEqual(report.counts, {
      manifest: 2,
      selected: 2,
      already_completed: 0,
      pending: 2,
      saved: 0,
      dry_run: 1,
      skipped: 1,
      validation_blocked: 0,
      errors: 0,
    });

    const progressRows = readFileSync(report.files.progress_jsonl, 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { status: string; touched_refs?: Array<{ to_version: string }> },
      );
    assert.equal(progressRows.length, 2);
    const dryRunRow = progressRows.find((row) => row.status === 'dry_run');
    assert.ok(dryRunRow);
    assert.equal(dryRunRow?.touched_refs?.[0]?.to_version, '01.00.002');
    const skippedRow = progressRows.find((row) => row.status === 'skipped');
    assert.ok(skippedRow);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runProcessRefreshReferences blocks unresolved refs before invoking writes', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-refresh-blocked-'));
  let writes = 0;

  try {
    const fetchImpl = withSupabaseAuthBootstrap(async (url) => {
      const parsed = new URL(String(url));

      if (parsed.pathname === '/auth/v1/user') {
        return makeJsonResponse({
          body: { id: 'user-1' },
        });
      }

      if (parsed.pathname === '/rest/v1/processes') {
        const select = parsed.searchParams.get('select');
        if (select === 'id,version,modified_at,state_code,model_id') {
          return makeJsonResponse({
            body: [
              {
                id: 'proc-draft',
                version: '01.00.001',
                modified_at: '2026-04-18T00:00:00.000Z',
                state_code: 0,
                model_id: 'model-1',
              },
            ],
            headers: {
              'content-type': 'application/json',
              'content-range': '0-0/1',
            },
          });
        }

        if (
          select === 'id,version,json,modified_at,state_code,model_id,user_id' &&
          parsed.searchParams.get('id') === 'eq.proc-draft'
        ) {
          return makeJsonResponse({
            body: [
              {
                id: 'proc-draft',
                version: '01.00.001',
                modified_at: '2026-04-18T00:00:00.000Z',
                state_code: 0,
                model_id: 'model-1',
                user_id: 'user-1',
                json: buildProcessPayload('flow-missing', '01.00.000', 'Missing flow'),
              },
            ],
          });
        }
      }

      if (parsed.pathname === '/rest/v1/flows') {
        return makeJsonResponse({
          body: [],
        });
      }

      throw new Error(`Unexpected URL: ${String(url)}`);
    });

    const report = await runProcessRefreshReferences({
      outDir: tempDir,
      apply: true,
      env: buildSupabaseTestEnv({
        TIANGONG_LCA_API_BASE_URL: 'https://example.supabase.co/functions/v1',
      }),
      fetchImpl,
      validateProcessPayloadImpl: () => ({
        ok: true,
        validator: 'test-validator',
        issue_count: 0,
        issues: [],
      }),
      syncStateAwareProcessRecordImpl: async () => {
        writes += 1;
        return {
          status: 'success',
          operation: 'save_draft',
          write_path: 'cmd_dataset_save_draft',
          rpc_result: { ok: true },
          visible_row: {
            id: 'proc-draft',
            version: '01.00.001',
            user_id: 'user-1',
            state_code: 0,
          },
        };
      },
    });

    assert.equal(report.status, 'completed_process_reference_refresh');
    assert.equal(report.mode, 'apply');
    assert.equal(report.counts.saved, 0);
    assert.equal(report.counts.validation_blocked, 1);
    assert.equal(report.counts.errors, 0);
    assert.equal(writes, 0);

    const blockers = readFileSync(report.files.validation_blockers_jsonl, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { status: string; unresolved_count: number });
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0]?.status, 'validation_blocked');
    assert.equal(blockers[0]?.unresolved_count, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
