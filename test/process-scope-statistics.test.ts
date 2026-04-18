import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcessScopeStatistics } from '../src/lib/process-scope-statistics.js';
import type { FetchLike } from '../src/lib/http.js';
import {
  buildSupabaseTestEnv,
  isSupabaseAuthTokenUrl,
  makeSupabaseAuthResponse,
} from './helpers/supabase-auth.js';

type JsonRecord = Record<string, unknown>;

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

function createProcessPayload(options: {
  primaryDomain: string;
  leafDomain: string;
  route?: string;
  routeZh?: string;
  technology: string;
  technologyZh: string;
  typeOfDataSet: string;
  referenceFlowId: string;
  referenceFlowVersion?: string;
  referenceFlowLabelEn: string;
  referenceFlowLabelZh: string;
  baseNameEn: string;
  baseNameZh: string;
}): JsonRecord {
  return {
    processDataSet: {
      processInformation: {
        dataSetInformation: {
          name: {
            baseName: langEntries(options.baseNameEn, options.baseNameZh),
            treatmentStandardsRoutes: options.route
              ? langEntries(options.route, options.routeZh ?? options.route)
              : '',
          },
          classificationInformation: {
            'common:classification': {
              'common:class': [
                {
                  '@level': '1',
                  '#text': options.primaryDomain,
                },
                {
                  '@level': '2',
                  '#text': options.leafDomain,
                },
              ],
            },
          },
        },
        technology: {
          technologyDescriptionAndIncludedProcesses: langEntries(
            options.technology,
            options.technologyZh,
          ),
        },
        quantitativeReference: {
          referenceToReferenceFlow: '1',
        },
      },
      modellingAndValidation: {
        LCIMethodAndAllocation: {
          typeOfDataSet: options.typeOfDataSet,
        },
      },
      exchanges: {
        exchange: [
          {
            '@dataSetInternalID': '1',
            exchangeDirection: 'Output',
            meanAmount: '1',
            resultingAmount: '1',
            referenceToFlowDataSet: {
              '@refObjectId': options.referenceFlowId,
              '@version': options.referenceFlowVersion ?? '01.00.000',
              'common:shortDescription': langEntries(
                options.referenceFlowLabelEn,
                options.referenceFlowLabelZh,
              ),
            },
          },
        ],
      },
    },
  };
}

