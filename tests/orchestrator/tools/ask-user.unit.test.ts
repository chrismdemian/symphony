import { describe, expect, it } from 'vitest';
import { projectRegistryFromMap } from '../../../src/projects/registry.js';
import { QuestionRegistry } from '../../../src/state/question-registry.js';
import { makeAskUserTool } from '../../../src/orchestrator/tools/ask-user.js';
import type { DispatchContext } from '../../../src/orchestrator/types.js';

function ctx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    mode: 'plan',
    tier: 1,
    awayMode: false,
    automationContext: false,
    ...overrides,
  };
}

function deps() {
  const projectStore = projectRegistryFromMap({
    alpha: 'C:/projects/alpha',
    beta: 'C:/projects/beta',
  });
  const questionStore = new QuestionRegistry();
  const tool = makeAskUserTool({ questionStore, projectStore });
  return { tool, questionStore, projectStore };
}

describe('ask_user tool', () => {
  it('enqueues a blocking question by default', async () => {
    const { tool, questionStore } = deps();
    const result = await tool.handler(
      { question: 'ship?', context: undefined, project: undefined, worker_id: undefined, urgency: undefined },
      ctx(),
    );
    expect(result.isError).toBeUndefined();
    expect(questionStore.size()).toBe(1);
    const record = questionStore.list()[0]!;
    expect(record.urgency).toBe('blocking');
    expect(result.structuredContent?.id).toBe(record.id);
  });

  it('records optional context, project, worker_id, urgency', async () => {
    const { tool, questionStore, projectStore } = deps();
    await tool.handler(
      {
        question: 'which dep?',
        context: 'see package.json:14',
        project: 'alpha',
        worker_id: 'wk-abcd',
        urgency: 'advisory',
      },
      ctx(),
    );
    const record = questionStore.list()[0]!;
    expect(record.context).toBe('see package.json:14');
    expect(record.projectId).toBe(projectStore.get('alpha')!.id);
    expect(record.workerId).toBe('wk-abcd');
    expect(record.urgency).toBe('advisory');
  });

  it('returns isError for an unknown project', async () => {
    const { tool } = deps();
    const result = await tool.handler(
      { question: 'x', project: 'gamma', context: undefined, worker_id: undefined, urgency: undefined },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Unknown project 'gamma'/);
  });

  it('is available in both plan and act mode', () => {
    const { tool } = deps();
    expect(tool.scope).toBe('both');
  });

  it('declares no capability flags', () => {
    const { tool } = deps();
    expect(tool.capabilities).toEqual([]);
  });

  it('text content summarizes id + urgency', async () => {
    const { tool } = deps();
    const result = await tool.handler(
      { question: 'x', urgency: 'advisory', context: undefined, project: undefined, worker_id: undefined },
      ctx(),
    );
    expect(result.content[0]?.text).toMatch(/Question q-[\da-f]+ queued \[advisory\]/);
  });

  it('structured content is a full snapshot', async () => {
    const { tool } = deps();
    const result = await tool.handler(
      {
        question: 'x',
        context: 'y',
        urgency: 'blocking',
        project: undefined,
        worker_id: undefined,
      },
      ctx(),
    );
    const snap = result.structuredContent as Record<string, unknown>;
    expect(snap).toMatchObject({
      question: 'x',
      context: 'y',
      urgency: 'blocking',
      answered: false,
    });
    expect(snap.id).toMatch(/^q-/);
    expect(typeof snap.askedAt).toBe('string');
  });
});
