/**
 * The ChatGPT plan route's error codes and what Kodus makes of them.
 *
 * The synthetic status decides both the category (`classifyLLMError` reads the
 * status first) and whether the AI SDK retries (it retries 408, 409, 429 and
 * 5xx), so each row picks the status that yields the wanted behaviour:
 *
 *   code                                          status  category          fails over
 *   subscription_sharing_usage_limit_exceeded     402     QUOTA_EXCEEDED    yes, no SDK retry
 *   subscription_sharing_invalid_user, signed out 401     AUTH_INVALID      yes
 *   subscription_sharing_user_not_eligible,
 *     chatpass_v2_*                               401     AUTH_INVALID      yes
 *   ..._usage_unavailable, ..._user_unavailable   503     TRANSIENT         after SDK retries
 *   truncated stream                              502     TRANSIENT         after SDK retries
 *   ..._unsupported_capability,
 *     ..._route_not_supported                     400     REQUEST_REJECTED  no (adapter bug)
 *
 * A pure leaf: both the request adapter and the error classifier read it.
 */

export const USAGE_LIMIT_CODE = 'subscription_sharing_usage_limit_exceeded';
export const INVALID_USER_CODE = 'subscription_sharing_invalid_user';
export const SIGNED_OUT_CODE = 'chatgpt_plan_signed_out';
export const TOKEN_UNAVAILABLE_CODE = 'chatgpt_plan_token_unavailable';
export const TRUNCATED_STREAM_CODE = 'chatgpt_plan_stream_truncated';
export const NOT_CONFIGURED_CODE = 'chatgpt_plan_not_configured';

export interface PlanRouteError {
    status: number;
    code: string;
    /** Sentence for the error body and for the user. */
    message: string;
}

const USAGE_LIMIT: PlanRouteError = {
    status: 402,
    code: USAGE_LIMIT_CODE,
    message:
        "Your ChatGPT plan's usage limit is reached. Check usage at https://chatgpt.com/settings/usage; reviews resume when it resets.",
};
const SIGN_IN_AGAIN: PlanRouteError = {
    status: 401,
    code: INVALID_USER_CODE,
    message:
        'The ChatGPT sign-in expired or was revoked. Sign in again in the BYOK settings.',
};
const NOT_ELIGIBLE: PlanRouteError = {
    status: 401,
    code: 'subscription_sharing_user_not_eligible',
    message:
        'Plan use is not available for this ChatGPT account. Connect a different account or use another provider.',
};
const UNAVAILABLE: PlanRouteError = {
    status: 503,
    code: 'subscription_sharing_usage_unavailable',
    message: 'The ChatGPT plan is temporarily unavailable. Try again shortly.',
};
const UNSUPPORTED: PlanRouteError = {
    status: 400,
    code: 'subscription_sharing_unsupported_capability',
    message: 'The ChatGPT plan route does not support this request.',
};

const BY_CODE: Record<string, PlanRouteError> = {
    [USAGE_LIMIT_CODE]: USAGE_LIMIT,
    [INVALID_USER_CODE]: SIGN_IN_AGAIN,
    [SIGNED_OUT_CODE]: { ...SIGN_IN_AGAIN, code: SIGNED_OUT_CODE },
    subscription_sharing_user_not_eligible: NOT_ELIGIBLE,
    subscription_sharing_usage_unavailable: UNAVAILABLE,
    subscription_sharing_user_unavailable: {
        ...UNAVAILABLE,
        code: 'subscription_sharing_user_unavailable',
    },
    [TOKEN_UNAVAILABLE_CODE]: { ...UNAVAILABLE, code: TOKEN_UNAVAILABLE_CODE },
    [TRUNCATED_STREAM_CODE]: {
        status: 502,
        code: TRUNCATED_STREAM_CODE,
        message: 'The ChatGPT plan response ended early. Try again shortly.',
    },
    subscription_sharing_unsupported_capability: UNSUPPORTED,
    subscription_sharing_route_not_supported: {
        ...UNSUPPORTED,
        code: 'subscription_sharing_route_not_supported',
    },
    [NOT_CONFIGURED_CODE]: {
        status: 400,
        code: NOT_CONFIGURED_CODE,
        message:
            'The ChatGPT plan is not set up for this organisation. Connect it in the BYOK settings.',
    },
    // Ordinary Responses API failure codes that carry a meaning of their own.
    context_length_exceeded: {
        status: 400,
        code: 'context_length_exceeded',
        message: 'The request exceeds the context length of the model.',
    },
    rate_limit_exceeded: {
        status: 429,
        code: 'rate_limit_exceeded',
        message:
            'Rate limit reached on the ChatGPT plan route. Try again shortly.',
    },
};

/** The row for a route code, or undefined when Kodus has no opinion on it. */
export function planRouteErrorFor(
    code: string | undefined | null,
): PlanRouteError | undefined {
    if (!code) return undefined;
    if (code.startsWith('chatpass_v2_')) {
        return { ...NOT_ELIGIBLE, code };
    }
    return BY_CODE[code];
}

/** A failure the route reported with a code Kodus does not know: a failed
 *  stream is the provider's fault, so it is retry-worthy. */
export function unknownStreamFailure(
    code: string | undefined,
    message: string | undefined,
): PlanRouteError {
    return {
        status: 502,
        code: code ?? 'chatgpt_plan_stream_failed',
        message:
            message || 'The ChatGPT plan request failed. Try again shortly.',
    };
}

const PLAN_ONLY_CODE = /^(subscription_sharing_|chatgpt_plan_)/;

/**
 * The user-facing sentence for an error whose lower-cased text names one of the
 * plan route's own codes, or undefined for any other error. The generic
 * Responses codes (`context_length_exceeded`, ...) are excluded: they appear in
 * other providers' errors too.
 */
export function planRouteCopyFromText(lowerText: string): string | undefined {
    for (const code of Object.keys(BY_CODE)) {
        if (PLAN_ONLY_CODE.test(code) && lowerText.includes(code)) {
            return BY_CODE[code].message;
        }
    }
    return /chatpass_v2_[a-z0-9_]+/.test(lowerText)
        ? NOT_ELIGIBLE.message
        : undefined;
}

/** Route code found in an error body (string or parsed), if any. */
export function planRouteCodeFromBody(body: unknown): string | undefined {
    const text =
        typeof body === 'string'
            ? body
            : (() => {
                  try {
                      return JSON.stringify(body ?? '');
                  } catch {
                      return '';
                  }
              })();
    const match =
        /subscription_sharing_[a-z_]+|chatpass_v2_[a-z0-9_]+|chatgpt_plan_[a-z_]+/.exec(
            text,
        );
    return match?.[0];
}
