import {
    createHash,
    createSign,
    generateKeyPairSync,
    type KeyObject,
} from 'node:crypto';

import type { ChatGptPlanAuthStore, LockedChatGptPlanAuth, StoredChatGptPlanAuth } from '../chatgpt-plan-auth.store';
import type {
    ChatGptPlanSignInStore,
    NewSignInAttempt,
    SignInAttemptClaim,
} from '../chatgpt-plan-sign-in.store';

export const KID = 'test-key-1';
export const CLIENT_ID = 'oaiapp_issued_1';

const b64url = (value: Buffer | string) =>
    Buffer.from(value).toString('base64url');

export interface KeyPair {
    privateKey: KeyObject;
    jwk: Record<string, unknown>;
}

export function newKeyPair(kid = KID): KeyPair {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
    });
    return {
        privateKey,
        jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' },
    };
}

/** Signs a compact JWT. `alg` only changes the header; the signature is always
 *  RSA-SHA256, which is what a forger who flips the header would send. */
export function signJwt(
    claims: Record<string, unknown>,
    options: { key: KeyPair['privateKey']; kid?: string; alg?: string },
): string {
    const header = b64url(
        JSON.stringify({ alg: options.alg ?? 'RS256', kid: options.kid ?? KID, typ: 'JWT' }),
    );
    const payload = b64url(JSON.stringify(claims));
    const signature = createSign('RSA-SHA256')
        .update(`${header}.${payload}`)
        .sign(options.key);
    return `${header}.${payload}.${b64url(signature)}`;
}

export interface IssueOptions {
    sub?: string;
    email?: string;
    scope?: string;
    /** Callback carries no client_id (allowed for a returning sign-in). */
    omitClientId?: boolean;
    /** Callback carries this client_id instead of the issued one. */
    callbackClientId?: string;
    /** Callback carries `error=access_denied` instead of a code. */
    deny?: boolean;
    /** Issue `aud` as `[clientId, 'other']`, which OIDC allows. */
    audienceAsArray?: boolean;
    /** Mutations of the ID token claims, applied after the defaults. */
    claims?: Record<string, unknown>;
    /** Sign with this key instead of the published one (a forgery). */
    signWith?: KeyPair['privateKey'];
    alg?: string;
}

interface IssuedCode {
    clientId: string;
    nonce: string;
    challenge: string;
    options: IssueOptions;
}

export interface FakeCall {
    url: string;
    method: string;
    form: URLSearchParams;
}

/**
 * Stands in for auth.openai.com: serves the JWKS, plays the browser step
 * (`authorize`) and answers the token and revocation endpoints. Every PKCE
 * check is real, so a wrong verifier fails like it would in production.
 */
export class FakeAuthServer {
    readonly keys = newKeyPair();
    readonly calls: FakeCall[] = [];
    private readonly codes = new Map<string, IssuedCode>();
    private counter = 0;
    /** Next token-endpoint response, when a test needs to force one. */
    tokenOverride?: () => Response;
    revokeStatus: Array<number | 'network'> = [200];
    jwksStatus = 200;
    lastAuthorizeParams?: URLSearchParams;

    readonly transport: typeof fetch = async (input, init) => {
        const url = String(input);
        const form = new URLSearchParams(String(init?.body ?? ''));
        this.calls.push({ url, method: String(init?.method ?? 'GET'), form });

        if (url.endsWith('/.well-known/jwks.json')) {
            return new Response(JSON.stringify({ keys: [this.keys.jwk] }), {
                status: this.jwksStatus,
            });
        }
        if (url.endsWith('/oauth/revoke')) {
            const next = this.revokeStatus.length > 1
                ? this.revokeStatus.shift()!
                : this.revokeStatus[0];
            if (next === 'network') throw new Error('boom: https://auth.openai.com/oauth/revoke');
            return new Response('', { status: next });
        }
        if (url.endsWith('/oauth/token')) return this.token(form);
        throw new Error(`unexpected request ${url}`);
    };

    /** The browser step: validates the authorize URL, returns the address the
     *  browser lands on. */
    authorize(authorizeUrl: string, options: IssueOptions = {}): string {
        const url = new URL(authorizeUrl);
        const params = url.searchParams;
        this.lastAuthorizeParams = params;
        const state = params.get('state')!;
        if (options.deny) {
            return `http://127.0.0.1:1455/auth/callback?error=access_denied&state=${state}`;
        }
        const clientId =
            params.get('client_id') === 'dynamic_agent_client'
                ? `${CLIENT_ID}_${++this.counter}`
                : params.get('client_id')!;
        const code = `code-${state.slice(0, 8)}-${++this.counter}`;
        this.codes.set(code, {
            clientId,
            nonce: params.get('nonce')!,
            challenge: params.get('code_challenge')!,
            options,
        });
        const query = new URLSearchParams({
            code,
            scope:
                options.scope ??
                'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
            state,
        });
        const callbackClientId = options.callbackClientId ?? clientId;
        if (!options.omitClientId) query.set('client_id', callbackClientId);
        return `http://127.0.0.1:1455/auth/callback?${query.toString()}`;
    }

