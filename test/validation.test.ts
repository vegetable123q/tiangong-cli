import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CliError } from '../src/lib/errors.js';
import {
  resolveLocalSdkModule,
  resolveRepoRootFrom,
  resolveSdkModuleFromCandidates,
  runCommandCapture,
  runValidation,
} from '../src/lib/validation.js';

const currentFilePath = fileURLToPath(import.meta.url);

function makeValidationReport(inputDir: string, issueCode = 'schema_error') {
  return {
    input_dir: inputDir,
    ok: false,
    categories: [
      {
        category: 'processes',
        ok: false,
        issues: [
          {
            issue_code: issueCode,
            severity: 'error',
            category: 'processes',
            file_path: `${inputDir}/processes/demo.json`,
            message: 'Broken process dataset',
            location: '<root>',
            context: {},
          },
        ],
      },
    ],
  };
}

test('runValidation uses sdk mode, normalizes the report, and writes the report file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-sdk-'));
  const reportFile = path.join(dir, 'report.json');

  try {
    const report = await runValidation(
      {
        inputDir: dir,
        engine: 'sdk',
        reportFile,
      },
      {
        loadSdkModule: () => ({
          location: '/tmp/sdk.js',
          validatePackageDir: () => makeValidationReport(dir),
        }),
      },
    );

    assert.equal(report.mode, 'sdk');
    assert.equal(report.ok, false);
    assert.equal(report.summary.engine_count, 1);
    assert.equal(report.reports[0].engine, 'sdk');
    assert.equal(report.reports[0].location, '/tmp/sdk.js');
    assert.equal(report.reports[0].report.summary.issue_count, 1);
    assert.equal(statSync(reportFile).isFile(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidation falls back to tools in auto mode when the sdk is unavailable', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-auto-'));

  try {
    const report = await runValidation(
      {
        inputDir: dir,
      },
      {
        loadSdkModule: () => {
          throw new CliError('sdk unavailable', {
            code: 'VALIDATION_SDK_UNAVAILABLE',
            exitCode: 2,
          });
        },
        runToolsCommand: (command) => {
          assert.deepEqual(command, ['uv', 'run', 'tidas-validate', '-i', dir, '--format', 'json']);
          return {
            status: 1,
            stdout: JSON.stringify(makeValidationReport(dir, 'tools_error')),
            stderr: '',
          };
        },
      },
    );

    assert.equal(report.mode, 'auto');
    assert.equal(report.reports[0].engine, 'tools');
    assert.equal(report.reports[0].command_exit_code, 1);
    assert.equal(report.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidation all mode compares sdk and tools results', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-all-'));
  const sharedReport = makeValidationReport(dir, 'parity_error');

  try {
    const report = await runValidation(
      {
        inputDir: dir,
        engine: 'all',
      },
      {
        loadSdkModule: () => ({
          location: '/tmp/sdk.js',
          validatePackageDir: () => sharedReport,
        }),
        runToolsCommand: () => ({
          status: 1,
          stdout: JSON.stringify(sharedReport),
          stderr: '',
        }),
      },
    );

    assert.equal(report.reports.length, 2);
    assert.equal(report.comparison?.equivalent, true);
    assert.deepEqual(report.comparison?.differences, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidation all mode reports comparison differences', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-diff-'));

  try {
    const report = await runValidation(
      {
        inputDir: dir,
        engine: 'all',
      },
      {
        loadSdkModule: () => ({
          location: '/tmp/sdk.js',
          validatePackageDir: () => makeValidationReport(dir, 'sdk_error'),
        }),
        runToolsCommand: () => ({
          status: 0,
          stdout: JSON.stringify({
            input_dir: dir,
            ok: true,
          }),
          stderr: '',
        }),
      },
    );

    assert.equal(report.comparison?.equivalent, false);
    assert.deepEqual(report.comparison?.differences, ['ok', 'summary', 'categories', 'issues']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidation can use the default local sdk loader when available', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-defaults-'));

  try {
    const localSdk = resolveLocalSdkModule();
    const sdkReport = await runValidation({
      inputDir: dir,
      engine: 'sdk',
    });
    const commandResult = runCommandCapture([
      process.execPath,
      '--eval',
      "process.stdout.write('ok')",
    ]);
    const fallbackCommandResult = runCommandCapture(['ignored'], (() => ({
      pid: 1,
      output: [],
      signal: null,
      status: 0,
      stdout: undefined,
      stderr: undefined,
      error: undefined,
    })) as unknown as typeof import('node:child_process').spawnSync);

    assert.equal(typeof localSdk.validatePackageDir, 'function');
    assert.equal(sdkReport.ok, true);
    assert.equal(commandResult.status, 0);
    assert.equal(commandResult.stdout, 'ok');
    assert.equal(fallbackCommandResult.stdout, '');
    assert.equal(fallbackCommandResult.stderr, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidation resolves sdk candidates and surfaces resolution failures and auto-mode rethrows non-fallback errors', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-default-errors-'));

  try {
    const resolved = resolveSdkModuleFromCandidates(
      () => ({
        validatePackageDir: () => makeValidationReport(dir),
      }),
      ['/tmp/fake-sdk.js'],
    );
    assert.equal(resolved.location, '/tmp/fake-sdk.js');

    assert.throws(
      () =>
        resolveSdkModuleFromCandidates(
          (candidate) => {
            if (candidate.endsWith('broken-export.js')) {
              return {};
            }
            if (candidate.endsWith('throws-string.js')) {
              throw 'missing from string';
            }
            throw new Error('missing package');
          },
          ['/tmp/missing-package.js', '/tmp/throws-string.js', '/tmp/broken-export.js'],
        ),
      /Unable to resolve the local tidas-sdk parity validator/u,
    );

    await assert.rejects(
      async () =>
        runValidation(
          {
            inputDir: dir,
          },
          {
            loadSdkModule: () => {
              throw new CliError('broken sdk', {
                code: 'VALIDATION_SDK_BROKEN',
                exitCode: 1,
              });
            },
          },
        ),
      /broken sdk/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidation normalizes malformed issue payloads and report shapes', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-normalize-'));

  try {
    const report = await runValidation(
      {
        inputDir: dir,
        engine: 'sdk',
      },
      {
        loadSdkModule: () => ({
          location: '/tmp/sdk.js',
          validatePackageDir: () => ({
            input_dir: dir,
            ok: false,
            categories: [
              {
                category: 'flows',
                issues: [
                  null,
                  { severity: 'fatal', file_path: 'flows/demo.json' },
                  {
                    issue_code: 'bad_context',
                    severity: 'warning',
                    category: 'flows',
                    file_path: 42,
                    message: { detail: 'not a string' },
                    location: 9,
                    context: 'invalid',
                  },
                ],
              },
              null,
            ],
          }),
        }),
      },
    );

    assert.equal(report.reports[0].report.issues[0].message, 'null');
    assert.equal(report.reports[0].report.issues[1].severity, 'error');
    assert.equal(report.reports[0].report.issues[2].file_path, '<unknown>');
    assert.match(report.reports[0].report.issues[2].message, /"detail":"not a string"/u);
    assert.equal(report.reports[0].report.issues[2].location, '<root>');
    assert.deepEqual(report.reports[0].report.issues[2].context, {});
    assert.equal(report.reports[0].report.categories[1].category, 'unknown');
    assert.equal(report.reports[0].report.categories[1].ok, true);
    assert.deepEqual(report.reports[0].report.categories[1].issues, []);

    const emptyReport = await runValidation(
      {
        inputDir: dir,
        engine: 'sdk',
      },
      {
        loadSdkModule: () => ({
          location: '/tmp/sdk.js',
          validatePackageDir: () => ({
            input_dir: dir,
            ok: true,
          }),
        }),
      },
    );

    assert.deepEqual(emptyReport.reports[0].report.categories, []);

    const stringReport = await runValidation(
      {
        inputDir: dir,
        engine: 'sdk',
      },
      {
        loadSdkModule: () => ({
          location: '/tmp/sdk.js',
          validatePackageDir: () => 'not-an-object',
        }),
      },
    );

    assert.equal(stringReport.reports[0].report.input_dir, dir);
    assert.deepEqual(stringReport.reports[0].report.categories, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRepoRootFrom falls back to process.cwd when no package.json exists above the start directory', () => {
  const resolved = resolveRepoRootFrom(path.parse(process.cwd()).root);
  assert.equal(resolved, process.cwd());
});

test('runValidation tools mode can use the default command runner from PATH', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-default-tools-'));
  const binDir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-bin-'));
  const uvPath = path.join(binDir, 'uv');
  const originalPath = process.env.PATH ?? '';

  writeFileSync(
    uvPath,
    `#!/bin/sh
printf '%s' '{"input_dir":"${dir}","ok":true,"categories":[]}'
`,
    'utf8',
  );
  chmodSync(uvPath, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

  try {
    const report = await runValidation({
      inputDir: dir,
      engine: 'tools',
    });

    assert.equal(report.reports[0].engine, 'tools');
    assert.equal(report.reports[0].location, 'uv run tidas-validate');
    assert.equal(report.reports[0].command_exit_code, 0);
    assert.equal(report.ok, true);
  } finally {
    process.env.PATH = originalPath;
    rmSync(binDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidation covers direct tools mode and successful auto sdk mode', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-modes-'));

  try {
    const toolsReport = await runValidation(
      {
        inputDir: dir,
        engine: 'tools',
      },
      {
        runToolsCommand: () => ({
          status: 0,
          stdout: JSON.stringify({
            input_dir: dir,
            ok: true,
            categories: [],
          }),
          stderr: '',
        }),
      },
    );

    const autoReport = await runValidation(
      {
        inputDir: dir,
      },
      {
        loadSdkModule: () => ({
          location: '/tmp/sdk.js',
          validatePackageDir: () => ({
            input_dir: dir,
            ok: true,
            categories: [],
          }),
        }),
      },
    );

    assert.equal(toolsReport.reports[0].engine, 'tools');
    assert.equal(autoReport.reports[0].engine, 'sdk');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runValidation validates the input directory and engine value', async () => {
  const fileDir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-inputs-'));
  const missingDir = path.join(fileDir, 'missing');

  try {
    await assert.rejects(
      async () =>
        runValidation({
          inputDir: '',
        }),
      /Missing required --input-dir/u,
    );

    await assert.rejects(
      async () =>
        runValidation({
          inputDir: missingDir,
        }),
      /not found/u,
    );

    await assert.rejects(
      async () =>
        runValidation({
          inputDir: currentFilePath,
        }),
      /not a directory/u,
    );

    await assert.rejects(
      async () =>
        runValidation({
          inputDir: fileDir,
          engine: 'remote',
        }),
      /Expected --engine/u,
    );
  } finally {
    rmSync(fileDir, { recursive: true, force: true });
  }
});

test('runValidation surfaces tool execution failures and invalid JSON output', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tg-cli-validation-errors-'));
  const originalParse = JSON.parse;

  try {
    await assert.rejects(
      async () =>
        runValidation(
          {
            inputDir: dir,
            engine: 'tools',
          },
          {
            runToolsCommand: () => ({
              status: null,
              stdout: '',
              stderr: 'exec failed',
              error: new Error('spawn failed'),
            }),
          },
        ),
      /Failed to run tidas-tools validation/u,
    );

    await assert.rejects(
      async () =>
        runValidation(
          {
            inputDir: dir,
            engine: 'tools',
          },
          {
            runToolsCommand: () => ({
              status: 1,
              stdout: 'not-json',
              stderr: '',
            }),
          },
        ),
      /did not return valid JSON/u,
    );

    JSON.parse = (() => {
      throw 'non-error parse failure';
    }) as typeof JSON.parse;

    await assert.rejects(
      async () =>
        runValidation(
          {
            inputDir: dir,
            engine: 'tools',
          },
          {
            runToolsCommand: () => ({
              status: 1,
              stdout: '{}',
              stderr: '',
            }),
          },
        ),
      /did not return valid JSON/u,
    );

    JSON.parse = originalParse;

    await assert.rejects(
      async () =>
        runValidation(
          {
            inputDir: dir,
            engine: 'tools',
          },
          {
            runToolsCommand: () => ({
              status: 1,
              stdout: '',
              stderr: 'empty',
            }),
          },
        ),
      /did not return JSON output/u,
    );
  } finally {
    JSON.parse = originalParse;
    rmSync(dir, { recursive: true, force: true });
  }
});
