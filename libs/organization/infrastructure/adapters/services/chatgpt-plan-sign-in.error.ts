export type ChatGptPlanSignInErrorCode =
    | 'attempt_not_found'
    | 'attempt_expired'
    | 'attempt_used'
    | 'attempt_stale'
    | 'callback_invalid'
    | 'sign_in_declined'
    | 'registration_incomplete'
    | 'client_mismatch'
    | 'code_rejected'
    | 'exchange_failed'
    | 'token_rejected'
    | 'account_mismatch'
    | 'unavailable';

/** What the admin sees. Fixed strings: the OAuth endpoint's own text is never
 *  copied into an error, because it can echo a code, a verifier or a URL. */
const MESSAGES: Record<ChatGptPlanSignInErrorCode, string> = {
    attempt_not_found:
        'This sign-in was not started from this organisation, or a newer one replaced it. Start again.',
    attempt_expired: 'This sign-in expired after 10 minutes. Start again.',
    attempt_used: 'This sign-in address was already used. Start again.',
    attempt_stale:
        'The ChatGPT connection changed while you were signing in. Start again.',
    callback_invalid:
        'Paste the full address the browser landed on. It starts with http://127.0.0.1:1455/auth/callback.',
    sign_in_declined: 'ChatGPT sign-in was cancelled or declined. Start again.',
    registration_incomplete:
        'ChatGPT did not issue a client for this sign-in. Start again.',
    client_mismatch:
        'This sign-in belongs to a different ChatGPT registration. Start again.',
    code_rejected: 'ChatGPT rejected the sign-in code. Start again.',
    exchange_failed: 'ChatGPT did not accept the sign-in. Start again.',
    token_rejected: 'The ChatGPT identity could not be verified. Start again.',
    account_mismatch:
        'That is a different ChatGPT account from the one connected. Choose "Use a different account" to switch.',
    unavailable: 'ChatGPT sign-in is unreachable right now. Try again shortly.',
};

/**
 * Domain error for the sign-in flow. Carries a code and a fixed message and
 * nothing else: never the request, the response, an AxiosError, a URL, the
 * authorisation code, the verifier or a token.
 */
export class ChatGptPlanSignInError extends Error {
    constructor(readonly code: ChatGptPlanSignInErrorCode) {
        super(MESSAGES[code]);
        this.name = 'ChatGptPlanSignInError';
    }
}
