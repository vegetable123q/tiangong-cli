import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError } from './errors.js';
import { writeJsonArtifact } from './artifacts.js';

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summarizeIssues(issues: ValidationIssue[]): ValidationSummary {
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const infoCount = issues.filter((issue) => issue.severity === 'info').length;

  return {
    issue_count: issues.length,
    error_count: errorCount,
    warning_count: warningCount,
    info_count: infoCount,
  };
}

function normalizeIssue(raw: unknown): ValidationIssue {
  if (!isRecord(raw)) {
    return {
      issue_code: 'validation_issue',
      severity: 'error',
      category: 'unknown',
      file_path: '<unknown>',
      message: String(raw),
      location: '<root>',
      context: {},
    };
  }

  const severity =
    raw.severity === 'warning' || raw.severity === 'info' || raw.severity === 'error'
      ? raw.severity
      : 'error';

  return {
    issue_code: typeof raw.issue_code === 'string' ? raw.issue_code : 'validation_issue',
    severity,
    category: typeof raw.category === 'string' ? raw.category : 'unknown',
    file_path: typeof raw.file_path === 'string' ? raw.file_path : '<unknown>',
    message: typeof raw.message === 'string' ? raw.message : JSON.stringify(raw),
    location: typeof raw.location === 'string' ? raw.location : '<root>',
    context: isRecord(raw.context) ? raw.context : {},
  };
}

function normalizeCategoryReport(raw: unknown): CategoryValidationReport {
  const record = isRecord(raw) ? raw : {};
  const issues = Array.isArray(record.issues) ? record.issues.map(normalizeIssue) : [];

  return {
    category: typeof record.category === 'string' ? record.category : 'unknown',
    ok: issues.length === 0,
    summary: summarizeIssues(issues),
    issues,
  };
}

function normalizePackageReport(raw: unknown, inputDir: string): PackageValidationReport {
  const record = isRecord(raw) ? raw : {};
  const categories = Array.isArray(record.categories)
    ? record.categories.map(normalizeCategoryReport)
    : [];
  const issues = categories.flatMap((category) => category.issues);

  return {
    input_dir: typeof record.input_dir === 'string' ? record.input_dir : inputDir,
    ok: issues.length === 0,
    summary: {
      category_count: categories.length,
      ...summarizeIssues(issues),
    },
    categories,
    issues,
  };
}

export function resolveRepoRootFrom(startDir: string): string {
  let currentDir = startDir;

  while (true) {
    if (existsSync(path.join(currentDir, 'package.json'))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return process.cwd();
    }
    currentDir = parentDir;
  }
}

function resolve_cli_repo_root(): string {
  return resolveRepoRootFrom(path.dirname(fileURLToPath(import.meta.url)));
}

function build_sdk_candidates(): string[] {
  const repoRoot = resolve_cli_repo_root();
  return [
    '@tiangong-lca/tidas-sdk/parity',
    path.join(repoRoot, '..', 'tidas-sdk', 'sdks', 'typescript', 'dist', 'parity', 'index.js'),
  ];
}

function normalizeValidationMode(value: string | undefined): ValidationMode {
  if (!value) {
    return 'auto';
  }
  if (value === 'auto' || value === 'sdk' || value === 'tools' || value === 'all') {
    return value;
  }
  throw new CliError('Expected --engine to be one of auto, sdk, tools, or all.', {
    code: 'VALIDATION_INVALID_ENGINE',
    exitCode: 2,
    details: value,
  });
}

function assert_input_dir(inputDir: string): string {
  if (!inputDir) {
    throw new CliError('Missing required --input-dir value.', {
      code: 'VALIDATION_INPUT_DIR_REQUIRED',
      exitCode: 2,
    });
  }

  const resolved = path.resolve(inputDir);
  if (!existsSync(resolved)) {
    throw new CliError(`Validation input directory not found: ${resolved}`, {
      code: 'VALIDATION_INPUT_DIR_NOT_FOUND',
      exitCode: 2,
    });
  }

  if (!statSync(resolved).isDirectory()) {
    throw new CliError(`Validation input path is not a directory: ${resolved}`, {
      code: 'VALIDATION_INPUT_NOT_DIRECTORY',
      exitCode: 2,
    });
  }

  return resolved;
}

