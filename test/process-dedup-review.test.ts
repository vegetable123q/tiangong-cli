import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcessDedupReview } from '../src/lib/process-dedup-review.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

type JsonRecord = Record<string, unknown>;

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function jsonResponse(payload: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name: string): string | null {
        return (
          headers[name.toLowerCase()] ??
          (name.toLowerCase() === 'content-type' ? 'application/json' : null)
        );
      },
    },
    text: async () => JSON.stringify(payload),
  };
}

function langEntries(en: string, zh: string): JsonRecord[] {
  return [
    { '@xml:lang': 'en', '#text': en },
    { '@xml:lang': 'zh', '#text': zh },
  ];
}

function flatExchange(options: {
  flowId: string;
  direction: 'Input' | 'Output';
  meanAmount: string;
  resultingAmount: string;
  shortDescriptionEn?: string;
  shortDescriptionZh?: string;
  exchangeInternalId?: string;
}): JsonRecord {
  return {
    exchange_internal_id: options.exchangeInternalId ?? `${options.flowId}-${options.direction}`,
    flow_id: options.flowId,
    direction: options.direction,
    mean_amount: options.meanAmount,
    resulting_amount: options.resultingAmount,
    flow_short_description_en: options.shortDescriptionEn ?? '',
    flow_short_description_zh: options.shortDescriptionZh ?? '',
  };
}

function remoteExchange(options: {
  flowId: string;
  direction: 'Input' | 'Output';
  meanAmount: string;
  resultingAmount: string;
  shortDescriptionEn?: string;
  shortDescriptionZh?: string;
  exchangeInternalId?: string;
}): JsonRecord {
  return {
    '@dataSetInternalID': options.exchangeInternalId ?? `${options.flowId}-${options.direction}`,
    exchangeDirection: options.direction,
    meanAmount: options.meanAmount,
    resultingAmount: options.resultingAmount,
    referenceToFlowDataSet: {
      '@refObjectId': options.flowId,
      '@version': '01.00.000',
      'common:shortDescription': langEntries(
        options.shortDescriptionEn ?? '',
        options.shortDescriptionZh ?? '',
      ),
    },
  };
}

function createRemoteProcessJson(
  nameEn: string,
  nameZh: string,
  exchanges: JsonRecord[],
): JsonRecord {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          name: {
            baseName: langEntries(nameEn, nameZh),
          },
        },
      },
      exchanges: {
        exchange: exchanges,
      },
    },
  };
}

const DUPLICATE_EXCHANGES = [
  flatExchange({
    flowId: 'flow-waste-paper',
    direction: 'Input',
    meanAmount: '1.0',
    resultingAmount: '1',
    shortDescriptionEn: 'waste paper',
    shortDescriptionZh: '废纸',
  }),
  flatExchange({
    flowId: 'flow-product',
    direction: 'Output',
    meanAmount: '1',
    resultingAmount: '1',
    shortDescriptionEn: 'waste paper',
    shortDescriptionZh: '废纸',
  }),
];

