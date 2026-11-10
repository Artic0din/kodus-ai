/**
 * ChatGPT plan provider module: id `chatgpt_plan`.
 *
 * Runs reviews on an organisation's ChatGPT plan through OpenAI's "Sign in with
 * ChatGPT" plan-usage flow. It is the native OpenAI Responses client with a
 * different transport: every protocol fact (reasoning, structured output,
 * capabilities) delegates to the openai module, and `planFetch` carries the
 * route rules (plan-fetch.ts).
 *
 * The stored credential is `{ id, provider }` and nothing else. `build()` never
 * resolves a token (a review outlives one) and never throws on a missing
 * `organizationId`; both are checked per request.
 */
import type { LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { z } from 'zod';
import { registerProvider } from '../kernel/registry';
import { openaiModule } from '../openai';
import { notStoredByOpenAi } from '../openai/not-stored';
import type { TemperaturePolicy } from '../kernel/model-types';
import type { ModelReasoningTraits } from '../kernel/reasoning-traits';
import type {
    ProviderBuildConfig,
    ProviderBuildOptions,
    ProviderModule,
    ReasoningEffort,
} from '../kernel/types';
import { normalizeSdkResult, normalizeSdkUsage } from '../kernel/usage';
import { planModelListing } from './listing';
import { planFetch } from './plan-fetch';

export const CHATGPT_PLAN_PROVIDER_ID = 'chatgpt_plan';

/** The openai module answers for the plan: it is OpenAI's own model and wire. */
const asOpenAi = (cfg: ProviderBuildConfig): ProviderBuildConfig => ({
    ...cfg,
    provider: 'openai' as ProviderBuildConfig['provider'],
});

export const chatgptPlanModule: ProviderModule = {
    id: CHATGPT_PLAN_PROVIDER_ID,
    label: 'ChatGPT plan',
    doc: 'https://developers.openai.com/siwc/token-sharing-open-source',

    settingsSchema: z.object({}),

    capabilities: (model: string) => openaiModule.capabilities(model),

    build(
        cfg: ProviderBuildConfig,
        opts?: ProviderBuildOptions,
    ): LanguageModel {
        return notStoredByOpenAi(
            createOpenAI({
                // The SDK requires a key; planFetch replaces the header per request.
                apiKey: 'unused',
                fetch: planFetch(opts?.fetch, cfg.organizationId),
            })(cfg.model),
        );
    },

    reasoning: (cfg: ProviderBuildConfig, effort: ReasoningEffort) =>
        openaiModule.reasoning!(asOpenAi(cfg), effort),
    reasoningTraits: (cfg: ProviderBuildConfig): ModelReasoningTraits =>
        openaiModule.reasoningTraits(asOpenAi(cfg)),
    structuredOutputPolicy: (cfg: ProviderBuildConfig, opts) =>
        openaiModule.structuredOutputPolicy(asOpenAi(cfg), opts),

    // The route takes no sampling parameters.
    temperaturePolicy: (): TemperaturePolicy => ({ kind: 'unsupported' }),

    normalizeUsage: normalizeSdkUsage,
    normalize: normalizeSdkResult,

    // No fields: the connect form collects nothing, so `requiresApiKey` derives
    // to false (provider-ui-descriptor).
    uiFields: [],

    providerOptionsNamespace: () => 'openai',
    normalizeReasoningOverride: (namespace, options) =>
        openaiModule.normalizeReasoningOverride!(namespace, options),
    reasoningOverrideExample: (_id, model) =>
        openaiModule.reasoningOverrideExample!('openai', model),
    modelListing: (providerId) =>
        providerId === CHATGPT_PLAN_PROVIDER_ID ? planModelListing : null,
};

registerProvider(chatgptPlanModule);