function buildToolsValidationCommand(inputDir: string): string[] {
  return ['uv', 'run', 'tidas-validate', '-i', inputDir, '--format', 'json'];
}

function compareValidationReports(
  left: PackageValidationReport,
  right: PackageValidationReport,
): ValidationComparison {
  const differences: string[] = [];

  if (left.ok !== right.ok) {
    differences.push('ok');
  }
  if (JSON.stringify(left.summary) !== JSON.stringify(right.summary)) {
    differences.push('summary');
  }
  if (JSON.stringify(left.categories) !== JSON.stringify(right.categories)) {
    differences.push('categories');
  }
  if (JSON.stringify(left.issues) !== JSON.stringify(right.issues)) {
    differences.push('issues');
  }

  return {
    equivalent: differences.length === 0,
    differences,
  };
}

export type ValidationSeverity = 'error' | 'warning' | 'info';

export type ValidationIssue = {
  issue_code: string;
  severity: ValidationSeverity;
  category: string;
  file_path: string;
  message: string;
  location: string;
  context: Record<string, unknown>;
};

export type ValidationSummary = {
  issue_count: number;
  error_count: number;
  warning_count: number;
  info_count: number;
};

export type CategoryValidationReport = {
  category: string;
  ok: boolean;
  summary: ValidationSummary;
  issues: ValidationIssue[];
};

export type PackageValidationReport = {
  input_dir: string;
  ok: boolean;
  summary: ValidationSummary & { category_count: number };
  categories: CategoryValidationReport[];
  issues: ValidationIssue[];
};

export type ValidationEngine = 'sdk' | 'tools';
export type ValidationMode = 'auto' | 'sdk' | 'tools' | 'all';

export type ValidationExecutionReport = {
  engine: ValidationEngine;
  ok: boolean;
  duration_ms: number;
  location: string;
  report: PackageValidationReport;
  command?: string[];
  command_exit_code?: number | null;
};

export type ValidationComparison = {
  equivalent: boolean;
  differences: string[];
};

export type ValidationRunReport = {
  input_dir: string;
  mode: ValidationMode;
  ok: boolean;
  summary: {
    engine_count: number;
    ok_count: number;
    failed_count: number;
  };
  files: {
    report: string | null;
  };
  reports: ValidationExecutionReport[];
  comparison: ValidationComparison | null;
};

export type RunValidationOptions = {
  inputDir: string;
  engine?: string;
  reportFile?: string | null;
};

export type ValidationDeps = {
  loadSdkModule?: () => {
    location: string;
    validatePackageDir: (inputDir: string, emitLogs?: boolean) => unknown;
  };
  runToolsCommand?: (command: string[]) => {
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error | null;
  };
};

