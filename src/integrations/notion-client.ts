/**
 * Phase 8A — the narrow slice of the `@notionhq/client` surface the
 * connector actually calls, plus the response shapes it reads. Defining a
 * seam here (rather than importing the SDK's enormous generated types)
 * keeps `NotionConnector` testable with a hand-written fake and documents
 * exactly which fields we depend on.
 *
 * The real `@notionhq/client` `Client` is a structural superset of
 * `NotionClientLike`, so it's assignable without a cast (see
 * `createNotionClient`).
 */

/** A Notion rich-text fragment (only the field we read). */
export interface NotionRichText {
  readonly plain_text?: string;
}

/** A single property value on a page (discriminated by `type`). */
export interface NotionPropertyValue {
  readonly type?: string;
  readonly title?: readonly NotionRichText[];
  readonly rich_text?: readonly NotionRichText[];
  readonly status?: { readonly name?: string } | null;
  readonly select?: { readonly name?: string } | null;
  readonly multi_select?: readonly { readonly name?: string }[];
}

/** A page object as returned by `dataSources.query`. */
export interface NotionPage {
  readonly object?: string;
  readonly id: string;
  readonly url?: string;
  readonly properties?: Record<string, NotionPropertyValue>;
}

/** A property entry in a data source's schema (only `type` is read). */
export interface NotionPropertySchema {
  readonly type?: string;
}

/** `dataSources.retrieve` response (only the property schema is read). */
export interface NotionDataSourceObject {
  readonly id: string;
  readonly properties?: Record<string, NotionPropertySchema>;
}

/** `databases.retrieve` response — the `data_sources` array is the new model. */
export interface NotionDatabaseObject {
  readonly id: string;
  readonly data_sources?: readonly { readonly id: string; readonly name?: string }[];
}

export interface NotionQueryResponse {
  readonly results: readonly NotionPage[];
  readonly has_more?: boolean;
  readonly next_cursor?: string | null;
}

export interface NotionQueryArgs {
  readonly data_source_id: string;
  readonly start_cursor?: string;
  readonly page_size?: number;
  readonly sorts?: readonly unknown[];
  readonly filter?: unknown;
}

export interface NotionClientLike {
  readonly databases: {
    retrieve(args: { database_id: string }): Promise<NotionDatabaseObject>;
  };
  readonly dataSources: {
    retrieve(args: { data_source_id: string }): Promise<NotionDataSourceObject>;
    query(args: NotionQueryArgs): Promise<NotionQueryResponse>;
  };
  readonly pages: {
    update(args: {
      page_id: string;
      properties: Record<string, unknown>;
    }): Promise<unknown>;
  };
}

/**
 * Construct a real Notion client. Imports `@notionhq/client` lazily so the
 * dependency never loads in processes that don't use Notion (the CLI cold
 * path, tests with a fake client).
 *
 * The SDK defaults `notionVersion` to `2025-09-03` (the first data-sources
 * release); we set it explicitly for determinism. The SDK retries 429s
 * internally honoring `Retry-After` (`maxRetries`), so the connector's
 * throttle is purely proactive (stay under 3 req/s), not reactive.
 */
export async function createNotionClient(token: string): Promise<NotionClientLike> {
  const { Client } = await import('@notionhq/client');
  const client = new Client({ auth: token, notionVersion: '2025-09-03' });
  return client as unknown as NotionClientLike;
}

/**
 * Best-effort id normalizer: extract a 32-hex Notion id from a pasted URL
 * or a dashed/undashed id. Returns the input trimmed when no 32-hex run is
 * present (the API tolerates both dashed and undashed forms, so a raw id
 * passes through unchanged).
 */
export function normalizeNotionId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.replace(/-/g, '').match(/[0-9a-fA-F]{32}/);
  return match ? match[0] : trimmed;
}

/** Join a rich-text array into a plain string. */
export function joinRichText(parts: readonly NotionRichText[] | undefined): string {
  if (!parts) return '';
  return parts.map((p) => p.plain_text ?? '').join('');
}
