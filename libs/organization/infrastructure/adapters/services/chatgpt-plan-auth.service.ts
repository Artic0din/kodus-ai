import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';

import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { createLogger } from '@libs/core/log/logger';
import {
    ChatGptPlanTokenError,
    type ChatGptPlanTokenProvider,
} from '@libs/llm/providers/chatgpt-plan/token-provider';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { isByokConfig, type BYOKConfig } from '@libs/llm/byok-config';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';

import { verifyIdToken } from './chatgpt-plan-id-token';
import {
    CHATGPT_PLAN_RESOURCE,
    CHATGPT_PLAN_REDIRECT_URI,
    CHATGPT_PLAN_TOKEN_ENDPOINT,
    CHATGPT_PLAN_USE_SCOPE,
    buildAuthorizeUrl,
    exchangeAuthorizationCode,
    fetchJwks,
    isIssuedClientId,
    revokeRefreshToken,
} from './chatgpt-plan-oauth';
import { ChatGptPlanSignInError } from './chatgpt-plan-sign-in.error';
import {
    CHATGPT_PLAN_SIGN_IN_STORE,
    type ChatGptPlanSignInStore,
} from './chatgpt-plan-sign-in.store';
import {
    CHATGPT_PLAN_AUTH_STORE,
    type ChatGptPlanAuthStore,
    type StoredChatGptPlanAuth,
} from './chatgpt-plan-auth.store';

export { CHATGPT_PLAN_RESOURCE, CHATGPT_PLAN_TOKEN_ENDPOINT };

/** Injection token for the HTTP transport, so tests can stand in for OpenAI. */
export const CHATGPT_PLAN_FETCH = Symbol('ChatGptPlanFetch');

/** Refresh when the access token expires within this window. */
const REFRESH_SKEW_MS = 5 * 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const SIGN_IN_TTL_MS = 10 * 60_000;
const MAX_CALLBACK_LENGTH = 4096;

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

export interface ChatGptPlanSignInContext {
    organizationId: string;
    userId: string;
}