test('runProcessDedupReview analyzes grouped duplicate candidates locally', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-dedup-local-'));
  const inputPath = path.join(dir, 'dedup-input.json');
  const outDir = path.join(dir, 'artifacts');

  writeJson(inputPath, {
    source_label: 'manual-dedup-export',
    groups: [
      {
        group_id: 1,
        processes: [
          {
            process_id: 'proc-keep',
            version: '01.00.000',
            name_en: 'Waste paper collection',
            name_zh: '废纸收集',
            sheet_exchange_rows: DUPLICATE_EXCHANGES,
          },
          {
            process_id: 'proc-delete',
            version: '01.00.000',
            name_en: 'Wastepaper processing',
            name_zh: '废纸加工',
            sheet_exchange_rows: [...DUPLICATE_EXCHANGES].reverse(),
          },
        ],
      },
    ],
  });

  try {
    const report = await runProcessDedupReview({
      inputPath,
      outDir,
      skipRemote: true,
      now: new Date('2026-04-18T00:00:00.000Z'),
    });

    assert.equal(report.status, 'completed_process_dedup_review');
    assert.equal(report.group_count, 1);
    assert.equal(report.exact_duplicate_group_count, 1);
    assert.equal(report.remote_status.enabled, false);
    assert.equal(report.remote_status.reference_scan, 'skipped_by_flag');

    const duplicateGroups = JSON.parse(readFileSync(report.files.duplicate_groups, 'utf8')) as {
      groups: Array<{
        exact_duplicate: boolean;
        processes: Array<{ process_id: string; analysis_exchanges: unknown[] }>;
      }>;
    };
    const deletePlan = JSON.parse(readFileSync(report.files.delete_plan, 'utf8')) as {
      groups: Array<{
        keep: { process_id: string };
        delete: Array<{ process_id: string }>;
        confidence: string;
        notes: string[];
      }>;
    };

    assert.equal(duplicateGroups.groups[0]?.exact_duplicate, true);
    assert.equal(duplicateGroups.groups[0]?.processes[0]?.analysis_exchanges.length, 2);
    assert.equal(deletePlan.groups[0]?.keep.process_id, 'proc-keep');
    assert.deepEqual(
      deletePlan.groups[0]?.delete.map((entry) => entry.process_id),
      ['proc-delete'],
    );
    assert.equal(deletePlan.groups[0]?.confidence, 'high');
    assert.match(deletePlan.groups[0]?.notes.join('\n') ?? '', /normalized exchange signature/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessDedupReview enriches duplicate candidates with remote metadata and reference scans', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-dedup-remote-'));
  const inputPath = path.join(dir, 'dedup-input.json');
  const outDir = path.join(dir, 'artifacts');

  writeJson(inputPath, {
    source_label: 'remote-dedup-export',
    groups: {
      '1': {
        processes: [
          {
            process_id: 'proc-keep',
            version: '01.00.000',
            sheet_exchange_rows: DUPLICATE_EXCHANGES,
          },
          {
            process_id: 'proc-delete',
            version: '01.00.000',
            sheet_exchange_rows: [...DUPLICATE_EXCHANGES].reverse(),
          },
        ],
      },
    },
  });

  const remoteProcessRows = [
    {
      id: 'proc-delete',
      version: '01.00.000',
      state_code: 0,
      created_at: '2026-04-10T00:00:00.000Z',
      modified_at: '2026-04-16T00:00:00.000Z',
      user_id: 'user-1',
      team_id: 'team-1',
      model_id: 'model-delete',
      json: createRemoteProcessJson('Wastepaper processing', '废纸加工', [
        remoteExchange({
          flowId: 'flow-product',
          direction: 'Output',
          meanAmount: '1',
          resultingAmount: '1',
          shortDescriptionEn: 'waste paper',
          shortDescriptionZh: '废纸',
        }),
        remoteExchange({
          flowId: 'flow-waste-paper',
          direction: 'Input',
          meanAmount: '1.0',
          resultingAmount: '1',
          shortDescriptionEn: 'waste paper',
          shortDescriptionZh: '废纸',
        }),
      ]),
    },
    {
      id: 'proc-keep',
      version: '01.00.000',
      state_code: 0,
      created_at: '2026-04-09T00:00:00.000Z',
      modified_at: '2026-04-15T00:00:00.000Z',
      user_id: 'user-1',
      team_id: 'team-1',
      model_id: 'model-keep',
      json: createRemoteProcessJson('Waste paper collection', '废纸收集', [
        remoteExchange({
          flowId: 'flow-waste-paper',
          direction: 'Input',
          meanAmount: '1.0',
          resultingAmount: '1',
          shortDescriptionEn: 'waste paper',
          shortDescriptionZh: '废纸',
        }),
        remoteExchange({
          flowId: 'flow-product',
          direction: 'Output',
          meanAmount: '1',
          resultingAmount: '1',
          shortDescriptionEn: 'waste paper',
          shortDescriptionZh: '废纸',
        }),
      ]),
    },
  ];

  const fetchImpl = (async (input) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse({ userId: 'user-1' });
    }
    if (url.endsWith('/auth/v1/user')) {
      return jsonResponse({ id: 'user-1' });
    }
    if (
      url.includes('/rest/v1/processes?') &&
      url.includes('id=in.') &&
      !url.includes('user_id=eq.')
    ) {
      return jsonResponse(remoteProcessRows);
    }
    if (url.includes('/rest/v1/processes?') && url.includes('user_id=eq.user-1')) {
      return jsonResponse(
        [
          {
            id: 'proc-ref-1',
            version: '01.00.000',
            state_code: 0,
            user_id: 'user-1',
            model_id: 'ref-model',
            json: {
              downstream: {
                '@refObjectId': 'proc-keep',
              },
            },
          },
        ],
        {
          'content-type': 'application/json',
          'content-range': '0-0/1',
        },
      );
    }
    if (url.includes('/rest/v1/lifecyclemodels?') && url.includes('user_id=eq.user-1')) {
      return jsonResponse(
        [
          {
            id: 'lm-ref-1',
            version: '01.00.000',
            state_code: 0,
            user_id: 'user-1',
            json: {
              processLink: {
                '@refObjectId': 'proc-keep',
              },
            },
          },
        ],
        {
          'content-type': 'application/json',
          'content-range': '0-0/1',
        },
      );
    }

    throw new Error(`Unexpected URL: ${url}`);
  }) as FetchLike;

  try {
    const report = await runProcessDedupReview({
      inputPath,
      outDir,
      env: buildSupabaseTestEnv(),
      fetchImpl,
      now: new Date('2026-04-18T01:00:00.000Z'),
    });

    assert.equal(report.remote_status.enabled, true);
    assert.equal(report.remote_status.loaded, 2);
    assert.equal(report.remote_status.reference_scan, 'current_user_completed');
    assert.equal(report.files.remote_metadata !== null, true);
    assert.equal(report.files.current_user_reference_scan !== null, true);

    const deletePlan = JSON.parse(readFileSync(report.files.delete_plan, 'utf8')) as {
      groups: Array<{
        keep: { process_id: string };
        current_user_reference_hits: {
          keep_process_refs: number;
          keep_lifecyclemodel_refs: number;
          delete_refs: Record<string, { process_refs: number; lifecyclemodel_refs: number }>;
        };
      }>;
    };

    assert.equal(deletePlan.groups[0]?.keep.process_id, 'proc-keep');
    assert.equal(deletePlan.groups[0]?.current_user_reference_hits.keep_process_refs, 1);
    assert.equal(deletePlan.groups[0]?.current_user_reference_hits.keep_lifecyclemodel_refs, 1);
    assert.deepEqual(deletePlan.groups[0]?.current_user_reference_hits.delete_refs, {
      'proc-delete': {
        process_refs: 0,
        lifecyclemodel_refs: 0,
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