test('runProcessScopeStatistics fetches visible process rows and writes summary artifacts', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-scope-'));

  const fetchImpl = (async (input) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse();
    }
    if (url.includes('/rest/v1/processes?')) {
      return jsonResponse(
        [
          {
            id: 'proc-1',
            version: '01.00.000',
            state_code: 100,
            user_id: 'user-1',
            modified_at: '2026-04-17T00:00:00.000Z',
            model_id: 'model-1',
            json: createProcessPayload({
              primaryDomain: 'Waste management',
              leafDomain: 'Paper sorting',
              route: 'Sorting',
              routeZh: '分选',
              technology: 'Sorting line. downstream note',
              technologyZh: '分选线。附加说明',
              typeOfDataSet: 'Unit process, single operation',
              referenceFlowId: 'flow-product-1',
              referenceFlowLabelEn: 'sorted waste paper',
              referenceFlowLabelZh: '分选废纸',
              baseNameEn: 'Waste paper sorting',
              baseNameZh: '废纸分选',
            }),
          },
          {
            id: 'proc-2',
            version: '01.00.000',
            state_code: 100,
            user_id: 'user-2',
            modified_at: '2026-04-17T01:00:00.000Z',
            model_id: 'model-2',
            json: createProcessPayload({
              primaryDomain: 'Waste management',
              leafDomain: 'Transport',
              technology: 'Transport service. additional note',
              technologyZh: '运输服务。附加说明',
              typeOfDataSet: 'Aggregated process',
              referenceFlowId: '',
              referenceFlowLabelEn: 'transport service',
              referenceFlowLabelZh: '运输服务',
              baseNameEn: 'Waste transfer',
              baseNameZh: '废弃物转运',
            }),
          },
        ],
        {
          'content-type': 'application/json',
          'content-range': '0-1/2',
        },
      );
    }

    throw new Error(`Unexpected URL: ${url}`);
  }) as FetchLike;

  try {
    const report = await runProcessScopeStatistics({
      outDir: dir,
      scope: 'visible',
      stateCodes: [100],
      env: buildSupabaseTestEnv(),
      fetchImpl,
      now: new Date('2026-04-18T00:00:00.000Z'),
    });

    assert.equal(report.status, 'completed_process_scope_statistics');
    assert.equal(report.total_process_rows, 2);
    assert.equal(report.domain_count_primary, 1);
    assert.equal(report.domain_count_leaf, 2);
    assert.equal(report.craft_count, 2);
    assert.equal(report.unit_process_rows, 1);
    assert.equal(report.product_count, 2);
    assert.equal(existsSync(report.files.process_scope_summary), true);
    assert.equal(existsSync(report.files.report), true);
    assert.equal(existsSync(report.files.report_zh), true);

    const summary = JSON.parse(readFileSync(report.files.process_scope_summary, 'utf8')) as {
      total_process_rows: number;
      rows_by_state_code: Record<string, number>;
      distinct_visible_owner_user_ids: number;
      products_with_flow_id: number;
      products_without_flow_id: number;
      rows_missing_reference_exchange: number;
    };

    assert.equal(summary.total_process_rows, 2);
    assert.deepEqual(summary.rows_by_state_code, { '100': 2 });
    assert.equal(summary.distinct_visible_owner_user_ids, 2);
    assert.equal(summary.products_with_flow_id, 1);
    assert.equal(summary.products_without_flow_id, 1);
    assert.equal(summary.rows_missing_reference_exchange, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runProcessScopeStatistics can reuse a prior snapshot without remote fetches', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-scope-reuse-'));

  const fetchImpl = (async (input) => {
    const url = String(input);
    if (isSupabaseAuthTokenUrl(url)) {
      return makeSupabaseAuthResponse();
    }
    if (url.includes('/rest/v1/processes?')) {
      return jsonResponse(
        [
          {
            id: 'proc-1',
            version: '01.00.000',
            state_code: 100,
            user_id: 'user-1',
            modified_at: '2026-04-17T00:00:00.000Z',
            model_id: 'model-1',
            json: createProcessPayload({
              primaryDomain: 'Waste management',
              leafDomain: 'Paper sorting',
              route: 'Sorting',
              routeZh: '分选',
              technology: 'Sorting line. downstream note',
              technologyZh: '分选线。附加说明',
              typeOfDataSet: 'Unit process, single operation',
              referenceFlowId: 'flow-product-1',
              referenceFlowLabelEn: 'sorted waste paper',
              referenceFlowLabelZh: '分选废纸',
              baseNameEn: 'Waste paper sorting',
              baseNameZh: '废纸分选',
            }),
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
    const first = await runProcessScopeStatistics({
      outDir: dir,
      stateCodes: [100],
      env: buildSupabaseTestEnv(),
      fetchImpl,
      now: new Date('2026-04-18T01:00:00.000Z'),
    });
    assert.equal(first.total_process_rows, 1);

    const reused = await runProcessScopeStatistics({
      outDir: dir,
      stateCodes: [100],
      reuseSnapshot: true,
      fetchImpl: (async () => {
        throw new Error('reuseSnapshot should not fetch');
      }) as FetchLike,
      now: new Date('2026-04-18T02:00:00.000Z'),
    });

    assert.equal(reused.total_process_rows, 1);
    const summary = JSON.parse(readFileSync(reused.files.process_scope_summary, 'utf8')) as {
      total_process_rows: number;
      total_rows_reported_by_remote: number | null;
    };
    assert.equal(summary.total_process_rows, 1);
    assert.equal(summary.total_rows_reported_by_remote, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
