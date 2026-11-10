import type { Jwk } from './chatgpt-plan-id-token';
import { ChatGptPlanSignInError } from './chatgpt-plan-sign-in.error';

export const CHATGPT_PLAN_TOKEN_ENDPOINT =
    'https://auth.openai.com/api/accounts/oauth/token';
export const CHATGPT_PLAN_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_PLAN_AUTHORIZE_ENDPOINT =
    'https://auth.openai.com/api/accounts/authorize';
/** `revocation_endpoint` from https://auth.openai.com/.well-known/openid-configuration */
export const CHATGPT_PLAN_REVOCATION_ENDPOINT =
    'https://auth.openai.com/api/accounts/oauth/revoke';
export const CHATGPT_PLAN_JWKS_URI =
    'https://auth.openai.com/.well-known/jwks.json';
export const CHATGPT_PLAN_REDIRECT_URI =
    'http://127.0.0.1:1455/auth/callback';
export const CHATGPT_PLAN_USE_SCOPE = 'chatgpt.tokens.use.direct';
export const CHATGPT_PLAN_SCOPES = [
    'openid',
    'profile',
    'email',
    'offline_access',
    'resource.invoke',
    CHATGPT_PLAN_USE_SCOPE,
];
/** First-registration entrypoint; never saved as the connection's client id. */
export const CHATGPT_PLAN_DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const CHATGPT_PLAN_AGENT_NAME = 'Kodus';

const REQUEST_TIMEOUT_MS = 15_000;
const REVOKE_RETRY_DELAY_MS = 300;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,255}$/;

export function isIssuedClientId(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value !== CHATGPT_PLAN_DYNAMIC_CLIENT_ID &&
        CLIENT_ID_PATTERN.test(value)
    );
}

export interface AuthorizeUrlInput {
    hostId: string;
    /** Saved issued client id (returning sign-in). Absent registers anew. */
    clientId?: string;
    state: string;
    nonce: string;
    codeChallenge: string;
    idTokenHint?: string;
    loginHint?: string;
    promptConsent?: boolean;
}

/** The browser address that starts a sign-in. Contains the retained ID token as
 *  `id_token_hint` for a returning sign-in, so callers must not log it. */
export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
    const returning = !!input.clientId;
    const params: Array<[string, string]> = [
        ['client_id', input.clientId ?? CHATGPT_PLAN_DYNAMIC_CLIENT_ID],
        ['ext_agent_host_id', input.hostId],
        ['response_type', 'code'],
        ['redirect_uri', CHATGPT_PLAN_REDIRECT_URI],
        ['scope', CHATGPT_PLAN_SCOPES.join(' ')],
        ['resource', CHATGPT_PLAN_RESOURCE],
        ['state', input.state],
        ['nonce', input.nonce],
        ['code_challenge_method', 'S256'],
        ['code_challenge', input.codeChallenge],
    ];
    // The agent name is display metadata for the first registration only.
    if (!returning) params.push(['agent_name_hint', CHATGPT_PLAN_AGENT_NAME]);
    if (returning && input.idTokenHint) {
        params.push(['id_token_hint', input.idTokenHint]);
    }
    if (returning && input.loginHint) {
        params.push(['login_hint', input.loginHint]);
    }
    if (input.promptConsent) params.push(['prompt', 'consent']);

    const query = params
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    return `${CHATGPT_PLAN_AUTHORIZE_ENDPOINT}?${query}`;
}

interface HttpResult {
    status: number;
    body: Record<string, unknown>;
}

/**
 * The only place that talks to OpenAI's auth server. Every transport failure,
 * timeout and non-2xx collapses to a status and a parsed body: no request, no
 * response object, no URL ever leaves this function.
 */
