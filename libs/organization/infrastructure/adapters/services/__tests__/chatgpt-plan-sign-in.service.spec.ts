import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { OrganizationParametersKey } from '@libs/core/domain/enums';

import { ChatGptPlanAuthService } from '../chatgpt-plan-auth.service';
import type { StoredChatGptPlanAuth } from '../chatgpt-plan-auth.store';
import { ChatGptPlanSignInError } from '../chatgpt-plan-sign-in.error';
import {
    CLIENT_ID,
    FakeAuthServer,
    InMemoryAuthStore,
    InMemoryOrgParameters,
    InMemorySignInStore,
    newKeyPair,
    type IssueOptions,
} from './chatgpt-plan-test-kit';

const logged: unknown[] = [];
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        warn: (entry: unknown) => logged.push(entry),
        info: (entry: unknown) => logged.push(entry),
        error: (entry: unknown) => logged.push(entry),
        debug: (entry: unknown) => logged.push(entry),
        log: (entry: unknown) => logged.push(entry),
    }),
}));

const ORG = 'org-1';
const USER = 'user-1';
const CTX = { organizationId: ORG, userId: USER };
const BYOK = OrganizationParametersKey.BYOK_CONFIG;
const MINUTE = 60_000;

function build() {
    const auth = new InMemoryAuthStore();
    const signIn = new InMemorySignInStore();
    const params = new InMemoryOrgParameters();
    const server = new FakeAuthServer();
    const service = new ChatGptPlanAuthService(
        auth,
        server.transport,
        signIn,
        params as never,
    );
    return { auth, signIn, params, server, service };
}
type Kit = ReturnType<typeof build>;

/** Start, play the browser, complete. Returns the service result. */
async function signInOnce(
    kit: Kit,
    issue: IssueOptions = {},
    start: { differentAccount?: boolean } = {},
    ctx = CTX,
) {
    const { authorizeUrl } = await kit.service.startSignIn(ctx, start);
    const callback = kit.server.authorize(authorizeUrl, issue);
    return kit.service.completeSignIn(ctx, callback);
}

async function rejection(promise: Promise<unknown>): Promise<ChatGptPlanSignInError> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(ChatGptPlanSignInError);
        return error as ChatGptPlanSignInError;
    }
    throw new Error('expected the sign-in to be rejected');
}

function returningRow(overrides: Partial<StoredChatGptPlanAuth> = {}): StoredChatGptPlanAuth {
    return {
        status: 'connected',
        email: 'owner@example.com',
        clientId: CLIENT_ID,
        sub: 'sub-1',
        expiresAt: Date.now() + 60 * MINUTE,
        scopes: ['openid', 'chatgpt.tokens.use.direct'],
        accessToken: encrypt('old-access'),
        refreshToken: encrypt('old-refresh'),
        idToken: encrypt('old-id-token'),
        ...overrides,
    };
}

beforeEach(() => {
    logged.length = 0;
    jest.useFakeTimers({
        doNotFake: [
            'nextTick',
            'setImmediate',
            'clearImmediate',
            'setTimeout',
            'clearTimeout',
            'setInterval',
            'clearInterval',
            'queueMicrotask',
            'performance',
        ],
    });
});
afterEach(() => jest.useRealTimers());

