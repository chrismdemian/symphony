import { beforeEach, describe, expect, it } from 'vitest';
import { ingestIssueCandidates } from '../../src/integrations/issue-ingest.js';
import type { NormalizedIssue } from '../../src/integrations/issue-connector.js';
import { ProjectRegistry } from '../../src/projects/registry.js';
import { TaskRegistry } from '../../src/state/task-registry.js';
import { MemoryExternalLinkStore } from '../../src/state/external-link-store.js';

const SOURCE = 'linear';

function issue(over: Partial<NormalizedIssue>): NormalizedIssue {
  return {
    externalId: 'iss-1',
    title: 'Do the thing',
    url: 'https://linear.app/iss-1',
    state: 'Todo',
    isTerminal: false,
    body: null,
    assignee: null,
    labels: [],
    projectValue: null,
    priority: 0,
    updatedAt: null,
    ...over,
  };
}

interface Harness {
  projects: ProjectRegistry;
  tasks: TaskRegistry;
  links: MemoryExternalLinkStore;
}

function harness(): Harness {
  const projects = new ProjectRegistry();
  projects.register({ id: 'proj', name: 'symphony', path: '/tmp/symphony', createdAt: '' });
  projects.register({ id: 'other', name: 'other', path: '/tmp/other', createdAt: '' });
  const tasks = new TaskRegistry({ projectStore: projects });
  const links = new MemoryExternalLinkStore();
  return { projects, tasks, links };
}

function run(h: Harness, candidates: NormalizedIssue[], projectArg?: string, resolveProjectPath?: (p?: string) => string) {
  return ingestIssueCandidates(
    candidates,
    {
      taskStore: h.tasks,
      projectStore: h.projects,
      externalLinkStore: h.links,
      ...(resolveProjectPath !== undefined ? { resolveProjectPath } : {}),
    },
    SOURCE,
    projectArg,
  );
}

describe('ingestIssueCandidates', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('creates a task + link per new issue, routing by projectValue', () => {
    const r = run(h, [issue({ externalId: 'a', title: 'Fix bug', projectValue: 'symphony', priority: 3, url: 'https://x/a' })]);
    expect(r.created.length).toBe(1);
    const task = h.tasks.get(r.created[0]!)!;
    expect(task.description).toBe('Fix bug');
    expect(task.projectId).toBe('proj');
    expect(task.priority).toBe(3);
    const link = h.links.getByExternal(SOURCE, 'a');
    expect(link?.taskId).toBe(task.id);
    expect(link?.url).toBe('https://x/a');
  });

  it('omits url on the link when the issue has none', () => {
    run(h, [issue({ externalId: 'a', projectValue: 'symphony', url: null })]);
    expect(h.links.getByExternal(SOURCE, 'a')?.url).toBeUndefined();
  });

  it('skips terminal issues (skippedDone)', () => {
    const r = run(h, [issue({ externalId: 'done', isTerminal: true, projectValue: 'symphony' })]);
    expect(r.created.length).toBe(0);
    expect(r.skippedDone).toBe(1);
    expect(h.tasks.size()).toBe(0);
  });

  it('is idempotent — a second ingest of the same issue creates nothing', () => {
    const c = [issue({ externalId: 'a', projectValue: 'symphony' })];
    run(h, c);
    const r = run(h, c);
    expect(r.created.length).toBe(0);
    expect(r.skippedExisting).toBe(1);
    expect(h.tasks.size()).toBe(1);
  });

  it('falls back to the explicit project arg when projectValue is unknown', () => {
    const r = run(h, [issue({ externalId: 'a', projectValue: 'NotRegistered' })], 'other');
    expect(h.tasks.get(r.created[0]!)?.projectId).toBe('other');
  });

  it('falls back to resolveProjectPath cursor when nothing else routes', () => {
    const symphonyPath = h.projects.get('symphony')!.path;
    const r = run(h, [issue({ externalId: 'a', projectValue: null })], undefined, () => symphonyPath);
    expect(h.tasks.get(r.created[0]!)?.projectId).toBe('proj');
  });

  it('reports unroutable issues without creating a task', () => {
    const r = run(h, [issue({ externalId: 'a', projectValue: null })]);
    expect(r.created.length).toBe(0);
    expect(r.skippedNoProject).toBe(1);
    expect(r.errors.length).toBe(1);
  });

  it('audit M2 — a throwing resolveProjectPath routes ONE bad arg to unroutable, not a crash', () => {
    const throwingResolver = (p?: string): string => {
      if (p === undefined) return h.projects.get('symphony')!.path;
      throw new Error(`Unknown project '${p}'`);
    };
    const r = run(
      h,
      [
        issue({ externalId: 'good', title: 'Routable', projectValue: 'symphony' }),
        issue({ externalId: 'bad', title: 'Bad arg', projectValue: null }),
      ],
      'nope',
      throwingResolver,
    );
    expect(r.created.length).toBe(1);
    expect(r.skippedNoProject).toBe(1);
  });
});