export function resolveSdkModuleFromCandidates(
  requireFn: (candidate: string) => unknown,
  candidates: string[],
): {
  location: string;
  validatePackageDir: (inputDir: string, emitLogs?: boolean) => unknown;
} {
  const details: string[] = [];

  for (const candidate of candidates) {
    try {
      const loaded = requireFn(candidate) as { validatePackageDir?: unknown };
      if (typeof loaded.validatePackageDir === 'function') {
        return {
          location: candidate,
          validatePackageDir: loaded.validatePackageDir as (
            inputDir: string,
            emitLogs?: boolean,
          ) => unknown,
        };
      }
      details.push(`Candidate missing validatePackageDir export: ${candidate}`);
    } catch (error) {
      details.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new CliError('Unable to resolve the local tidas-sdk parity validator.', {
    code: 'VALIDATION_SDK_UNAVAILABLE',
    exitCode: 2,
    details,
  });
}

export function resolveLocalSdkModule(): {
  location: string;
  validatePackageDir: (inputDir: string, emitLogs?: boolean) => unknown;
} {
  return resolveSdkModuleFromCandidates(createRequire(import.meta.url), build_sdk_candidates());
}

export function runCommandCapture(
  command: string[],
  spawnSyncImpl: typeof spawnSync = spawnSync,
): {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error | null;
} {
  const result = spawnSyncImpl(command[0], command.slice(1), {
    encoding: 'utf8',
  });

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  };
}

async function runSdkValidation(
  inputDir: string,
  deps: ValidationDeps,
): Promise<ValidationExecutionReport> {
  const startedAt = Date.now();
  const sdkModule = (deps.loadSdkModule ?? resolveLocalSdkModule)();
  const report = normalizePackageReport(sdkModule.validatePackageDir(inputDir, false), inputDir);

  return {
    engine: 'sdk',
    ok: report.ok,
    duration_ms: Date.now() - startedAt,
    location: sdkModule.location,
    report,
  };
}

async function runToolsValidation(
  inputDir: string,
  deps: ValidationDeps,
): Promise<ValidationExecutionReport> {
  const startedAt = Date.now();
  const command = buildToolsValidationCommand(inputDir);
  const result = (deps.runToolsCommand ?? runCommandCapture)(command);

  if (result.error) {
    throw new CliError('Failed to run tidas-tools validation command.', {
      code: 'VALIDATION_TOOLS_EXEC_FAILED',
      exitCode: 1,
      details: result.error.message,
    });
  }

  const stdout = result.stdout.trim();
  if (!stdout) {
    throw new CliError('tidas-tools validation did not return JSON output.', {
      code: 'VALIDATION_TOOLS_EMPTY_OUTPUT',
      exitCode: 1,
      details: {
        stderr: result.stderr,
        status: result.status,
      },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new CliError('tidas-tools validation did not return valid JSON.', {
      code: 'VALIDATION_TOOLS_INVALID_JSON',
      exitCode: 1,
      details: {
        stdout,
        stderr: result.stderr,
        status: result.status,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }

  const report = normalizePackageReport(parsed, inputDir);

  return {
    engine: 'tools',
    ok: report.ok,
    duration_ms: Date.now() - startedAt,
    location: 'uv run tidas-validate',
    report,
    command,
    command_exit_code: result.status,
  };
}

export async function runValidation(
  options: RunValidationOptions,
  deps: ValidationDeps = {},
): Promise<ValidationRunReport> {
  const inputDir = assert_input_dir(options.inputDir);
  const mode = normalizeValidationMode(options.engine);
  const reports: ValidationExecutionReport[] = [];

  if (mode === 'sdk') {
    reports.push(await runSdkValidation(inputDir, deps));
  } else if (mode === 'tools') {
    reports.push(await runToolsValidation(inputDir, deps));
  } else if (mode === 'all') {
    reports.push(await runSdkValidation(inputDir, deps));
    reports.push(await runToolsValidation(inputDir, deps));
  } else {
    try {
      reports.push(await runSdkValidation(inputDir, deps));
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== 'VALIDATION_SDK_UNAVAILABLE') {
        throw error;
      }
      reports.push(await runToolsValidation(inputDir, deps));
    }
  }

  const comparison =
    reports.length === 2 ? compareValidationReports(reports[0].report, reports[1].report) : null;
  const reportFile = options.reportFile ? path.resolve(options.reportFile) : null;
  const finalReport: ValidationRunReport = {
    input_dir: inputDir,
    mode,
    ok: reports.every((report) => report.ok),
    summary: {
      engine_count: reports.length,
      ok_count: reports.filter((report) => report.ok).length,
      failed_count: reports.filter((report) => !report.ok).length,
    },
    files: {
      report: reportFile,
    },
    reports,
    comparison,
  };

  if (reportFile) {
    writeJsonArtifact(reportFile, finalReport);
  }

  return finalReport;
}
