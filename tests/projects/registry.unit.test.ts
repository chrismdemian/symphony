import { describe, expect, it } from 'vitest';
import {
  DuplicateProjectError,
  ProjectRegistry,
  projectRegistryFromMap,
  toProjectSnapshot,
} from '../../src/projects/registry.js';

describe('ProjectRegistry', () => {
  it('registers and resolves by name or id', () => {
    const r = new ProjectRegistry({ now: () => 0 });
    const rec = r.register({
      id: 'p1',
      name: 'frontend',
      path: '/repos/frontend',
      createdAt: '',
    });
    expect(r.get('frontend')?.id).toBe('p1');
    expect(r.get('p1')?.name).toBe('frontend');
    expect(rec.createdAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('rejects duplicate names', () => {
    const r = new ProjectRegistry();
    r.register({ id: 'p1', name: 'frontend', path: '/a', createdAt: '' });
    expect(() =>
      r.register({ id: 'p2', name: 'frontend', path: '/b', createdAt: '' }),
    ).toThrow(DuplicateProjectError);
  });

  it('rejects duplicate ids', () => {
    const r = new ProjectRegistry();
    r.register({ id: 'p1', name: 'a', path: '/a', createdAt: '' });
    expect(() =>
      r.register({ id: 'p1', name: 'b', path: '/b', createdAt: '' }),
    ).toThrow(DuplicateProjectError);
  });

  it('rejects cross-namespace collisions (id-as-new-name, name-as-new-id)', () => {
    const r = new ProjectRegistry();
    r.register({ id: 'alpha', name: 'foo', path: '/a', createdAt: '' });
    // second register uses the first's id as its name
    expect(() =>
      r.register({ id: 'bar', name: 'alpha', path: '/b', createdAt: '' }),
    ).toThrow(DuplicateProjectError);
    r.register({ id: 'baz', name: 'qux', path: '/c', createdAt: '' });
    // third register uses the second's name as its id
    expect(() =>
      r.register({ id: 'qux', name: 'frobnicate', path: '/d', createdAt: '' }),
    ).toThrow(DuplicateProjectError);
    // surviving state is intact
    expect(r.size()).toBe(2);
    expect(r.get('alpha')?.path.endsWith('a')).toBe(true);
    expect(r.get('qux')?.path.endsWith('c')).toBe(true);
  });

  it('filters by nameContains (case-insensitive)', () => {
    const r = new ProjectRegistry();
    r.register({ id: 'a', name: 'Alpha', path: '/a', createdAt: '' });
    r.register({ id: 'b', name: 'alphanumeric', path: '/b', createdAt: '' });
    r.register({ id: 'c', name: 'beta', path: '/c', createdAt: '' });
    expect(r.list({ nameContains: 'alpha' }).map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(r.list({ nameContains: ' ' }).length).toBe(3);
    expect(r.list({ nameContains: '' }).length).toBe(3);
  });

  it('validates required fields', () => {
    const r = new ProjectRegistry();
    expect(() =>
      r.register({ id: 'p', name: '', path: '/a', createdAt: '' }),
    ).toThrow(/name is required/);
    expect(() =>
      r.register({ id: 'p', name: 'x', path: '', createdAt: '' }),
    ).toThrow(/path is required/);
  });

  it('returns undefined for unknown lookups', () => {
    const r = new ProjectRegistry();
    expect(r.get('nope')).toBeUndefined();
    expect(r.snapshot('nope')).toBeUndefined();
    expect(r.get('')).toBeUndefined();
  });

  it('snapshots include optional fields when present', () => {
    const r = new ProjectRegistry();
    const rec = r.register({
      id: 'p1',
      name: 'frontend',
      path: '/repos/frontend',
      gitBranch: 'main',
      gitRemote: 'git@github.com:me/frontend.git',
      baseRef: 'main',
      defaultModel: 'opus',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const snap = toProjectSnapshot(rec);
    expect(snap).toMatchObject({
      name: 'frontend',
      gitBranch: 'main',
      defaultModel: 'opus',
    });
  });

  it('projectRegistryFromMap seeds in insertion order and preserves names', () => {
    const r = projectRegistryFromMap({
      alpha: '/repos/alpha',
      beta: '/repos/beta',
    });
    expect(r.size()).toBe(2);
    expect(r.get('alpha')?.path.endsWith('alpha')).toBe(true);
    expect(r.list().map((p) => p.name)).toEqual(['alpha', 'beta']);
  });

  it('ignores empty/non-string paths in projectRegistryFromMap', () => {
    const r = projectRegistryFromMap({
      good: '/repos/good',
      bad: '',
      other: undefined as unknown as string,
    });
    expect(r.size()).toBe(1);
    expect(r.get('good')).toBeDefined();
  });
});
