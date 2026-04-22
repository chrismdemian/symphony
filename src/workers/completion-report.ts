import type { WorkerCompletionReport } from './types.js';

const FENCE_RE = /```json\s*\n([\s\S]*?)\n```/g;

export interface ReportScanResult {
  kind: 'none' | 'valid' | 'invalid';
  report?: WorkerCompletionReport;
  raw?: string;
  reason?: string;
}

export function scanForCompletionReport(text: string): ReportScanResult {
  const matches = [...text.matchAll(FENCE_RE)];
  if (matches.length === 0) return { kind: 'none' };

  // If multiple fences exist in one turn, the last one wins (Phase 4E: "end of final message").
  const last = matches[matches.length - 1];
  if (!last) return { kind: 'none' };
  const raw = last[1] ?? '';

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: 'invalid',
      raw,
      reason: `json parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const validated = validateReport(parsed);
  if (!validated.ok) return { kind: 'invalid', raw, reason: validated.reason };
  return { kind: 'valid', raw, report: validated.report };
}

interface ValidateOk {
  ok: true;
  report: WorkerCompletionReport;
}

interface ValidateFail {
  ok: false;
  reason: string;
}

function validateReport(value: unknown): ValidateOk | ValidateFail {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not a json object' };
  }
  const obj = value as Record<string, unknown>;

  const stringArray = (key: string): string[] | string => {
    const v = obj[key];
    if (!Array.isArray(v)) return `${key}: expected array`;
    for (const item of v) {
      if (typeof item !== 'string') return `${key}: non-string item`;
    }
    return v as string[];
  };

  const did = stringArray('did');
  if (typeof did === 'string') return { ok: false, reason: did };
  const skipped = stringArray('skipped');
  if (typeof skipped === 'string') return { ok: false, reason: skipped };
  const blockers = stringArray('blockers');
  if (typeof blockers === 'string') return { ok: false, reason: blockers };
  const openQuestions = stringArray('open_questions');
  if (typeof openQuestions === 'string') return { ok: false, reason: openQuestions };
  const cite = stringArray('cite');
  if (typeof cite === 'string') return { ok: false, reason: cite };
  const testsRun = stringArray('tests_run');
  if (typeof testsRun === 'string') return { ok: false, reason: testsRun };

  const audit = obj['audit'];
  if (audit !== 'PASS' && audit !== 'FAIL') {
    return { ok: false, reason: 'audit: must be "PASS" or "FAIL"' };
  }

  const previewUrlValue = obj['preview_url'];
  if (previewUrlValue !== null && typeof previewUrlValue !== 'string') {
    return { ok: false, reason: 'preview_url: must be string or null' };
  }

  const report: WorkerCompletionReport = {
    did,
    skipped,
    blockers,
    open_questions: openQuestions,
    audit,
    cite,
    tests_run: testsRun,
    preview_url: previewUrlValue,
  };
  if ('display' in obj) report.display = obj['display'];

  return { ok: true, report };
}
