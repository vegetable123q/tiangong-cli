import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  runProcessVerifyRows,
  type ProcessVerifyRowRecord,
} from '../src/lib/process-verify-rows.js';

function lang(text: string, langCode = 'en') {
  return { '@xml:lang': langCode, '#text': text };
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

test('runProcessVerifyRows accepts process list reports and writes invalid-row artifacts', async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-process-verify-rows-'));
  try {
    const rowsFile = path.join(tempDir, 'rows.json');
    writeFileSync(
      rowsFile,
      `${JSON.stringify(
        {
          rows: [
            {
              id: 'proc-valid',
              version: '01.00.001',
              process: {
                processDataSet: {
                  processInformation: {
                    dataSetInformation: {
                      'common:UUID': 'proc-valid',
                      name: {
                        baseName: [lang('Valid process')],
                        treatmentStandardsRoutes: [lang('route')],
                        mixAndLocationTypes: [lang('mix')],
                      },
                    },
                  },
                },
              },
            },
            {
              id: 'proc-invalid',
              version: '01.00.002',
              process: {
                test_invalid: true,
                processDataSet: {
                  processInformation: {
                    dataSetInformation: {
                      'common:UUID': 'proc-invalid',
                      name: {
                        baseName: [lang('Invalid process')],
                        treatmentStandardsRoutes: [lang('route')],
                      },
                    },
                  },
                },
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const report = await runProcessVerifyRows({
      rowsFile,
      outDir: tempDir,
      validateProcessPayloadImpl: (payload) =>
        payload.test_invalid === true
          ? {
              ok: false,
              validator: 'test-validator',
              issue_count: 2,
              issues: [
                {
                  path: 'processDataSet.processInformation',
                  message: 'Broken payload',
                  code: 'custom',
                },
                {
                  path: 'processDataSet.exchanges',
                  message: 'Missing exchanges',
                  code: 'custom',
                },
              ],
            }
          : {
              ok: true,
              validator: 'test-validator',
              issue_count: 0,
              issues: [],
            },
    });

    assert.equal(report.status, 'completed_with_invalid_process_rows');
    assert.equal(report.row_count, 2);
    assert.equal(report.invalid_count, 1);
    assert.equal(report.schema_invalid_count, 1);
    assert.equal(report.missing_required_name_field_count, 1);
    assert.deepEqual(report.invalid_rows, [
      {
        id: 'proc-invalid',
        version: '01.00.002',
        row_index: 1,
        missing_required_fields: ['mixAndLocationTypes'],
        schema_issue_count: 2,
      },
    ]);

    const summary = readJson(report.files.summary_json) as {
      invalid_count: number;
      invalid_rows: unknown[];
    };
    assert.equal(summary.invalid_count, 1);
    assert.equal(summary.invalid_rows.length, 1);

    const verificationRows = readFileSync(report.files.verification_jsonl, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ProcessVerifyRowRecord);
    assert.equal(verificationRows.length, 2);
    assert.equal(verificationRows[0]?.status, 'ok');
    assert.equal(verificationRows[1]?.status, 'invalid');
    assert.deepEqual(verificationRows[1]?.name_summary.missing_required_fields, [
      'mixAndLocationTypes',
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
