import { decrypt, encrypt } from '@libs/common/utils/crypto';
import { ChatGptPlanTokenError } from '@libs/llm/providers/chatgpt-plan/token-provider';

import {
    CHATGPT_PLAN_RESOURCE,
    CHATGPT_PLAN_TOKEN_ENDPOINT,
    ChatGptPlanAuthService,
} from '../chatgpt-plan-auth.service';
import type {
    ChatGptPlanAuthStore,
    LockedChatGptPlanAuth,
    StoredChatGptPlanAuth,
} from '../chatgpt-plan-auth.store';

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
const MINUTE = 60_000;

/** Postgres stand-in: one row per org, a per-org mutex for the advisory lock,
 *  and transaction semantics (writes commit on success, vanish on a throw). */
class InMemoryStore implements ChatGptPlanAuthStore {
    readonly rows = new Map<string, StoredChatGptPlanAuth>();
    readonly queues = new Map<string, Promise<unknown>>();
    /** Lets a test hand a caller a stale snapshot, as a slow worker would hold. */
    staleReads: Array<StoredChatGptPlanAuth | null> = [];
    locks = 0;

    async read(org: string): Promise<StoredChatGptPlanAuth | null> {
        if (this.staleReads.length > 0) return this.staleReads.shift() ?? null;
        const row = this.rows.get(org);
        return row ? { ...row } : null;
    }

