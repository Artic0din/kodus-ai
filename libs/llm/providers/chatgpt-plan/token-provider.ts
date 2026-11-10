/**
 * Token provider PORT for the `chatgpt_plan` provider (dependency inversion,
 * like `setLlmObservability`): @libs/llm declares what it needs and the API and
 * worker bootstraps bind the implementation (`ChatGptPlanAuthService`). Absent
 * (a bare unit test, an app that never bound it) means every plan request fails
 * with a configuration error rather than reaching OpenAI unauthenticated.
 */

export type ChatGptPlanTokenErrorCode =
    /** No usable sign-in: never connected, signed out, or refresh token dead. */
    | 'signed_out'
    /** The account may not use plan sharing. */
    | 'not_eligible'
    /** The token endpoint could not be reached or answered 5xx. */
    | 'unavailable';

/** Domain error from the token provider. Carries a code only: never a request,
 *  response, URL or token. */
export class ChatGptPlanTokenError extends Error {
    constructor(
        readonly code: ChatGptPlanTokenErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'ChatGptPlanTokenError';
    }
}

export interface ChatGptPlanTokenProvider {
    /** A bearer for the org. `forceRefresh` skips the expiry check (used after a
     *  real 401). Throws `ChatGptPlanTokenError`. */
    getAccessToken(
        organizationId: string,
        options: { forceRefresh: boolean },
    ): Promise<string>;
}

let current: ChatGptPlanTokenProvider | undefined;

/** Bind the implementation (once, at API and worker bootstrap). */
export function setChatGptPlanTokenProvider(
    impl: ChatGptPlanTokenProvider | undefined,
): void {
    current = impl;
}

export function getChatGptPlanTokenProvider():
    ChatGptPlanTokenProvider | undefined {
    return current;
}
