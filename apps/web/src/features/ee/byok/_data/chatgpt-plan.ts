/**
 * The `chatgpt_plan` BYOK provider: models run on the org's ChatGPT plan, not an
 * API key. Web mirror of the backend provider id (the web bundle cannot import a
 * value from libs/llm).
 */
export const CHATGPT_PLAN_PROVIDER_ID = "chatgpt_plan";

export const isChatGptPlanProvider = (provider?: string | null): boolean =>
    provider === CHATGPT_PLAN_PROVIDER_ID;

/** Where a user reviews each app's share of their ChatGPT plan. */
export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