    async withLock<T>(
        org: string,
        fn: (row: LockedChatGptPlanAuth) => Promise<T>,
    ): Promise<T> {
        const previous = this.queues.get(org) ?? Promise.resolve();
        const run = previous.then(async () => {
            this.locks += 1;
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
        this.queues.set(
            org,
            run.catch(() => undefined),
        );
        return run;
    }
}

function connectedRow(
    overrides: Partial<StoredChatGptPlanAuth> = {},
): StoredChatGptPlanAuth {
    return {
        status: 'connected',
        email: 'owner@example.com',
        clientId: 'client-1',
        sub: 'sub-1',
        expiresAt: Date.now() + 60 * MINUTE,
        scopes: ['openid', 'chatgpt.tokens.use.direct'],
        accessToken: encrypt('access-1'),
        refreshToken: encrypt('refresh-1'),
        idToken: encrypt('id-1'),
        ...overrides,
    };
}

interface TokenCall {
    url: string;
    method: string;
    contentType: string | null;
    form: URLSearchParams;
}

/** Fake token endpoint. `respond` decides each reply; every request is kept. */
function tokenEndpoint(
    respond: (n: number, form: URLSearchParams) => Response | Promise<Response>,
) {
    const calls: TokenCall[] = [];
    const transport: typeof fetch = async (input, init) => {
        const form = new URLSearchParams(String(init?.body));
        calls.push({
            url: String(input),
            method: String(init?.method),
            contentType: new Headers(init?.headers).get('content-type'),
            form,
        });
        return respond(calls.length, form);
    };
    return { calls, transport };
}

const ok = (n: number) =>
    new Response(
        JSON.stringify({
            access_token: `access-${n + 1}`,
            refresh_token: `refresh-${n + 1}`,
            id_token: `id-${n + 1}`,
            expires_in: 3600,
            scope: 'openid chatgpt.tokens.use.direct',
        }),
        { status: 200 },
    );
const oauthError = (code: string, status = 400) =>
    new Response(
        JSON.stringify({ error: code, error_description: 'secret-ish detail' }),
        { status },
    );

function build(
    row: StoredChatGptPlanAuth | undefined,
    respond: Parameters<typeof tokenEndpoint>[0] = ok,
) {
    const store = new InMemoryStore();
    if (row) store.rows.set(ORG, row);
    const endpoint = tokenEndpoint(respond);
    const service = new ChatGptPlanAuthService(store, endpoint.transport);
    return { store, service, endpoint };
}

const stored = (store: InMemoryStore) => store.rows.get(ORG)!;

beforeEach(() => {
    logged.length = 0;
});

describe('ChatGptPlanAuthService.getAccessToken', () => {
    it('returns a fresh token from the row without calling OpenAI or writing', async () => {
        const { service, store, endpoint } = build(connectedRow());
        await expect(
            service.getAccessToken(ORG, { forceRefresh: false }),
        ).resolves.toBe('access-1');
        expect(endpoint.calls).toHaveLength(0);
        expect(store.locks).toBe(0);
    });

    it('reads the row on every call: there is no in-process token cache', async () => {
        const { service, store } = build(connectedRow());
        await service.getAccessToken(ORG, { forceRefresh: false });
        store.rows.set(
            ORG,
            connectedRow({ accessToken: encrypt('access-swapped') }),
        );
        await expect(
            service.getAccessToken(ORG, { forceRefresh: false }),
        ).resolves.toBe('access-swapped');
    });

    it('refreshes a token that expires within five minutes, form-encoded, and stores the rotation', async () => {
        const { service, store, endpoint } = build(
            connectedRow({ expiresAt: Date.now() + 4 * MINUTE }),
        );
        await expect(
            service.getAccessToken(ORG, { forceRefresh: false }),
        ).resolves.toBe('access-2');

        expect(endpoint.calls).toHaveLength(1);
        const [call] = endpoint.calls;
        expect(call.url).toBe(CHATGPT_PLAN_TOKEN_ENDPOINT);
        expect(call.url).toBe(
            'https://auth.openai.com/api/accounts/oauth/token',
        );
        expect(call.method).toBe('POST');
        expect(call.contentType).toBe('application/x-www-form-urlencoded');
        expect(Object.fromEntries(call.form)).toEqual({
            grant_type: 'refresh_token',
            client_id: 'client-1',
            refresh_token: 'refresh-1',
            resource: CHATGPT_PLAN_RESOURCE,
        });

        const row = stored(store);
        expect(decrypt(row.accessToken!)).toBe('access-2');
        expect(decrypt(row.refreshToken!)).toBe('refresh-2');
        expect(decrypt(row.idToken!)).toBe('id-2');
        expect(row.status).toBe('connected');
        expect(row.clientId).toBe('client-1');
        expect(row.sub).toBe('sub-1');
        expect(row.expiresAt! - Date.now()).toBeGreaterThan(59 * MINUTE);
        // Nothing is stored in the clear.
        expect(JSON.stringify(row)).not.toMatch(/access-2|refresh-2|id-2/);
    });

    it('does not refresh a token with more than five minutes left', async () => {
        const { service, endpoint } = build(
            connectedRow({ expiresAt: Date.now() + 6 * MINUTE }),
        );
        await service.getAccessToken(ORG, { forceRefresh: false });
        expect(endpoint.calls).toHaveLength(0);
    });

    it('refreshes on forceRefresh even when the token is fresh', async () => {
        const { service, endpoint } = build(connectedRow());
        await expect(
            service.getAccessToken(ORG, { forceRefresh: true }),
        ).resolves.toBe('access-2');
        expect(endpoint.calls).toHaveLength(1);
    });

    it('keeps the old refresh token and ID token when the endpoint does not rotate them', async () => {
        const { service, store } = build(
            connectedRow(),
            () =>
                new Response(
                    JSON.stringify({
                        access_token: 'access-new',
                        expires_in: 600,
                    }),
                    { status: 200 },
                ),
        );
        await service.getAccessToken(ORG, { forceRefresh: true });
        expect(decrypt(stored(store).refreshToken!)).toBe('refresh-1');
        expect(decrypt(stored(store).idToken!)).toBe('id-1');
    });

    it('two concurrent refreshers make one token call and agree on the token', async () => {
        const { service, endpoint } = build(
            connectedRow({ expiresAt: Date.now() + MINUTE }),
            async (n) => {
                await new Promise((resolve) => setTimeout(resolve, 20));
                return ok(n);
            },
        );
        const [a, b, c] = await Promise.all([
            service.getAccessToken(ORG, { forceRefresh: false }),
            service.getAccessToken(ORG, { forceRefresh: false }),
            service.getAccessToken(ORG, { forceRefresh: true }),
        ]);
        expect(endpoint.calls).toHaveLength(1);
        expect([a, b, c]).toEqual(['access-2', 'access-2', 'access-2']);
    });

    it('a stale worker takes the newer token instead of spending a rotated refresh token', async () => {
        const seenByStaleWorker = connectedRow({
            expiresAt: Date.now() + MINUTE,
        });
        const { service, store, endpoint } = build(
            // Another worker already refreshed: the row holds access-9.
            connectedRow({
                accessToken: encrypt('access-9'),
                refreshToken: encrypt('refresh-9'),
            }),
        );
        store.staleReads = [seenByStaleWorker];
        await expect(
            service.getAccessToken(ORG, { forceRefresh: false }),
        ).resolves.toBe('access-9');
        expect(endpoint.calls).toHaveLength(0);
        expect(decrypt(stored(store).refreshToken!)).toBe('refresh-9');
    });

    it('a stale worker whose newer token is also near expiry refreshes with the newer refresh token', async () => {
        const { service, store, endpoint } = build(
            connectedRow({
                accessToken: encrypt('access-9'),
                refreshToken: encrypt('refresh-9'),
                expiresAt: Date.now() + MINUTE,
            }),
        );
        store.staleReads = [connectedRow({ expiresAt: Date.now() + MINUTE })];
        await service.getAccessToken(ORG, { forceRefresh: false });
        expect(endpoint.calls).toHaveLength(1);
        expect(endpoint.calls[0].form.get('refresh_token')).toBe('refresh-9');
    });

    it('sees a sign-out made by another process on its next call', async () => {
        const { service, store } = build(connectedRow());
        await expect(
            service.getAccessToken(ORG, { forceRefresh: false }),
        ).resolves.toBe('access-1');
        store.rows.set(
            ORG,
            connectedRow({
                status: 'reauth_required',
                accessToken: undefined,
                refreshToken: undefined,
                expiresAt: undefined,
            }),
        );
        await expect(
            service.getAccessToken(ORG, { forceRefresh: false }),
        ).rejects.toMatchObject({
            code: 'signed_out',
        });
    });
});

describe('ChatGptPlanAuthService refresh failures', () => {
    it.each([
        'invalid_grant',
        'invalid_refresh_token',
        'token_expired',
        'refresh_token_expired',
        'refresh_token_invalidated',
        'refresh_token_reused',
    ])(
        'terminal %s clears the tokens, keeps the registration, and asks for sign-in',
        async (code) => {
            const { service, store, endpoint } = build(connectedRow(), () =>
                oauthError(code),
            );
            await expect(
                service.getAccessToken(ORG, { forceRefresh: true }),
            ).rejects.toMatchObject({
                name: 'ChatGptPlanTokenError',
                code: 'signed_out',
            });

            const row = stored(store);
            expect(row.status).toBe('reauth_required');
            expect(row.accessToken).toBeUndefined();
            expect(row.refreshToken).toBeUndefined();
            expect(row.expiresAt).toBeUndefined();
            expect(row.clientId).toBe('client-1');
            expect(row.sub).toBe('sub-1');
            expect(decrypt(row.idToken!)).toBe('id-1');

            // Later calls fail fast without touching OpenAI.
            await expect(
                service.getAccessToken(ORG, { forceRefresh: false }),
            ).rejects.toMatchObject({
                code: 'signed_out',
            });
            expect(endpoint.calls).toHaveLength(1);
        },
    );

    it('accepts the OAuth error code nested under error.code too', async () => {
        const { service, store } = build(
            connectedRow(),
            () =>
                new Response(
                    JSON.stringify({ error: { code: 'invalid_grant' } }),
                    { status: 400 },
                ),
        );
        await expect(
            service.getAccessToken(ORG, { forceRefresh: true }),
        ).rejects.toMatchObject({
            code: 'signed_out',
        });
        expect(stored(store).status).toBe('reauth_required');
    });

    it('invalid_client also clears the client id so the next sign-in registers again', async () => {
        const { service, store } = build(connectedRow(), () =>
            oauthError('invalid_client', 401),
        );
        await expect(
            service.getAccessToken(ORG, { forceRefresh: true }),
        ).rejects.toMatchObject({
            code: 'signed_out',
        });
        const row = stored(store);
        expect(row.status).toBe('reauth_required');
        expect(row.clientId).toBeUndefined();
        expect(row.sub).toBe('sub-1');
        expect(decrypt(row.idToken!)).toBe('id-1');
    });

    it.each([
        ['a 500', () => new Response('down', { status: 500 })],
        ['a 429', () => oauthError('rate_limited', 429)],
        ['an unknown 400 code', () => oauthError('invalid_request')],
        [
            'a response with no access token',
            () => new Response('{}', { status: 200 }),
        ],
        ['a non-JSON reply', () => new Response('<html>', { status: 200 })],
    ])(
        '%s is unavailable and leaves the stored sign-in untouched',
        async (_name, reply) => {
            const before = connectedRow();
            const { service, store } = build(before, reply);
            await expect(
                service.getAccessToken(ORG, { forceRefresh: true }),
            ).rejects.toMatchObject({
                code: 'unavailable',
            });
            expect(stored(store)).toEqual(before);
        },
    );

    it('a transport failure is unavailable and leaves the stored sign-in untouched', async () => {
        const before = connectedRow();
        const store = new InMemoryStore();
        store.rows.set(ORG, before);
        const service = new ChatGptPlanAuthService(store, async () => {
            throw new TypeError(
                'fetch failed: https://auth.openai.com/?refresh_token=refresh-1',
            );
        });
        const error = await service
            .getAccessToken(ORG, { forceRefresh: true })
            .catch((e) => e);
        expect(error).toBeInstanceOf(ChatGptPlanTokenError);
        expect(error.code).toBe('unavailable');
        expect(stored(store)).toEqual(before);
    });

    it('never puts a secret, a URL or the provider body in an error or a log line', async () => {
        const failures = [
            () => oauthError('invalid_grant'),
            () => oauthError('invalid_client', 401),
            () => new Response('refresh-1 access-1 client-1', { status: 500 }),
        ];
        for (const reply of failures) {
            const { service } = build(connectedRow(), reply);
            const error = await service
                .getAccessToken(ORG, { forceRefresh: true })
                .catch((e) => e);
            const surface = JSON.stringify({
                message: error.message,
                own: Object.getOwnPropertyNames(error).map((k) =>
                    String(error[k]),
                ),
                cause: error.cause,
                logs: logged,
            });
            expect(surface).not.toMatch(
                /refresh-1|access-1|id-1|client-1|auth\.openai\.com|secret-ish/,
            );
        }
    });
});

describe('ChatGptPlanAuthService row states', () => {
    it('is signed out when nothing is stored', async () => {
        const { service } = build(undefined);
        await expect(
            service.getAccessToken(ORG, { forceRefresh: false }),
        ).rejects.toMatchObject({
            code: 'signed_out',
        });
    });

    it('is signed out when the status is reauth_required', async () => {
        const { service, endpoint } = build(
            connectedRow({ status: 'reauth_required' }),
        );
        await expect(
            service.getAccessToken(ORG, { forceRefresh: true }),
        ).rejects.toMatchObject({
            code: 'signed_out',
        });
        expect(endpoint.calls).toHaveLength(0);
    });

    it('reports not_eligible without refreshing', async () => {
        const { service, endpoint } = build(
            connectedRow({ status: 'not_eligible' }),
        );
        await expect(
            service.getAccessToken(ORG, { forceRefresh: true }),
        ).rejects.toMatchObject({
            code: 'not_eligible',
        });
        expect(endpoint.calls).toHaveLength(0);
    });

    it('treats a token that cannot be decrypted as a sign-out, not a crash', async () => {
        const { service } = build(
            connectedRow({ accessToken: 'not-valid-ciphertext' }),
        );
        await expect(
            service.getAccessToken(ORG, { forceRefresh: false }),
        ).rejects.toMatchObject({
            code: 'signed_out',
        });
    });

    it("keeps one organisation's tokens out of another's calls", async () => {
        const { service, store } = build(connectedRow());
        store.rows.set(
            'org-2',
            connectedRow({ accessToken: encrypt('access-org-2') }),
        );
        await expect(
            service.getAccessToken('org-2', { forceRefresh: false }),
        ).resolves.toBe('access-org-2');
        await expect(
            service.getAccessToken('org-3', { forceRefresh: false }),
        ).rejects.toMatchObject({
            code: 'signed_out',
        });
    });
});

describe('ChatGptPlanAuthService.getStatus', () => {
    it.each([
        [undefined, { status: 'not_connected' }],
        [connectedRow(), { status: 'connected', email: 'owner@example.com' }],
        [
            connectedRow({
                status: 'reauth_required',
                accessToken: undefined,
                refreshToken: undefined,
            }),
            { status: 'reauth_required', email: 'owner@example.com' },
        ],
        [
            connectedRow({ status: 'not_eligible' }),
            { status: 'not_eligible', email: 'owner@example.com' },
        ],
        [
            connectedRow({ accessToken: undefined }),
            { status: 'reauth_required', email: 'owner@example.com' },
        ],
    ])('reads %# without exposing a token', async (row, expected) => {
        const { service } = build(row);
        const status = await service.getStatus(ORG);
        expect(status).toEqual(expected);
        expect(JSON.stringify(status)).not.toMatch(/access|refresh|id-1/);
    });
});
