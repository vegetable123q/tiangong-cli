import * as tidasSdk from '@tiangong-lca/tidas-sdk';

type JsonObject = Record<string, unknown>;

type SafeParseIssue = {
  code?: string;
  message?: string;
  path?: Array<string | number>;
};

type SafeParseResult =
  | {
      success: true;
      data?: unknown;
    }
  | {
      success: false;
      error?: {
        issues?: SafeParseIssue[];
      };
    };

type SafeParseSchema = {
  safeParse: (value: unknown) => SafeParseResult;
};

const PROCESS_SCHEMA_VALIDATOR = '@tiangong-lca/tidas-sdk/ProcessSchema';

export type ProcessPayloadValidationIssue = {
  path: string;
  message: string;
  code: string;
};

export type ProcessPayloadValidationResult =
  | {
      ok: true;
      validator: string;
      issue_count: 0;
      issues: [];
    }
  | {
      ok: false;
      validator: string;
      issue_count: number;
      issues: ProcessPayloadValidationIssue[];
    };

function getProcessSchema(): SafeParseSchema {
  const schema = (tidasSdk as { ProcessSchema?: SafeParseSchema }).ProcessSchema;
  if (!schema?.safeParse) {
    throw new Error(`${PROCESS_SCHEMA_VALIDATOR} is unavailable in the published CLI runtime.`);
  }
  return schema;
}

function normalizeIssuePath(pathParts: Array<string | number> | undefined): string {
  if (!Array.isArray(pathParts) || pathParts.length === 0) {
    return '<root>';
  }
  return pathParts.map((part) => String(part)).join('.');
}

export function summarizeProcessPayloadValidation(result: ProcessPayloadValidationResult): string {
  if (result.ok) {
    return 'local ProcessSchema validation passed';
  }

  const preview = result.issues
    .slice(0, 3)
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join('; ');
  return `local ProcessSchema validation failed with ${result.issue_count} issue(s)${preview ? ` (${preview})` : ''}`;
}

export function validateProcessPayload(payload: JsonObject): ProcessPayloadValidationResult {
  const schema = getProcessSchema();
  const outcome = schema.safeParse(payload);

  if (outcome.success) {
    return {
      ok: true,
      validator: PROCESS_SCHEMA_VALIDATOR,
      issue_count: 0,
      issues: [],
    };
  }

  const issues = (outcome.error?.issues ?? []).map((issue) => ({
    path: normalizeIssuePath(issue.path),
    message: issue.message ?? 'Validation failed',
    code: issue.code ?? 'custom',
  }));

  return {
    ok: false,
    validator: PROCESS_SCHEMA_VALIDATOR,
    issue_count: issues.length,
    issues,
  };
}
