/**
 * Shared constants for the live-test harness.
 *
 * Kept in their own module because importing a constant from `seed-test-channel.ts` would execute
 * that script's `main()` as an import side effect — re-seeding the channel every time any other
 * script merely wanted the page id.
 */
export const TEST_CHANNEL_TYPE = 'facebook' as const;

/** The fake Meta page id the harness addresses. Must match the seeded channel's external_id. */
export const TEST_PAGE_ID = process.env.LIVETEST_PAGE_ID ?? '100000000000001';

/** Catalog-rich tenant, so retrieval and the grounding gate have real products to work with. */
export const TEST_TENANT_NAME = process.env.LIVETEST_TENANT ?? 'ProteinPluss';

/** Default synthetic customer. The RC-06 toggle test uses its own so the flows never interleave. */
export const TEST_CONTACT_ID = process.env.LIVETEST_CONTACT_ID ?? '900000000000001';

export const BACKEND = process.env.LIVETEST_BACKEND ?? `http://localhost:${process.env.PORT ?? '8000'}`;