export type ChatGptPlanSignInResult =
    | { outcome: 'connected'; email?: string }
    /** The ID token was valid but OpenAI did not grant plan use; offer the
     *  consent retry (the next sign-in sends `prompt=consent`). */
    | { outcome: 'plan_not_granted'; email?: string };

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
        @Optional()
        @Inject(CHATGPT_PLAN_SIGN_IN_STORE)
        private readonly signInStore?: ChatGptPlanSignInStore,
        @Optional()
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParameters?: IOrganizationParametersService,
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

    /**
     * Starts a sign-in: saves a single-use, 10-minute attempt bound to the
     * user and organisation, and returns the OpenAI address for the admin's
     * browser. A saved registration gives a returning sign-in; none, or
     * `differentAccount`, registers a new client. The row is not touched
     * until the new sign-in is validated.
     */
    async startSignIn(
        ctx: ChatGptPlanSignInContext,
        options: { differentAccount?: boolean } = {},
    ): Promise<{ authorizeUrl: string; expiresAt: number }> {
        const signInStore = this.requireSignInStore();
        const row = await this.store.read(ctx.organizationId);
        const returning = !options.differentAccount && !!row?.clientId;

        const hostId = await signInStore.getOrCreateHostId();
        const state = randomBytes(32).toString('hex');
        const nonce = randomBytes(32).toString('hex');
        const verifier = randomBytes(48).toString('base64url');
        const expiresAt = Date.now() + SIGN_IN_TTL_MS;

        await signInStore.createAttempt(
            {
                state,
                nonce,
                codeVerifier: encrypt(verifier),
                organizationId: ctx.organizationId,
                userId: ctx.userId,
                clientId: returning ? row?.clientId : undefined,
                expectedSub: returning ? row?.sub : undefined,
                expiresAt: new Date(expiresAt),
            },
            new Date(),
        );

        return {
            authorizeUrl: buildAuthorizeUrl({
                hostId,
                clientId: returning ? row?.clientId : undefined,
                state,
                nonce,
                codeChallenge: createHash('sha256')
                    .update(verifier)
                    .digest('base64url'),
                idTokenHint:
                    returning && row?.idToken
                        ? this.tryOpen(row.idToken)
                        : undefined,
                loginHint: returning ? row?.email : undefined,
                promptConsent: returning && row?.needsConsent === true,
            }),
            expiresAt,
        };
    }

    /**
     * Finishes a sign-in from the address the browser landed on. Validates the
     * attempt, state and redirect, exchanges the code, verifies the ID token,
     * and only then replaces the stored connection. Every failure is a
     * `ChatGptPlanSignInError`: a code and a fixed message, nothing else.
     */
    async completeSignIn(
        ctx: ChatGptPlanSignInContext,
        callbackUrl: string,
    ): Promise<ChatGptPlanSignInResult> {
        const signInStore = this.requireSignInStore();
        const params = this.parseCallback(callbackUrl);
        const state = params.get('state');
        if (!state) throw new ChatGptPlanSignInError('callback_invalid');

        const claim = await signInStore.claimAttempt({
            state,
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            now: new Date(),
        });
        if (claim.kind !== 'claimed') {
            throw new ChatGptPlanSignInError(
                claim.kind === 'missing'
                    ? 'attempt_not_found'
                    : claim.kind === 'expired'
                      ? 'attempt_expired'
                      : 'attempt_used',
            );
        }
        const { attempt } = claim;

        if (params.get('error')) {
            throw new ChatGptPlanSignInError('sign_in_declined');
        }
        const suppliedClientId = params.get('client_id');
        let clientId: string;
        if (attempt.clientId) {
            if (suppliedClientId && suppliedClientId !== attempt.clientId) {
                throw new ChatGptPlanSignInError('client_mismatch');
            }
            clientId = attempt.clientId;
        } else {
            if (!isIssuedClientId(suppliedClientId)) {
                throw new ChatGptPlanSignInError('registration_incomplete');
            }
            clientId = suppliedClientId;
        }
        const code = params.get('code');
        if (!code) throw new ChatGptPlanSignInError('callback_invalid');

        let codeVerifier: string;
        try {
            codeVerifier = decrypt(attempt.codeVerifier);
        } catch {
            throw new ChatGptPlanSignInError('attempt_stale');
        }

        const grant = await exchangeAuthorizationCode(this.transport, {
            clientId,
            code,
            codeVerifier,
        });
        const identity = verifyIdToken(
            grant.idToken,
            await fetchJwks(this.transport),
            {
                clientId,
                nonce: attempt.nonce,
                nowSeconds: Math.floor(Date.now() / 1000),
            },
        );
        // A returning sign-in must prove it is the same account; with no stored
        // subject to compare against it fails closed.
        if (attempt.clientId && identity.sub !== attempt.expectedSub) {
            throw new ChatGptPlanSignInError('account_mismatch');
        }

        const planGranted = grant.scopes.includes(CHATGPT_PLAN_USE_SCOPE);
        await this.store.withLock(ctx.organizationId, async (row) => {
            const current = await row.read();
            // A returning sign-in must still target the registration it started
            // from: someone may have switched account in the meantime.
            if (attempt.clientId && current?.clientId !== attempt.clientId) {
                throw new ChatGptPlanSignInError('attempt_stale');
            }
            const identityFields = {
                clientId,
                sub: identity.sub,
                email: identity.email,
                idToken: encrypt(grant.idToken),
            };
            // Valid identity without plan use: keep the registration so the
            // retry is a returning sign-in, but store no tokens.
            await row.write(
                planGranted
                    ? {
                          ...identityFields,
                          status: 'connected',
                          accessToken: encrypt(grant.accessToken),
                          refreshToken: encrypt(grant.refreshToken),
                          expiresAt: Date.now() + grant.expiresInSeconds * 1000,
                          scopes: grant.scopes,
                      }
                    : {
                          ...identityFields,
                          status: 'reauth_required',
                          needsConsent: true,
                      },
            );
        });

        if (!planGranted) {
            return { outcome: 'plan_not_granted', email: identity.email };
        }
        try {
            await this.ensureByokCredential(ctx.organizationId);
        } catch {
            // The connection is already saved; Test & save adds the credential
            // if this write failed, so the admin is not told the sign-in failed.
            this.logger.warn({
                message: 'Could not add the ChatGPT plan credential to BYOK_CONFIG',
                context: ChatGptPlanAuthService.name,
                metadata: { organizationId: ctx.organizationId },
            });
        }
        return { outcome: 'connected', email: identity.email };
    }

    /**
     * Signs the organisation out of ChatGPT: revokes the renewable session at
     * OpenAI (best effort), then clears the tokens and ID token. The client
     * id, subject and BYOK credential stay, so the next sign-in is a returning
     * one. `revocationConfirmed` is false when OpenAI did not confirm.
     */
    async signOut(
        organizationId: string,
    ): Promise<{ revocationConfirmed: boolean }> {
        return this.store.withLock(organizationId, async (row) => {
            const current = await row.read();
            if (!current) return { revocationConfirmed: true };

            let revocationConfirmed = true;
            if (current.refreshToken) {
                revocationConfirmed = false;
                const refreshToken = this.tryOpen(current.refreshToken);
                if (refreshToken && current.clientId) {
                    revocationConfirmed = await revokeRefreshToken(
                        this.transport,
                        { clientId: current.clientId, refreshToken },
                    );
                }
            }
            await row.write({
                ...current,
                status: 'reauth_required',
                accessToken: undefined,
                refreshToken: undefined,
                idToken: undefined,
                expiresAt: undefined,
                scopes: undefined,
                needsConsent: undefined,
            });
            if (!revocationConfirmed) {
                this.logger.warn({
                    message: 'ChatGPT plan revocation was not confirmed',
                    context: ChatGptPlanAuthService.name,
                    metadata: { organizationId },
                });
            }
            return { revocationConfirmed };
        });
    }

    private requireSignInStore(): ChatGptPlanSignInStore {
        if (!this.signInStore || !this.organizationParameters) {
            throw new Error('ChatGPT plan sign-in is not configured.');
        }
        return this.signInStore;
    }

    private parseCallback(raw: string): URLSearchParams {
        if (typeof raw !== 'string' || raw.length > MAX_CALLBACK_LENGTH) {
            throw new ChatGptPlanSignInError('callback_invalid');
        }
        let url: URL;
        try {
            url = new URL(raw.trim());
        } catch {
            throw new ChatGptPlanSignInError('callback_invalid');
        }
        if (`${url.origin}${url.pathname}` !== CHATGPT_PLAN_REDIRECT_URI) {
            throw new ChatGptPlanSignInError('callback_invalid');
        }
        return url.searchParams;
    }

    private tryOpen(ciphertext: string): string | undefined {
        try {
            return decrypt(ciphertext) || undefined;
        } catch {
            return undefined;
        }
    }

    /**
     * Adds `{ id, provider: 'chatgpt_plan' }` to BYOK_CONFIG when the org has
     * no such credential. This is the only place the service writes
     * BYOK_CONFIG; an existing config is otherwise written back untouched.
     */
    private async ensureByokCredential(organizationId: string): Promise<void> {
        const parameters = this.organizationParameters;
        if (!parameters) return;
        const scope = { organizationId };
        const existing = await parameters.findByKey(
            OrganizationParametersKey.BYOK_CONFIG,
            scope,
        );
        const config: unknown = existing?.configValue;
        const credential = { id: randomUUID(), provider: 'chatgpt_plan' };

        let next: BYOKConfig;
        if (isByokConfig(config)) {
            if (config.credentials.some((c) => c.provider === 'chatgpt_plan')) {
                return;
            }
            next = { ...config, credentials: [...config.credentials, credential] };
        } else if (config == null) {
            next = { version: 2, credentials: [credential], models: [] };
        } else {
            // A stored shape this version does not know is not ours to rewrite.
            this.logger.warn({
                message: 'Left an unrecognised BYOK_CONFIG untouched',
                context: ChatGptPlanAuthService.name,
                metadata: { organizationId },
            });
            return;
        }
        await parameters.createOrUpdateConfig(
            OrganizationParametersKey.BYOK_CONFIG,
            next,
            scope,
        );
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
