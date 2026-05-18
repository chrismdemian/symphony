/**
 * Phase 4E — route a completed worker's `open_questions` into the
 * Phase 3E question subsystem as advisory, auto-acknowledged entries.
 *
 * Behavioral rule #7 (PLAN.md §"12 behavioral rules"): Maestro reads a
 * worker's `open_questions` but does NOT act on them, and surfaces them
 * "sparingly" to the USER — Chris's words: "sometimes it thinks of good
 * things to add, but mostly not." We split that into two channels:
 *
 *   - Mechanical (here): EVERY open_question becomes a first-class
 *     `QuestionRecord` (urgency `'advisory'`, attributed to the worker)
 *     so it is browsable on demand in the Question History view
 *     (Phase 3F.3). It is immediately auto-acknowledged so it NEVER
 *     blocks the 3E popup (which always demands a typed answer) and
 *     never inflates the StatusBar `Q:` count (that polls
 *     `answered:false`). Low-noise, always available.
 *   - Judgmental (Maestro prompt): Maestro mentions the rare high-value
 *     one in chat, by its own discretion. That is prompt-driven, not
 *     wired here.
 *
 * Wired into `server.ts`'s `onWorkerStatusChange` (the one-shot
 * terminal-exit hook, identity-guarded against the resume race). On
 * resume the worker's buffer is `clear()`ed, so a re-run routes only
 * its fresh `open_questions` — no dedup bookkeeping required.
 *
 * The two `QuestionRegistry` callbacks tolerate this exactly:
 *   - `onQuestionEnqueued → notificationDispatcher.onQuestion` early-
 *     returns on `urgency !== 'blocking'` (no toast spam).
 *   - `onQuestionAnswered → autoMergeDispatcher.onQuestionAnswered`
 *     early-returns when the id is not in its `pendingAsks` (no
 *     misfire — these ids were never asked by auto-merge).
 */
import type { WorkerRecord } from './worker-registry.js';
import type { QuestionStore } from '../state/question-registry.js';
import type { StructuredCompletionEvent } from '../workers/types.js';

/**
 * Sentinel answer stamped on an advisory open_question at routing time.
 * Marks it acknowledged-without-a-USER-answer so it lands in Question
 * History without ever demanding interaction (rule #7: surfaced, not
 * blocking).
 */
export const OPEN_QUESTION_ACK =
  '(surfaced from worker completion report — informational, no answer required)';

/**
 * Scan a completed worker's event buffer for its structured completion
 * report and route every `open_questions` entry into `questionStore` as
 * an advisory, auto-acknowledged question.
 *
 * Pure and defensive: never throws into the caller's exit chain (the
 * lifecycle swallows hook errors, but we don't rely on that). Returns
 * the number of questions routed (0 when there is no completion event
 * or no open_questions) — useful for tests and the production scenario.
 */
export function routeWorkerOpenQuestions(
  record: WorkerRecord,
  questionStore: QuestionStore,
): number {
  // `buffer.tail(size)` returns the whole buffer oldest-first (a copy).
  // The completion report is emitted in the worker's final message, so
  // the LAST structured_completion event is authoritative.
  const events = record.buffer.tail(record.buffer.size());
  let completion: StructuredCompletionEvent | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev !== undefined && ev.type === 'structured_completion') {
      completion = ev;
      break;
    }
  }
  if (completion === undefined) return 0;

  const questions = completion.report.open_questions
    .map((q) => (typeof q === 'string' ? q.trim() : ''))
    .filter((q) => q.length > 0);
  if (questions.length === 0) return 0;

  const intent = record.featureIntent.trim();
  const context =
    `Adjacent observation from worker ${record.id}` +
    (intent.length > 0 ? ` (${intent})` : '') +
    ' — noted in its completion report, not acted on (scope clamp). ' +
    'Advisory only; review at your discretion.';

  let routed = 0;
  for (const question of questions) {
    try {
      const rec = questionStore.enqueue({
        question,
        workerId: record.id,
        urgency: 'advisory',
        context,
        ...(record.projectId !== null ? { projectId: record.projectId } : {}),
      });
      // Auto-acknowledge immediately: advisory open_questions are
      // surfaced (History) but never block the popup or inflate `Q:`.
      questionStore.answer(rec.id, OPEN_QUESTION_ACK);
      routed += 1;
    } catch {
      // A single malformed entry must not stop the rest, nor poison the
      // worker exit chain. Best-effort by design (rule #7: low-noise).
    }
  }
  return routed;
}
