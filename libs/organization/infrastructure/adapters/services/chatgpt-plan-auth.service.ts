import { Inject, Injectable, Optional } from '@nestjs/common';

import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { createLogger } from '@libs/core/log/logger';
import {
    ChatGptPlanTokenError,
    type ChatGptPlanTokenProvider,
} from '@libs/llm/providers/chatgpt-plan/token-provider';

import {
    CHATGPT_PLAN_AUTH_STORE,
    type ChatGptPlanAuthStore,
    type StoredChatGptPlanAuth,
} from './chatgpt-plan-auth.store';

export const CHATGPT_PLAN_TOKEN_ENDPOINT =
    'https://auth.openai.com/api/accounts/oauth/token';
export const CHATGPT_PLAN_RESOURCE = 'https://api.openai.com/v1';

/** Injection token for the HTTP transport, so tests can stand in for OpenAI. */
export const CHATGPT_PLAN_FETCH = Symbol('ChatGptPlanFetch');

/** Refresh when the access token expires within this window. */
const REFRESH_SKEW_MS = 5 * 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;

/** Refresh-token failures that no retry fixes: the user must sign in again. */
const TERMINAL_REFRESH_ERRORS = new Set([
    'invalid_grant',
    'invalid_refresh_token',
    'token_expired',
    'refresh_token_expired',
    'refresh_token_invalidated',
    'refresh_token_reused',
]);

export type ChatGptPlanStatus =
    StoredChatGptPlanAuth['status'] | 'not_connected';

export interface ChatGptPlanAuthStatus {
    status: ChatGptPlanStatus;
    email?: string;
}

/** The slice of the token endpoint's JSON this service reads. */
interface TokenResponse {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    error?: unknown;
    code?: unknown;
}

/** The OAuth error code, whether the endpoint sends `error` as a string, as an
 *  object with a `code`, or a top-level `code`. */
function oauthErrorCode(body: TokenResponse): string | undefined {
    const nested = (body.error as { code?: unknown } | null | undefined)?.code;
    const code = nested ?? body.error ?? body.code;
    return typeof code === 'string' ? code : undefined;
}

type RefreshOutcome =
    | { kind: 'token'; accessToken: string }
    | { kind: 'error'; error: ChatGptPlanTokenError };

/**
 * Owns the `chatgpt_plan_auth` organization_parameters row and hands out the
 * access token the `chatgpt_plan` provider sends.
 *
 * Every write happens under the org's advisory lock, and a refresh re-reads the
 * row under it: refresh tokens rotate, so a worker holding a stale copy must
 * take the newer token instead of spending a dead refresh token. There is no
 * in-process token cache, so a sign-out takes effect in every process on its
 * next call.
 *
 * Errors carry a code and nothing else: never the request, the response, a URL
 * or a token.
 */
@Injectable()
export class ChatGptPlanAuthService implements ChatGptPlanTokenProvider {
    private readonly logger = createLogger(ChatGptPlanAuthService.name);

    constructor(
        @Inject(CHATGPT_PLAN_AUTH_STORE)
        private readonly store: ChatGptPlanAuthStore,
        @Optional()
        @Inject(CHATGPT_PLAN_FETCH)
        private readonly transport: typeof fetch = (input, init) =>
            fetch(input, init),
    ) {}

    async getStatus(organizationId: string): Promise<ChatGptPlanAuthStatus> {
        const row = await this.store.read(organizationId);
        if (!row) return { status: 'not_connected' };
        const hasTokens = !!row.accessToken && !!row.refreshToken;
        return {
            status:
                row.status === 'connected' && !hasTokens
                    ? 'reauth_required'
                    : row.status,
            email: row.email,
        };
    }

    async getAccessToken(
        organizationId: string,
        options: { forceRefresh: boolean },
    ): Promise<string> {
        const seen = this.requireUsable(await this.store.read(organizationId));
        if (!options.forceRefresh && this.isFresh(seen)) {
            return this.open(seen.accessToken);
        }

        const outcome = await this.store.withLock<RefreshOutcome>(
            organizationId,
            async (row) => {
                const current = this.requireUsable(await row.read());
                // Another process refreshed while this one waited for the lock:
                // its token is newer, and the refresh token this process holds is
                // already spent.
                if (
                    current.accessToken !== seen.accessToken &&
                    this.isFresh(current)
                ) {
                    return {
                        kind: 'token',
                        accessToken: this.open(current.accessToken),
                    };
                }
                return this.refresh(organizationId, current, row.write);
            },
        );
        if (outcome.kind === 'error') throw outcome.error;
        return outcome.accessToken;
    }

