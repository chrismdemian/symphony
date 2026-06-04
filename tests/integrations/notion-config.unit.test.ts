import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  defaultNotionConfig,
  loadNotionConfig,
  mapNotionPriority,
  mapNotionStatus,
  NotionConfigError,
  saveNotionConfig,
} from '../../src/integrations/notion-config.js';
import { integrationsDir } from '../../src/integrations/secrets.js';

describe('notion-config', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'symphony-notion-cfg-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('defaultNotionConfig fills sensible defaults from a bare database id', () => {
    const cfg = defaultNotionConfig('db-123');
    expect(cfg.databaseId).toBe('db-123');
    expect(cfg.statusProperty).toBe('Status');
    expect(cfg.projectProperty).toBe('Project');
    expect(cfg.priorityProperty).toBe('Priority');
    expect(cfg.statusWriteback.completed).toBe('Done');
    expect(cfg.statusWriteback.failed).toBeUndefined();
  });

  it('loadNotionConfig returns undefined when unconfigured', async () => {
    expect(await loadNotionConfig(home)).toBeUndefined();
  });

  it('saveNotionConfig then loadNotionConfig round-trips', async () => {
    await saveNotionConfig({ databaseId: 'db-1', statusProperty: 'State' }, home);
    const loaded = await loadNotionConfig(home);
    expect(loaded?.databaseId).toBe('db-1');
    expect(loaded?.statusProperty).toBe('State');
    // Untouched fields keep their defaults.
    expect(loaded?.projectProperty).toBe('Project');
  });

  it('saveNotionConfig merges across calls (accumulates property names)', async () => {
    await saveNotionConfig({ databaseId: 'db-1' }, home);
    await saveNotionConfig({ projectProperty: 'Repo' }, home);
    const loaded = await loadNotionConfig(home);
    expect(loaded?.databaseId).toBe('db-1');
    expect(loaded?.projectProperty).toBe('Repo');
  });

  it('saveNotionConfig requires a database id the first time', async () => {
    await expect(saveNotionConfig({ statusProperty: 'X' }, home)).rejects.toBeInstanceOf(
      NotionConfigError,
    );
  });

  it('loadNotionConfig throws on malformed JSON (never silently "unconfigured")', async () => {
    const dir = integrationsDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'notion.json'), '{ not json', 'utf8');
    await expect(loadNotionConfig(home)).rejects.toBeInstanceOf(NotionConfigError);
  });

  it('mapNotionStatus is case-insensitive and maps defaults', () => {
    const cfg = defaultNotionConfig('db');
    expect(mapNotionStatus(cfg, 'To Do')).toBe('pending');
    expect(mapNotionStatus(cfg, 'in progress')).toBe('in_progress');
    expect(mapNotionStatus(cfg, 'DONE')).toBe('completed');
    expect(mapNotionStatus(cfg, 'Backlog')).toBe('pending');
    expect(mapNotionStatus(cfg, 'Unknown Stage')).toBeUndefined();
  });

  it('mapNotionPriority is case-insensitive and maps defaults', () => {
    const cfg = defaultNotionConfig('db');
    expect(mapNotionPriority(cfg, 'High')).toBe(2);
    expect(mapNotionPriority(cfg, 'medium')).toBe(1);
    expect(mapNotionPriority(cfg, 'LOW')).toBe(0);
    expect(mapNotionPriority(cfg, 'Urgent')).toBeUndefined();
  });

  it('audit M3 — matches USER-authored mixed-case map keys case-insensitively', () => {
    const cfg = {
      ...defaultNotionConfig('db'),
      statusImport: { 'In Review': 'in_progress' as const },
      priorityImport: { Urgent: 3 },
    };
    expect(mapNotionStatus(cfg, 'in review')).toBe('in_progress');
    expect(mapNotionStatus(cfg, 'IN REVIEW')).toBe('in_progress');
    expect(mapNotionPriority(cfg, 'urgent')).toBe(3);
  });
});