describe('startSignIn: authorize request', () => {
    it('registers a new client on first sign-in', async () => {
        const kit = build();
        const { authorizeUrl, expiresAt } = await kit.service.startSignIn(CTX);

        const url = new URL(authorizeUrl);
        expect(`${url.origin}${url.pathname}`).toBe(
            'https://auth.openai.com/api/accounts/authorize',
        );
        const p = url.searchParams;
        expect(p.get('client_id')).toBe('dynamic_agent_client');
        expect(p.get('agent_name_hint')).toBe('Kodus');
        expect(p.get('ext_agent_host_id')).toBe(kit.signIn.hostId);
        expect(p.get('response_type')).toBe('code');
        expect(p.get('redirect_uri')).toBe('http://127.0.0.1:1455/auth/callback');
        expect(p.get('scope')).toBe(
            'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        );
        expect(p.get('resource')).toBe('https://api.openai.com/v1');
        expect(p.get('code_challenge_method')).toBe('S256');
        expect(p.get('state')).toMatch(/^[0-9a-f]{64}$/);
        expect(p.get('nonce')).toMatch(/^[0-9a-f]{64}$/);
        expect(p.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        for (const absent of ['id_token_hint', 'login_hint', 'prompt']) {
            expect(p.has(absent)).toBe(false);
        }
        expect(expiresAt - Date.now()).toBe(10 * MINUTE);
    });

    it('stores the attempt bound to the user and org, verifier encrypted', async () => {
        const kit = build();
        const { authorizeUrl } = await kit.service.startSignIn(CTX);
        const state = new URL(authorizeUrl).searchParams.get('state');

        expect(kit.signIn.attempts).toHaveLength(1);
        const [attempt] = kit.signIn.attempts;
        expect(attempt).toMatchObject({
            state,
            organizationId: ORG,
            userId: USER,
            clientId: undefined,
        });
        expect(attempt.codeVerifier).not.toMatch(/^[A-Za-z0-9_-]{64}$/);
        expect(decrypt(attempt.codeVerifier)).toHaveLength(64);
    });

    it('reuses the saved client for a returning sign-in, with hints and without the agent name', async () => {
        const kit = build();
        kit.auth.rows.set(ORG, returningRow({ status: 'reauth_required' }));
        const { authorizeUrl } = await kit.service.startSignIn(CTX);

        const p = new URL(authorizeUrl).searchParams;
        expect(p.get('client_id')).toBe(CLIENT_ID);
        expect(p.has('agent_name_hint')).toBe(false);
        expect(p.get('id_token_hint')).toBe('old-id-token');
        expect(p.get('login_hint')).toBe('owner@example.com');
        expect(p.get('ext_agent_host_id')).toBe(kit.signIn.hostId);
        expect(p.has('prompt')).toBe(false);
        expect(kit.signIn.attempts[0]).toMatchObject({
            clientId: CLIENT_ID,
            expectedSub: 'sub-1',
        });
    });

    it('omits id_token_hint when none was retained', async () => {
        const kit = build();
        kit.auth.rows.set(ORG, returningRow({ idToken: undefined }));
        const p = new URL((await kit.service.startSignIn(CTX)).authorizeUrl).searchParams;
        expect(p.has('id_token_hint')).toBe(false);
        expect(p.get('login_hint')).toBe('owner@example.com');
    });

    it('"Use a different account" registers a new client even with a saved one', async () => {
        const kit = build();
        kit.auth.rows.set(ORG, returningRow());
        const { authorizeUrl } = await kit.service.startSignIn(CTX, {
            differentAccount: true,
        });

        const p = new URL(authorizeUrl).searchParams;
        expect(p.get('client_id')).toBe('dynamic_agent_client');
        expect(p.get('agent_name_hint')).toBe('Kodus');
        expect(p.has('id_token_hint')).toBe(false);
        expect(p.has('login_hint')).toBe(false);
        expect(kit.signIn.attempts[0].clientId).toBeUndefined();
        expect(kit.signIn.attempts[0].expectedSub).toBeUndefined();
    });

    it('a new start replaces the same user\'s pending attempt', async () => {
        const kit = build();
        await kit.service.startSignIn(CTX);
        await kit.service.startSignIn(CTX);
        expect(kit.signIn.attempts).toHaveLength(1);
    });
});

describe('completeSignIn: success', () => {
    it('stores the verified connection encrypted and registers the BYOK credential', async () => {
        const kit = build();
        const result = await signInOnce(kit);

        expect(result).toEqual({ outcome: 'connected', email: 'owner@example.com' });
        const row = kit.auth.rows.get(ORG)!;
        expect(row).toMatchObject({
            status: 'connected',
            sub: 'sub-1',
            email: 'owner@example.com',
        });
        expect(row.clientId).toMatch(/^oaiapp_issued_1_/);
        expect(decrypt(row.accessToken!)).toMatch(/^access-/);
        expect(decrypt(row.refreshToken!)).toMatch(/^refresh-/);
        expect(decrypt(row.idToken!).split('.')).toHaveLength(3);
        expect(row.expiresAt).toBeGreaterThan(Date.now() + 59 * MINUTE);
        expect(row.scopes).toContain('chatgpt.tokens.use.direct');

        expect(kit.params.values.get(BYOK)).toEqual({
            version: 2,
            credentials: [{ id: expect.any(String), provider: 'chatgpt_plan' }],
            models: [],
        });
        await expect(kit.service.getStatus(ORG)).resolves.toEqual({
            status: 'connected',
            email: 'owner@example.com',
        });
    });

    it('sends the exchange exactly as OpenAI documents it', async () => {
        const kit = build();
        await signInOnce(kit);
        const exchange = kit.server.calls.find((c) => c.url.endsWith('/oauth/token'))!;
        expect(exchange.method).toBe('POST');
        expect(Object.fromEntries(exchange.form)).toMatchObject({
            grant_type: 'authorization_code',
            redirect_uri: 'http://127.0.0.1:1455/auth/callback',
            resource: 'https://api.openai.com/v1',
        });
        expect(exchange.form.get('client_id')).toMatch(/^oaiapp_issued_1_/);
        expect(exchange.form.get('code')).toMatch(/^code-/);
        expect(exchange.form.get('code_verifier')).toHaveLength(64);
    });

    it('keeps the existing BYOK config and adds only the credential', async () => {
        const kit = build();
        const existing = {
            version: 2,
            credentials: [{ id: 'c1', provider: 'openai', apiKey: 'ciphertext' }],
            models: [{ id: 'm1', credentialId: 'c1', model: 'gpt-5' }],
            routing: { defaultModelId: 'm1' },
        };
        kit.params.values.set(BYOK, existing);
        await signInOnce(kit);

        const saved = kit.params.values.get(BYOK) as typeof existing;
        expect(saved.credentials[0]).toEqual(existing.credentials[0]);
        expect(saved.credentials).toHaveLength(2);
        expect(saved.credentials[1]).toEqual({ id: expect.any(String), provider: 'chatgpt_plan' });
        expect(saved.models).toEqual(existing.models);
        expect(saved.routing).toEqual(existing.routing);
    });

    it('still connects when the BYOK credential write fails', async () => {
        const kit = build();
        kit.params.createOrUpdateConfig = async () => {
            throw new Error('db down: secret-connection-string');
        };
        await expect(signInOnce(kit)).resolves.toMatchObject({ outcome: 'connected' });
        expect(kit.auth.rows.get(ORG)!.status).toBe('connected');
        expect(JSON.stringify(logged)).not.toContain('secret-connection-string');
    });

    it('does not add a second credential on a later sign-in', async () => {
        const kit = build();
        await signInOnce(kit);
        const writesAfterFirst = kit.params.writes;
        await signInOnce(kit);
        expect(kit.params.writes).toBe(writesAfterFirst);
        const config = kit.params.values.get(BYOK) as { credentials: unknown[] };
        expect(config.credentials).toHaveLength(1);
    });

    it('leaves a BYOK blob of an unknown shape untouched', async () => {
        const kit = build();
        const legacy = { main: { provider: 'openai' } };
        kit.params.values.set(BYOK, legacy);
        await signInOnce(kit);
        expect(kit.params.values.get(BYOK)).toBe(legacy);
        expect(kit.auth.rows.get(ORG)!.status).toBe('connected');
    });

    it('returning sign-in reuses the client and may omit it from the callback', async () => {
        const kit = build();
        kit.auth.rows.set(ORG, returningRow({ status: 'reauth_required', accessToken: undefined, refreshToken: undefined }));
        const result = await signInOnce(kit, { omitClientId: true });

        expect(result.outcome).toBe('connected');
        const row = kit.auth.rows.get(ORG)!;
        expect(row.clientId).toBe(CLIENT_ID);
        expect(row.status).toBe('connected');
        expect(decrypt(row.accessToken!)).toMatch(/^access-/);
    });

    it('"Use a different account" replaces the registration only after validation', async () => {
        const kit = build();
        kit.auth.rows.set(ORG, returningRow());
        const { authorizeUrl } = await kit.service.startSignIn(CTX, { differentAccount: true });
        // Until the new account is validated the old connection is untouched.
        expect(kit.auth.rows.get(ORG)!.clientId).toBe(CLIENT_ID);

        await kit.service.completeSignIn(
            CTX,
            kit.server.authorize(authorizeUrl, { sub: 'sub-2', email: 'other@example.com' }),
        );
        const row = kit.auth.rows.get(ORG)!;
        expect(row).toMatchObject({ sub: 'sub-2', email: 'other@example.com' });
        expect(row.clientId).not.toBe(CLIENT_ID);
    });

    it('a failed account switch leaves the previous connection intact', async () => {
        const kit = build();
        const before = returningRow();
        kit.auth.rows.set(ORG, before);
        const { authorizeUrl } = await kit.service.startSignIn(CTX, { differentAccount: true });
        const callback = kit.server.authorize(authorizeUrl, { claims: { nonce: 'wrong' } });
        await rejection(kit.service.completeSignIn(CTX, callback));
        expect(kit.auth.rows.get(ORG)).toEqual(before);
    });
});

describe('completeSignIn: ID token verification', () => {
    const cases: Array<[string, IssueOptions | (() => IssueOptions)]> = [
        ['a forged signature', () => ({ signWith: newKeyPair().privateKey })],
        ['a wrong nonce', { claims: { nonce: 'not-the-nonce' } }],
        ['a wrong audience', { claims: { aud: 'someone-else' } }],
        ['a wrong issuer', { claims: { iss: 'https://evil.example.com' } }],
        ['an expired token', { claims: { exp: Math.floor(Date.now() / 1000) - 3600 } }],
        ['a missing subject', { claims: { sub: '' } }],
        ['a downgraded algorithm header', { alg: 'HS256' }],
        ['an unsigned-style algorithm header', { alg: 'none' }],
    ];

    it.each(cases)('rejects %s and stores nothing', async (_name, issue) => {
        const kit = build();
        const options = typeof issue === 'function' ? issue() : issue;

        const error = await rejection(signInOnce(kit, options));

        expect(error.code).toBe('token_rejected');
        expect(kit.auth.rows.size).toBe(0);
        expect(kit.params.writes).toBe(0);
    });

    it('accepts the audience as an array containing the client', async () => {
        const kit = build();
        await expect(signInOnce(kit, { audienceAsArray: true })).resolves.toMatchObject({
            outcome: 'connected',
        });
    });

    it('rejects an ID token when the JWKS cannot be fetched', async () => {
        const kit = build();
        kit.server.jwksStatus = 503;
        const error = await rejection(signInOnce(kit));
        expect(error.code).toBe('unavailable');
        expect(kit.auth.rows.size).toBe(0);
    });
});

describe('completeSignIn: attempt, state and redirect checks', () => {
    it('rejects an attempt started by another user in the same org', async () => {
        const kit = build();
        const { authorizeUrl } = await kit.service.startSignIn(CTX);
        const callback = kit.server.authorize(authorizeUrl);
        const error = await rejection(
            kit.service.completeSignIn({ organizationId: ORG, userId: 'intruder' }, callback),
        );
        expect(error.code).toBe('attempt_not_found');
        expect(kit.server.calls.some((c) => c.url.endsWith('/oauth/token'))).toBe(false);
    });

    it('rejects an attempt started in another organisation', async () => {
        const kit = build();
        const { authorizeUrl } = await kit.service.startSignIn(CTX);
        const callback = kit.server.authorize(authorizeUrl);
        const error = await rejection(
            kit.service.completeSignIn({ organizationId: 'org-2', userId: USER }, callback),
        );
        expect(error.code).toBe('attempt_not_found');
        expect(kit.auth.rows.size).toBe(0);
    });

    it('rejects an unknown state', async () => {
        const kit = build();
        await kit.service.startSignIn(CTX);
        const error = await rejection(
            kit.service.completeSignIn(
                CTX,
                'http://127.0.0.1:1455/auth/callback?code=c&state=forged&client_id=x',
            ),
        );
        expect(error.code).toBe('attempt_not_found');
    });

    it('rejects an expired attempt', async () => {
        const kit = build();
        const { authorizeUrl } = await kit.service.startSignIn(CTX);
        const callback = kit.server.authorize(authorizeUrl);
        jest.setSystemTime(Date.now() + 10 * MINUTE + 1000);
        const error = await rejection(kit.service.completeSignIn(CTX, callback));
        expect(error.code).toBe('attempt_expired');
        expect(kit.server.calls.some((c) => c.url.endsWith('/oauth/token'))).toBe(false);
    });

    it('rejects a reused attempt', async () => {
        const kit = build();
        const { authorizeUrl } = await kit.service.startSignIn(CTX);
        const callback = kit.server.authorize(authorizeUrl);
        await kit.service.completeSignIn(CTX, callback);
        const error = await rejection(kit.service.completeSignIn(CTX, callback));
        expect(error.code).toBe('attempt_used');
    });

    it('lets only one of two concurrent completions through', async () => {
        const kit = build();
        const { authorizeUrl } = await kit.service.startSignIn(CTX);
        const callback = kit.server.authorize(authorizeUrl);
        const settled = await Promise.allSettled([
            kit.service.completeSignIn(CTX, callback),
            kit.service.completeSignIn(CTX, callback),
        ]);
        expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
        expect(kit.server.calls.filter((c) => c.url.endsWith('/oauth/token'))).toHaveLength(1);
    });

    it.each([
        ['localhost', 'http://localhost:1455/auth/callback?code=c&state=s'],
        ['another port', 'http://127.0.0.1:54321/auth/callback?code=c&state=s'],
        ['another path', 'http://127.0.0.1:1455/callback?code=c&state=s'],
        ['https', 'https://127.0.0.1:1455/auth/callback?code=c&state=s'],
        ['another host', 'http://evil.example.com/auth/callback?code=c&state=s'],
        ['not a URL', 'code=c&state=s'],
        ['empty', ''],
    ])('rejects a callback on %s without consuming the attempt', async (_name, bad) => {
        const kit = build();
        const { authorizeUrl } = await kit.service.startSignIn(CTX);
        const error = await rejection(kit.service.completeSignIn(CTX, bad));
        expect(error.code).toBe('callback_invalid');

        await expect(
            kit.service.completeSignIn(CTX, kit.server.authorize(authorizeUrl)),
        ).resolves.toMatchObject({ outcome: 'connected' });
    });

    it('rejects a callback with no state', async () => {
        const kit = build();
        await kit.service.startSignIn(CTX);
        const error = await rejection(
            kit.service.completeSignIn(CTX, 'http://127.0.0.1:1455/auth/callback?code=c'),
        );
        expect(error.code).toBe('callback_invalid');
    });

    it('stops at access_denied without exchanging a code', async () => {
        const kit = build();
        const { authorizeUrl } = await kit.service.startSignIn(CTX);
        const error = await rejection(
            kit.service.completeSignIn(CTX, kit.server.authorize(authorizeUrl, { deny: true })),
        );
        expect(error.code).toBe('sign_in_declined');
        expect(kit.server.calls.some((c) => c.url.endsWith('/oauth/token'))).toBe(false);
    });

    it('rejects a stale returning attempt after the registration changed', async () => {
        const kit = build();
        kit.auth.rows.set(ORG, returningRow());
        const { authorizeUrl } = await kit.service.startSignIn(CTX);
        const callback = kit.server.authorize(authorizeUrl);
        // Someone switched account while the first admin was in the browser.
        kit.auth.rows.set(ORG, returningRow({ clientId: 'oaiapp_other', sub: 'sub-9' }));

        const error = await rejection(kit.service.completeSignIn(CTX, callback));
        expect(error.code).toBe('attempt_stale');
        expect(kit.auth.rows.get(ORG)!.clientId).toBe('oaiapp_other');
    });
});

describe('completeSignIn: client id rules', () => {
    it('requires an issued client_id for a new registration', async () => {
        const kit = build();
        const error = await rejection(signInOnce(kit, { omitClientId: true }));
        expect(error.code).toBe('registration_incomplete');
        expect(kit.auth.rows.size).toBe(0);
    });

    it('does not accept dynamic_agent_client as the issued id', async () => {
        const kit = build();
        const error = await rejection(
            signInOnce(kit, { callbackClientId: 'dynamic_agent_client' }),
        );
        expect(error.code).toBe('registration_incomplete');
    });

    it('rejects a returning callback that supplies a different client_id', async () => {
        const kit = build();
        const before = returningRow();
        kit.auth.rows.set(ORG, before);
        const error = await rejection(signInOnce(kit, { callbackClientId: 'oaiapp_attacker' }));
        expect(error.code).toBe('client_mismatch');
        expect(kit.auth.rows.get(ORG)).toEqual(before);
        expect(kit.server.calls.some((c) => c.url.endsWith('/oauth/token'))).toBe(false);
    });
});

describe('completeSignIn: account identity', () => {
    it('rejects a returning sign-in whose sub differs and keeps the old connection', async () => {
        const kit = build();
        const before = returningRow();
        kit.auth.rows.set(ORG, before);

        const error = await rejection(signInOnce(kit, { sub: 'someone-else' }));

        expect(error.code).toBe('account_mismatch');
        expect(kit.auth.rows.get(ORG)).toEqual(before);
        expect(kit.params.writes).toBe(0);
    });

    it('fails closed when a returning attempt has no stored subject', async () => {
        const kit = build();
        kit.auth.rows.set(ORG, returningRow({ sub: undefined }));
        const error = await rejection(signInOnce(kit, { sub: 'anyone' }));
        expect(error.code).toBe('account_mismatch');
    });

    it('accepts a returning sign-in with the same sub', async () => {
        const kit = build();
        kit.auth.rows.set(ORG, returningRow());
        await expect(signInOnce(kit, { sub: 'sub-1' })).resolves.toMatchObject({
            outcome: 'connected',
        });
    });
});

describe('completeSignIn: plan permission', () => {
    const NO_PLAN = 'email offline_access openid profile resource.invoke';

    it('keeps the registration but stores no tokens when the plan scope is missing', async () => {
        const kit = build();
        const result = await signInOnce(kit, { scope: NO_PLAN });

        expect(result).toEqual({ outcome: 'plan_not_granted', email: 'owner@example.com' });
        const row = kit.auth.rows.get(ORG)!;
        expect(row).toMatchObject({
            status: 'reauth_required',
            sub: 'sub-1',
            needsConsent: true,
        });
        expect(row.clientId).toMatch(/^oaiapp_issued_1_/);
        expect(row.accessToken).toBeUndefined();
        expect(row.refreshToken).toBeUndefined();
        expect(row.idToken).toBeDefined();
        expect(kit.params.writes).toBe(0);
        await expect(kit.service.getStatus(ORG)).resolves.toMatchObject({
            status: 'reauth_required',
        });
    });

    it('retries with prompt=consent, then connects and clears the flag', async () => {
        const kit = build();
        await signInOnce(kit, { scope: NO_PLAN });

        const { authorizeUrl } = await kit.service.startSignIn(CTX);
        const p = new URL(authorizeUrl).searchParams;
        expect(p.get('prompt')).toBe('consent');
        expect(p.get('client_id')).toBe(kit.auth.rows.get(ORG)!.clientId);
        expect(p.get('scope')).toContain('chatgpt.tokens.use.direct');
        expect(p.get('id_token_hint')).toBeTruthy();

        const result = await kit.service.completeSignIn(CTX, kit.server.authorize(authorizeUrl));
        expect(result.outcome).toBe('connected');
        const row = kit.auth.rows.get(ORG)!;
        expect(row.status).toBe('connected');
        expect(row.needsConsent).toBeUndefined();
        expect((kit.params.values.get(BYOK) as { credentials: unknown[] }).credentials).toHaveLength(1);
    });

    it('does not ask for consent again on an ordinary sign-in', async () => {
        const kit = build();
        kit.auth.rows.set(ORG, returningRow());
        const p = new URL((await kit.service.startSignIn(CTX)).authorizeUrl).searchParams;
        expect(p.has('prompt')).toBe(false);
    });
});

describe('completeSignIn: token endpoint failures', () => {
    it.each([
        ['invalid_grant', 400, 'code_rejected'],
        ['server_error', 400, 'exchange_failed'],
        ['server_error', 500, 'unavailable'],
    ])('maps %s / HTTP %i to %s', async (code, status, expected) => {
        const kit = build();
        kit.server.tokenOverride = () =>
            new Response(JSON.stringify({ error: code, error_description: 'x' }), { status });
        const error = await rejection(signInOnce(kit));
        expect(error.code).toBe(expected);
        expect(kit.auth.rows.size).toBe(0);
    });

    it('reports an unreachable endpoint as unavailable', async () => {
        const kit = build();
        const service = new ChatGptPlanAuthService(
            kit.auth,
            (async () => {
                throw new Error('connect ECONNREFUSED https://auth.openai.com/api/accounts/oauth/token?code=leaky');
            }) as typeof fetch,
            kit.signIn,
            kit.params as never,
        );
        const { authorizeUrl } = await service.startSignIn(CTX);
        const callback = kit.server.authorize(authorizeUrl);
        const error = await rejection(service.completeSignIn(CTX, callback));
        expect(error.code).toBe('unavailable');
    });

    it('rejects a token response with missing fields', async () => {
        const kit = build();
        kit.server.tokenOverride = () =>
            new Response(JSON.stringify({ access_token: 'only-this' }), { status: 200 });
        const error = await rejection(signInOnce(kit));
        expect(error.code).toBe('exchange_failed');
    });
});

describe('signOut', () => {
    async function connected() {
        const kit = build();
        await signInOnce(kit);
        return kit;
    }

    it('revokes the refresh token, clears the tokens and keeps the registration', async () => {
        const kit = await connected();
        const before = kit.auth.rows.get(ORG)!;
        const refreshToken = decrypt(before.refreshToken!);
        const credentials = JSON.stringify(kit.params.values.get(BYOK));
        const writes = kit.params.writes;

        const result = await kit.service.signOut(ORG);

        expect(result).toEqual({ revocationConfirmed: true });
        const revoke = kit.server.calls.find((c) => c.url.endsWith('/oauth/revoke'))!;
        expect(Object.fromEntries(revoke.form)).toEqual({
            token: refreshToken,
            token_type_hint: 'refresh_token',
            client_id: before.clientId,
        });
        const row = kit.auth.rows.get(ORG)!;
        expect(row).toMatchObject({
            status: 'reauth_required',
            clientId: before.clientId,
            sub: 'sub-1',
            email: 'owner@example.com',
        });
        for (const cleared of ['accessToken', 'refreshToken', 'idToken', 'expiresAt', 'scopes'] as const) {
            expect(row[cleared]).toBeUndefined();
        }
        expect(JSON.stringify(kit.params.values.get(BYOK))).toBe(credentials);
        expect(kit.params.writes).toBe(writes);
        await expect(kit.service.getStatus(ORG)).resolves.toMatchObject({ status: 'reauth_required' });
    });

    it('makes the next sign-in a returning one that reuses the issued client', async () => {
        const kit = await connected();
        const { clientId } = kit.auth.rows.get(ORG)!;
        await kit.service.signOut(ORG);

        const p = new URL((await kit.service.startSignIn(CTX)).authorizeUrl).searchParams;
        expect(p.get('client_id')).toBe(clientId);
        expect(p.has('agent_name_hint')).toBe(false);
        expect(p.has('id_token_hint')).toBe(false);
        expect(p.get('login_hint')).toBe('owner@example.com');
    });

    it('reports an unconfirmed revocation after retrying a 5xx once, and still signs out', async () => {
        const kit = await connected();
        kit.server.revokeStatus = [503];
        const result = await kit.service.signOut(ORG);

        expect(result).toEqual({ revocationConfirmed: false });
        expect(kit.server.calls.filter((c) => c.url.endsWith('/oauth/revoke'))).toHaveLength(2);
        expect(kit.auth.rows.get(ORG)!.refreshToken).toBeUndefined();
    });

    it('confirms when the retry after a network failure succeeds', async () => {
        const kit = await connected();
        kit.server.revokeStatus = ['network', 200];
        await expect(kit.service.signOut(ORG)).resolves.toEqual({ revocationConfirmed: true });
    });

    it('does not retry a 4xx and reports it unconfirmed', async () => {
        const kit = await connected();
        kit.server.revokeStatus = [400];
        await expect(kit.service.signOut(ORG)).resolves.toEqual({ revocationConfirmed: false });
        expect(kit.server.calls.filter((c) => c.url.endsWith('/oauth/revoke'))).toHaveLength(1);
    });

    it('is a no-op when nothing is connected', async () => {
        const kit = build();
        await expect(kit.service.signOut(ORG)).resolves.toEqual({ revocationConfirmed: true });
        expect(kit.server.calls).toHaveLength(0);
        expect(kit.auth.rows.size).toBe(0);
    });

    it('stops the token provider from serving the old token at once', async () => {
        const kit = await connected();
        await kit.service.signOut(ORG);
        await expect(
            kit.service.getAccessToken(ORG, { forceRefresh: false }),
        ).rejects.toMatchObject({ code: 'signed_out' });
    });
});

describe('no secret leaves the service', () => {
    it('keeps codes, verifiers, tokens and the callback address out of every error and log', async () => {
        const kit = build();
        const secrets: string[] = [];
        const failures: unknown[] = [];

        const attempt = async (issue: IssueOptions, tamper?: (callback: string) => string) => {
            const { authorizeUrl } = await kit.service.startSignIn(CTX);
            const verifier = decrypt(kit.signIn.attempts[0].codeVerifier);
            const callback = kit.server.authorize(authorizeUrl, issue);
            const used = tamper ? tamper(callback) : callback;
            secrets.push(verifier, used);
            const code = new URL(callback).searchParams.get('code');
            if (code) secrets.push(code);
            try {
                await kit.service.completeSignIn(CTX, used);
            } catch (error) {
                failures.push(error);
            }
        };

        await attempt({ signWith: newKeyPair().privateKey });
        await attempt({ claims: { nonce: 'bad' } });
        await attempt({ omitClientId: true });
        await attempt({ deny: true });
        await attempt({}, (cb) => cb.replace('127.0.0.1', 'localhost'));
        kit.server.tokenOverride = () =>
            new Response(
                JSON.stringify({ error: 'invalid_grant', error_description: 'code=LEAKY-CODE verifier=LEAKY-VERIFIER' }),
                { status: 400 },
            );
        await attempt({});
        kit.server.tokenOverride = undefined;

        // A real connection, then a failed sign-out, to cover its log lines.
        await signInOnce(kit);
        const row = kit.auth.rows.get(ORG)!;
        secrets.push(decrypt(row.accessToken!), decrypt(row.refreshToken!), decrypt(row.idToken!));
        kit.server.revokeStatus = [500];
        await kit.service.signOut(ORG);

        expect(failures.length).toBeGreaterThanOrEqual(5);
        const everything = [
            ...failures.map((e) =>
                JSON.stringify(e, Object.getOwnPropertyNames(e as object)),
            ),
            JSON.stringify(logged),
        ].join('\n');
        for (const secret of secrets) {
            expect(secret.length).toBeGreaterThan(8);
            expect(everything).not.toContain(secret);
        }
        for (const text of ['LEAKY-CODE', 'LEAKY-VERIFIER', 'ECONNREFUSED', 'oauth/token']) {
            expect(everything).not.toContain(text);
        }
        for (const error of failures) {
            expect((error as Error).cause).toBeUndefined();
            expect(Object.keys(error as object).sort()).toEqual(['code', 'name']);
        }
    });
});