async function send(
    transport: typeof fetch,
    url: string,
    init: { method: 'GET' | 'POST'; form?: Record<string, string> },
): Promise<HttpResult> {
    let response: Response;
    try {
        response = await transport(url, {
            method: init.method,
            headers: {
                accept: 'application/json',
                ...(init.form
                    ? { 'content-type': 'application/x-www-form-urlencoded' }
                    : {}),
            },
            body: init.form
                ? new URLSearchParams(init.form).toString()
                : undefined,
            redirect: 'error',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch {
        throw new ChatGptPlanSignInError('unavailable');
    }
    let body: Record<string, unknown> = {};
    try {
        const parsed: unknown = await response.json();
        if (parsed && typeof parsed === 'object') {
            body = parsed as Record<string, unknown>;
        }
    } catch {
        // An empty or non-JSON body (revocation answers an empty 200).
    }
    return { status: response.status, body };
}

function errorCode(body: Record<string, unknown>): string | undefined {
    const nested = (body.error as { code?: unknown } | null | undefined)?.code;
    const code = nested ?? body.error ?? body.code;
    return typeof code === 'string' ? code : undefined;
}

export interface TokenGrant {
    accessToken: string;
    refreshToken: string;
    idToken: string;
    expiresInSeconds: number;
    scopes: string[];
}

/** Exchanges the authorisation code from the pasted callback. */
export async function exchangeAuthorizationCode(
    transport: typeof fetch,
    input: { clientId: string; code: string; codeVerifier: string },
): Promise<TokenGrant> {
    const { status, body } = await send(transport, CHATGPT_PLAN_TOKEN_ENDPOINT, {
        method: 'POST',
        form: {
            grant_type: 'authorization_code',
            client_id: input.clientId,
            code: input.code,
            code_verifier: input.codeVerifier,
            redirect_uri: CHATGPT_PLAN_REDIRECT_URI,
            resource: CHATGPT_PLAN_RESOURCE,
        },
    });

    if (status >= 500) throw new ChatGptPlanSignInError('unavailable');
    if (status < 200 || status >= 300) {
        throw new ChatGptPlanSignInError(
            errorCode(body) === 'invalid_grant'
                ? 'code_rejected'
                : 'exchange_failed',
        );
    }

    const { access_token, refresh_token, id_token, expires_in, scope } = body;
    if (
        typeof access_token !== 'string' ||
        !access_token ||
        typeof refresh_token !== 'string' ||
        !refresh_token ||
        typeof id_token !== 'string' ||
        !id_token
    ) {
        throw new ChatGptPlanSignInError('exchange_failed');
    }
    const expiresIn = Number(expires_in);
    return {
        accessToken: access_token,
        refreshToken: refresh_token,
        idToken: id_token,
        expiresInSeconds: Number.isFinite(expiresIn) ? expiresIn : 3600,
        scopes:
            typeof scope === 'string' ? scope.split(' ').filter(Boolean) : [],
    };
}

export async function fetchJwks(transport: typeof fetch): Promise<Jwk[]> {
    const { status, body } = await send(transport, CHATGPT_PLAN_JWKS_URI, {
        method: 'GET',
    });
    if (status < 200 || status >= 300 || !Array.isArray(body.keys)) {
        throw new ChatGptPlanSignInError('unavailable');
    }
    return body.keys as Jwk[];
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Ends the renewable session at OpenAI. An empty 200 is the success answer,
 * including for an already-dead token. A network failure or 5xx is retried
 * once; the result says whether OpenAI confirmed, and never throws.
 */
export async function revokeRefreshToken(
    transport: typeof fetch,
    input: { clientId: string; refreshToken: string },
): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const { status } = await send(
                transport,
                CHATGPT_PLAN_REVOCATION_ENDPOINT,
                {
                    method: 'POST',
                    form: {
                        token: input.refreshToken,
                        token_type_hint: 'refresh_token',
                        client_id: input.clientId,
                    },
                },
            );
            if (status >= 200 && status < 300) return true;
            if (status < 500) return false;
        } catch {
            // transport failure: fall through to the retry
        }
        if (attempt === 0) await wait(REVOKE_RETRY_DELAY_MS);
    }
    return false;
}
