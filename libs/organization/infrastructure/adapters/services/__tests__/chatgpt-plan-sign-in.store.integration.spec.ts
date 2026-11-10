/**
 * INTEGRATION TEST - TypeOrmChatGptPlanSignInStore against a real Postgres.
 *
 * Needs the migrations applied (including `CreateChatGptPlanSignIn`). Fails
 * loudly when Postgres is unreachable unless SKIP_INTEGRATION=true, so a wrong
 * password cannot turn the suite into a false green.
 */
require('dotenv').config();

import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { ENTITIES } from '@libs/core/infrastructure/database/typeorm/entities';

import { TypeOrmChatGptPlanSignInStore } from '../chatgpt-plan-sign-in.store';

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';
const MINUTE = 60_000;

(skipIntegration ? describe.skip : describe)(
    'TypeOrmChatGptPlanSignInStore (integration, real Postgres)',
    () => {
        let dataSource: DataSource;
        let store: TypeOrmChatGptPlanSignInStore;
        const states: string[] = [];

        const attempt = (overrides: Record<string, unknown> = {}) => {
            const state = uuidv4().replace(/-/g, '');
            states.push(state);
            return {
                state,
                nonce: 'nonce-1',
                codeVerifier: 'ciphertext',
                organizationId: uuidv4(),
                userId: uuidv4(),
                expiresAt: new Date(Date.now() + 10 * MINUTE),
                ...overrides,
            };
        };

        beforeAll(async () => {
            dataSource = new DataSource({
                type: 'postgres',
                host: process.env.TEST_PG_HOST ?? 'localhost',
                port: parseInt(
                    process.env.TEST_PG_PORT ??
                        process.env.API_PG_DB_PORT ??
                        '5432',
                    10,
                ),
                username:
                    process.env.TEST_PG_USER ??
                    process.env.API_PG_DB_USERNAME ??
                    'kodusdev',
                password:
                    process.env.TEST_PG_PASSWORD ??
                    process.env.API_PG_DB_PASSWORD ??
                    'kodusdev',
                database:
                    process.env.TEST_PG_DB ??
                    process.env.API_PG_DB_DATABASE ??
                    'kodus_db',
                entities: ENTITIES,
                synchronize: false,
                logging: false,
                extra: { max: 5, connectionTimeoutMillis: 10_000 },
            });
            await dataSource.initialize();
            store = new TypeOrmChatGptPlanSignInStore(dataSource);
        });

        afterAll(async () => {
            if (!dataSource?.isInitialized) return;
            await dataSource.query(
                `DELETE FROM "chatgpt_plan_sign_in_attempts" WHERE "state" = ANY($1)`,
                [states],
            );
            await dataSource.destroy();
        });

        it('creates the host id once and returns the same urn:uuid every time', async () => {
            const [first, second] = await Promise.all([
                store.getOrCreateHostId(),
                store.getOrCreateHostId(),
            ]);
            expect(first).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
            expect(second).toBe(first);
            expect(await store.getOrCreateHostId()).toBe(first);
            const [{ n }] = await dataSource.query(
                `SELECT count(*)::int AS n FROM "chatgpt_plan_install"`,
            );
            expect(n).toBe(1);
        });

        it('claims an attempt once and reports it used afterwards', async () => {
            const a = attempt({ clientId: 'oaiapp_1', expectedSub: 'sub-1' });
            await store.createAttempt(a, new Date());
            const input = {
                state: a.state,
                organizationId: a.organizationId,
                userId: a.userId,
                now: new Date(),
            };

            await expect(store.claimAttempt(input)).resolves.toEqual({
                kind: 'claimed',
                attempt: {
                    nonce: 'nonce-1',
                    codeVerifier: 'ciphertext',
                    clientId: 'oaiapp_1',
                    expectedSub: 'sub-1',
                },
            });
            await expect(store.claimAttempt(input)).resolves.toEqual({ kind: 'used' });
        });

        it('lets only one of many concurrent claims win', async () => {
            const a = attempt();
            await store.createAttempt(a, new Date());
            const input = {
                state: a.state,
                organizationId: a.organizationId,
                userId: a.userId,
                now: new Date(),
            };
            const results = await Promise.all(
                Array.from({ length: 8 }, () => store.claimAttempt(input)),
            );
            expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1);
            expect(results.filter((r) => r.kind === 'used')).toHaveLength(7);
        });

        it('reads another user\'s or organisation\'s attempt as missing', async () => {
            const a = attempt();
            await store.createAttempt(a, new Date());
            const base = { state: a.state, now: new Date() };
            await expect(
                store.claimAttempt({ ...base, organizationId: a.organizationId, userId: uuidv4() }),
            ).resolves.toEqual({ kind: 'missing' });
            await expect(
                store.claimAttempt({ ...base, organizationId: uuidv4(), userId: a.userId }),
            ).resolves.toEqual({ kind: 'missing' });
            // Still claimable by its owner afterwards.
            await expect(
                store.claimAttempt({ ...base, organizationId: a.organizationId, userId: a.userId }),
            ).resolves.toMatchObject({ kind: 'claimed' });
        });

        it('reports an attempt past its 10 minutes as expired and not claimable', async () => {
            const a = attempt();
            await store.createAttempt(a, new Date());
            await expect(
                store.claimAttempt({
                    state: a.state,
                    organizationId: a.organizationId,
                    userId: a.userId,
                    now: new Date(Date.now() + 11 * MINUTE),
                }),
            ).resolves.toEqual({ kind: 'expired' });
        });

        it('a new attempt replaces the same user\'s older one and purges expired ones', async () => {
            const old = attempt();
            await store.createAttempt(old, new Date());
            const stale = attempt({ expiresAt: new Date(Date.now() - MINUTE) });
            await store.createAttempt(stale, new Date(Date.now() - 2 * MINUTE));
            const fresh = attempt({ organizationId: old.organizationId, userId: old.userId });
            await store.createAttempt(fresh, new Date());

            const rows = await dataSource.query(
                `SELECT "state" FROM "chatgpt_plan_sign_in_attempts" WHERE "state" = ANY($1)`,
                [[old.state, stale.state, fresh.state]],
            );
            expect(rows.map((r: { state: string }) => r.state)).toEqual([fresh.state]);
        });

        it('rejects a state that another user already holds', async () => {
            const a = attempt();
            await store.createAttempt(a, new Date());
            await expect(
                store.createAttempt({ ...a, userId: uuidv4() }, new Date()),
            ).rejects.toThrow();
        });
    },
);
