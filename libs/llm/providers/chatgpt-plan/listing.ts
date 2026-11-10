import type { CatalogModel, ModelListing } from '../kernel/types';
import { OPENAI_API_BASE_URL } from '../openai/endpoint';
import { bearerHeaders, catalogWithReasoning } from '../kernel/listing-helpers';

/** The plan route lists `{ models: [{ slug, display_name, visibility }] }`;
 *  only entries it marks `list` are offered. */
export function parsePlanModels(body: unknown): CatalogModel[] {
    const models = (body as { models?: unknown } | undefined)?.models;
    if (!Array.isArray(models)) return [];
    return models
        .filter(
            (m): m is { slug: string; display_name?: string } =>
                !!m && typeof m.slug === 'string' && m.visibility === 'list',
        )
        .map((m) =>
            m.display_name
                ? catalogWithReasoning(m.slug, m.display_name)
                : catalogWithReasoning(m.slug),
        );
}

/** The bearer is the org's ChatGPT access token, resolved by the org layer and
 *  passed as `apiKey`; there is no env key and no user-supplied host. */
export const planModelListing: ModelListing = {
    kind: 'http',
    defaultBaseURL: OPENAI_API_BASE_URL,
    timeoutMs: 15_000,
    url: () => `${OPENAI_API_BASE_URL}/models`,
    headers: ({ apiKey }) => bearerHeaders(apiKey),
    parse: parsePlanModels,
};
