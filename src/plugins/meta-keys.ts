/**
 * Phase 7B.3 — host-side names for the MCP `_meta` keys the SDK attaches
 * to a plugin's tools.
 *
 * The SDK (`packages/plugin-sdk/src/plugin.ts`) writes these on every tool
 * it registers; they survive the `listTools()` round-trip (proven by
 * `tests/plugins/7b1-sdk-builder.unit.test.ts`). The host reads them at
 * load time to:
 *   - keep `on_<event>` handler tools OUT of Maestro's toolbelt
 *     (`SYMPHONY_META_EVENT_HANDLER`), and
 *   - enforce a per-tool permission ceiling against the manifest's
 *     declared `permissions` (`SYMPHONY_META_PERMISSIONS`).
 *
 * These are an INDEPENDENT duplicate of the SDK's constants — the host
 * (the root `symphony` package) does not import the `@symphony/plugin-sdk`
 * workspace package (same posture as the duplicated manifest schema in
 * 7B.1). The `'7B.3 meta-key drift lock'` describe block in
 * `tests/plugins/7b3-host-enrichment.unit.test.ts` pins these to the SDK's
 * values so the two can never silently desync.
 */

/** Marks an `on_<event>` handler tool — hidden from Maestro's toolbelt. */
export const SYMPHONY_META_EVENT_HANDLER = 'symphony/eventHandler' as const;

/** Carries a tool's required `PluginPermission[]` (consent ceiling). */
export const SYMPHONY_META_PERMISSIONS = 'symphony/permissions' as const;
