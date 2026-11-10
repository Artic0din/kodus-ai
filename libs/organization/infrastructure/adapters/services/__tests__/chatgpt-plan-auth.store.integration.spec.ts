/**
 * INTEGRATION TEST - TypeOrmChatGptPlanAuthStore against a real Postgres.
 *
 * Needs the migrations applied (including the `chatgpt_plan_auth` enum value).
 * Fails loudly when Postgres is unreachable unless SKIP_INTEGRATION=true, so a
 * wrong password cannot turn the suite into a false green.
 */
require('dotenv').config();

import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { OrganizationParametersKey } from '@libs/core/domain/enums/organization-parameters-key.enum';
import { ENTITIES } from '@libs/core/infrastructure/database/typeorm/entities';

import {
    TypeOrmChatGptPlanAuthStore,
    type StoredChatGptPlanAuth,
} from '../chatgpt-plan-auth.store';

const skipIntegration = process.env.SKIP_INTEGRATION === 'true';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const auth = (email: string): StoredChatGptPlanAuth => ({
    status: 'connected',
    email,
});

(skipIntegration ? describe.skip : describe)(
    'TypeOrmChatGptPlanAuthStore (integration, real Postgres)',
    () => {
        let dataSource: DataSource;
        let store: TypeOrmChatGptPlanAuthStore;
        const orgIds: string[] = [];

        const newOrg = async (): Promise<string> => {
            const uuid = uuidv4();
            await dataSource.query(
                `INSERT INTO "organizations" ("uuid", "name") VALUES ($1, $2)`,
                [uuid, `chatgpt-plan-store-it-${uuid}`],
            );
            orgIds.push(uuid);
            return uuid;
        };

        const rowCount = async (orgId: string): Promise<number> => {
            const rows = await dataSource.query(
                `SELECT count(*)::int AS n FROM "organization_parameters"
                 WHERE "organization_id" = $1 AND "configKey" = $2`,
                [orgId, OrganizationParametersKey.CHATGPT_PLAN_AUTH],
            );
            return rows[0].n;
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
            store = new TypeOrmChatGptPlanAuthStore(dataSource);
        });

        afterAll(async () => {
            if (!dataSource?.isInitialized) return;
            if (orgIds.length) {
                await dataSource.query(
                    `DELETE FROM "organization_parameters" WHERE "organization_id" = ANY($1)`,
                    [orgIds],
                );
                await dataSource.query(
                    `DELETE FROM "organizations" WHERE "uuid" = ANY($1)`,
                    [orgIds],
                );
            }
            await dataSource.destroy();
        });

        it('reads null, inserts on first write and updates the same row on the second', async () => {
            const orgId = await newOrg();
            expect(await store.read(orgId)).toBeNull();

            await store.withLock(orgId, (row) => row.write(auth('a@x.test')));
            expect(await store.read(orgId)).toEqual(auth('a@x.test'));
            expect(await rowCount(orgId)).toBe(1);

            await store.withLock(orgId, async (row) => {
                expect(await row.read()).toEqual(auth('a@x.test'));
                await row.write(auth('b@x.test'));
            });
            expect(await store.read(orgId)).toEqual(auth('b@x.test'));
            expect(await rowCount(orgId)).toBe(1);
        });

        it('serialises concurrent withLock calls for the same org', async () => {
            const orgId = await newOrg();
            const window: Record<string, { start: number; end: number }> = {};
            const run = (name: string, holdMs: number) =>
                store.withLock(orgId, async () => {
                    const start = Date.now();
                    await sleep(holdMs);
                    window[name] = { start, end: Date.now() };
                });

            const first = run('first', 400);
            await sleep(100); // let the first take the lock
            const second = run('second', 10);
            await Promise.all([first, second]);

            expect(window.second.start).toBeGreaterThanOrEqual(
                window.first.end,
            );
        });

        it('does not block different orgs on each other', async () => {
            const [orgA, orgB] = [await newOrg(), await newOrg()];
            let bStart = 0;
            let aEnd = 0;

            const a = store.withLock(orgA, async () => {
                await sleep(400);
                aEnd = Date.now();
            });
            await sleep(100);
            const b = store.withLock(orgB, async () => {
                bStart = Date.now();
            });
            await Promise.all([a, b]);

            expect(bStart).toBeLessThan(aEnd);
        });

        it('rolls back the write when the critical section throws', async () => {
            const orgId = await newOrg();
            await expect(
                store.withLock(orgId, async (row) => {
                    await row.write(auth('lost@x.test'));
                    throw new Error('boom');
                }),
            ).rejects.toThrow('boom');

            expect(await store.read(orgId)).toBeNull();
            expect(await rowCount(orgId)).toBe(0);
        });
    },
);
