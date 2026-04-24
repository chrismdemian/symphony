/**
 * Phase 2B.1 state-layer errors. Thrown before the MCP transport binds,
 * so the operator sees a typed failure instead of a half-corrupted DB.
 */

export class DatabaseSchemaMismatchError extends Error {
  readonly code = 'DB_SCHEMA_MISMATCH';
  readonly dbPath: string;
  readonly missingInvariants: readonly string[];

  constructor(dbPath: string, missingInvariants: readonly string[]) {
    const suffix = missingInvariants.length > 0 ? ` (${missingInvariants.join(', ')})` : '';
    super(`Database schema mismatch at ${dbPath}${suffix}`);
    this.name = 'DatabaseSchemaMismatchError';
    this.dbPath = dbPath;
    this.missingInvariants = missingInvariants;
  }
}

export class CorruptRecordError extends Error {
  readonly code = 'DB_CORRUPT_RECORD';
  readonly table: string;
  readonly recordId: string;
  readonly column: string;

  constructor(table: string, recordId: string, column: string, detail: string) {
    super(`Corrupt record in '${table}' (id=${recordId}, column=${column}): ${detail}`);
    this.name = 'CorruptRecordError';
    this.table = table;
    this.recordId = recordId;
    this.column = column;
  }
}