    private requireUsable(
        row: StoredChatGptPlanAuth | null,
    ): StoredChatGptPlanAuth & { accessToken: string; refreshToken: string } {
        if (row?.status === 'not_eligible') {
            throw new ChatGptPlanTokenError(
                'not_eligible',
                'This ChatGPT account cannot use plan sharing.',
            );
        }
        if (
            !row ||
            row.status !== 'connected' ||
            !row.accessToken ||
            !row.refreshToken
        ) {
            throw new ChatGptPlanTokenError(
                'signed_out',
                'ChatGPT is not signed in for this organisation.',
            );
        }
        return row as StoredChatGptPlanAuth & {
            accessToken: string;
            refreshToken: string;
        };
    }

    private isFresh(row: StoredChatGptPlanAuth): boolean {
        return (
            typeof row.expiresAt === 'number' &&
            row.expiresAt - Date.now() > REFRESH_SKEW_MS
        );
    }

    /** Decrypt a stored token; an unreadable one (rotated crypto key) is a
     *  sign-out, not a crash. */
    private open(ciphertext: string): string {
        try {
            return decrypt(ciphertext);
        } catch {
            throw new ChatGptPlanTokenError(
                'signed_out',
                'The stored ChatGPT sign-in cannot be read.',
            );
        }
    }

    private async refresh(
        organizationId: string,
        current: StoredChatGptPlanAuth & { refreshToken: string },
        write: (value: StoredChatGptPlanAuth) => Promise<void>,
    ): Promise<RefreshOutcome> {
        let refreshToken: string;
        try {
            refreshToken = this.open(current.refreshToken);
        } catch (error) {
            return { kind: 'error', error: error as ChatGptPlanTokenError };
        }

        let response: Response;
        try {
            response = await this.transport(CHATGPT_PLAN_TOKEN_ENDPOINT, {
                method: 'POST',
                headers: {
                    'content-type': 'application/x-www-form-urlencoded',
                    'accept': 'application/json',
                },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    client_id: current.clientId ?? '',
                    refresh_token: refreshToken,
                    resource: CHATGPT_PLAN_RESOURCE,
                }).toString(),
                signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
            });
        } catch {
            this.logRefreshFailure(organizationId, 'transport');
            return {
                kind: 'error',
                error: new ChatGptPlanTokenError(
                    'unavailable',
                    'The ChatGPT token endpoint could not be reached.',
                ),
            };
        }

        let body: TokenResponse;
        try {
            body = (await response.json()) as TokenResponse;
        } catch {
            body = {};
        }

        if (!response.ok) {
            const code = oauthErrorCode(body);
            const rejected =
                code === 'invalid_client' ||
                (code !== undefined && TERMINAL_REFRESH_ERRORS.has(code));
            // Only a code Kodus knows is logged; anything else is the endpoint's
            // free text, so the HTTP status stands in.
            this.logRefreshFailure(
                organizationId,
                rejected ? code : response.status,
            );
            if (rejected) {
                // Keep the registration, the subject and the ID token so the
                // next sign-in is a returning one; a rejected client id must
                // not be reused, so the next sign-in registers again.
                await write({
                    ...current,
                    status: 'reauth_required',
                    accessToken: undefined,
                    refreshToken: undefined,
                    expiresAt: undefined,
                    ...(code === 'invalid_client'
                        ? { clientId: undefined }
                        : {}),
                });
                return {
                    kind: 'error',
                    error: new ChatGptPlanTokenError(
                        'signed_out',
                        'The ChatGPT sign-in expired. Sign in again.',
                    ),
                };
            }
            return {
                kind: 'error',
                error: new ChatGptPlanTokenError(
                    'unavailable',
                    'The ChatGPT token endpoint refused the refresh.',
                ),
            };
        }

        const accessToken: unknown = body.access_token;
        if (typeof accessToken !== 'string' || !accessToken) {
            this.logRefreshFailure(organizationId, 'malformed');
            return {
                kind: 'error',
                error: new ChatGptPlanTokenError(
                    'unavailable',
                    'The ChatGPT token endpoint returned no access token.',
                ),
            };
        }
        const expiresIn = Number(body.expires_in);
        await write({
            ...current,
            status: 'connected',
            accessToken: encrypt(accessToken),
            // The refresh token rotates; keep the old one only if none came back.
            refreshToken:
                typeof body.refresh_token === 'string' && body.refresh_token
                    ? encrypt(body.refresh_token)
                    : current.refreshToken,
            idToken:
                typeof body.id_token === 'string' && body.id_token
                    ? encrypt(body.id_token)
                    : current.idToken,
            expiresAt:
                Date.now() +
                (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
            scopes:
                typeof body.scope === 'string'
                    ? body.scope.split(' ').filter(Boolean)
                    : current.scopes,
        });
        return { kind: 'token', accessToken };
    }

    private logRefreshFailure(
        organizationId: string,
        reason: string | number,
    ): void {
        this.logger.warn({
            message: 'ChatGPT plan token refresh failed',
            context: ChatGptPlanAuthService.name,
            metadata: { organizationId, reason },
        });
    }
}