    private token(form: URLSearchParams): Response {
        if (this.tokenOverride) return this.tokenOverride();
        const issued = this.codes.get(form.get('code') ?? '');
        const bad = (error: string) =>
            new Response(
                JSON.stringify({ error, error_description: 'detail with code secret-detail' }),
                { status: 400 },
            );
        if (!issued || form.get('grant_type') !== 'authorization_code') {
            return bad('invalid_grant');
        }
        const verifierHash = createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url');
        if (
            verifierHash !== issued.challenge ||
            form.get('client_id') !== issued.clientId ||
            form.get('redirect_uri') !== 'http://127.0.0.1:1455/auth/callback' ||
            form.get('resource') !== 'https://api.openai.com/v1'
        ) {
            return bad('invalid_grant');
        }
        this.codes.delete(form.get('code')!);

        const { options } = issued;
        const now = Math.floor(Date.now() / 1000);
        const idToken = signJwt(
            {
                iss: 'https://auth.openai.com',
                aud: issued.clientId,
                sub: options.sub ?? 'sub-1',
                email: options.email ?? 'owner@example.com',
                nonce: issued.nonce,
                iat: now,
                exp: now + 3600,
                ...(options.audienceAsArray
                    ? { aud: [issued.clientId, 'another-audience'] }
                    : {}),
                ...options.claims,
            },
            {
                key: options.signWith ?? this.keys.privateKey,
                alg: options.alg,
            },
        );
        return new Response(
            JSON.stringify({
                access_token: `access-${this.counter}`,
                refresh_token: `refresh-${this.counter}`,
                id_token: idToken,
                expires_in: 3600,
                scope:
                    options.scope ??
                    'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
            }),
            { status: 200 },
        );
    }
}

/** Postgres stand-in for the auth row: one row per org, writes commit on
 *  success and vanish on a throw, like the real transaction. */
export class InMemoryAuthStore implements ChatGptPlanAuthStore {
    readonly rows = new Map<string, StoredChatGptPlanAuth>();
    private queue: Promise<unknown> = Promise.resolve();

    async read(org: string): Promise<StoredChatGptPlanAuth | null> {
        const row = this.rows.get(org);
        return row ? { ...row } : null;
    }

    withLock<T>(
        org: string,
        fn: (row: LockedChatGptPlanAuth) => Promise<T>,
    ): Promise<T> {
        const run = this.queue.then(async () => {
            let staged: StoredChatGptPlanAuth | undefined;
            const result = await fn({
                read: async () => {
                    const row = staged ?? this.rows.get(org);
                    return row ? { ...row } : null;
                },
                write: async (value) => {
                    staged = { ...value };
                },
            });
            if (staged) this.rows.set(org, staged);
            return result;
        });
        this.queue = run.catch(() => undefined);
        return run;
    }
}

interface StoredAttempt extends NewSignInAttempt {
    consumedAt?: Date;
}

export class InMemorySignInStore implements ChatGptPlanSignInStore {
    readonly attempts: StoredAttempt[] = [];
    hostId = 'urn:uuid:11111111-1111-4111-8111-111111111111';
    hostIdReads = 0;

    async getOrCreateHostId(): Promise<string> {
        this.hostIdReads += 1;
        return this.hostId;
    }

    async createAttempt(attempt: NewSignInAttempt, now: Date): Promise<void> {
        for (let i = this.attempts.length - 1; i >= 0; i--) {
            const a = this.attempts[i];
            if (
                a.expiresAt < now ||
                (a.organizationId === attempt.organizationId &&
                    a.userId === attempt.userId)
            ) {
                this.attempts.splice(i, 1);
            }
        }
        this.attempts.push({ ...attempt });
    }

    async claimAttempt(input: {
        state: string;
        organizationId: string;
        userId: string;
        now: Date;
    }): Promise<SignInAttemptClaim> {
        const row = this.attempts.find(
            (a) =>
                a.state === input.state &&
                a.organizationId === input.organizationId &&
                a.userId === input.userId,
        );
        if (!row) return { kind: 'missing' };
        if (row.consumedAt) return { kind: 'used' };
        if (row.expiresAt <= input.now) return { kind: 'expired' };
        row.consumedAt = input.now;
        return {
            kind: 'claimed',
            attempt: {
                nonce: row.nonce,
                codeVerifier: row.codeVerifier,
                clientId: row.clientId,
                expectedSub: row.expectedSub,
            },
        };
    }
}

/** The slice of OrganizationParametersService the sign-in writes through. */
export class InMemoryOrgParameters {
    readonly values = new Map<string, unknown>();
    writes = 0;

    findByKey = async (key: string) =>
        this.values.has(key) ? { configValue: this.values.get(key) } : null;

    createOrUpdateConfig = async (key: string, value: unknown) => {
        this.writes += 1;
        this.values.set(key, value);
        return true;
    };
}
