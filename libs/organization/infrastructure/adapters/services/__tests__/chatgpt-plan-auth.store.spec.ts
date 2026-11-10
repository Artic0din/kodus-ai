import { OrganizationParametersKey } from '@libs/core/domain/enums/organization-parameters-key.enum';

import {
    TypeOrmChatGptPlanAuthStore,
    type StoredChatGptPlanAuth,
} from '../chatgpt-plan-auth.store';
import { OrganizationParametersModel } from '../../repositories/schemas/organizationParameters.model';

/**
 * The advisory lock and the row mapping, against a recorded fake DataSource.
 * Postgres itself is not available to the unit tests; the lock's mutual
 * exclusion is covered in chatgpt-plan-auth.service.spec.ts through the store
 * seam, and this file pins that the TypeORM store takes the lock first, inside
 * the transaction, before it reads.
 */
function fakeDataSource(existing?: {
    uuid: string;
    configValue: StoredChatGptPlanAuth;
}) {
    const log: Array<[string, ...unknown[]]> = [];
    const manager = {
        query: jest.fn(async (sql: string, params: unknown[]) => {
            log.push(['query', sql, params]);
            return [];
        }),
        createQueryBuilder: jest.fn(() => {
            const builder = {
                where: jest.fn((sql: string, params: unknown) => {
                    log.push(['where', sql, params]);
                    return builder;
                }),
                andWhere: jest.fn((sql: string, params: unknown) => {
                    log.push(['andWhere', sql, params]);
                    return builder;
                }),
                getOne: jest.fn(async () => {
                    log.push(['getOne']);
                    return existing ?? null;
                }),
            };
            return builder;
        }),
        update: jest.fn(async (...args: unknown[]) => {
            log.push(['update', ...args]);
        }),
        insert: jest.fn(async (...args: unknown[]) => {
            log.push(['insert', ...args]);
        }),
    };
    const dataSource = {
        manager,
        transaction: jest.fn(async (cb: (m: typeof manager) => unknown) => {
            log.push(['begin']);
            const result = await cb(manager);
            log.push(['commit']);
            return result;
        }),
    };
    return { dataSource, manager, log };
}

const value: StoredChatGptPlanAuth = {
    status: 'connected',
    clientId: 'c',
    accessToken: 'enc',
};

describe('TypeOrmChatGptPlanAuthStore', () => {
    it('takes the org advisory lock inside the transaction before reading', async () => {
        const { dataSource, log } = fakeDataSource({
            uuid: 'row-1',
            configValue: value,
        });
        const store = new TypeOrmChatGptPlanAuthStore(dataSource as any);

        const result = await store.withLock('org-1', (row) => row.read());

        expect(result).toEqual(value);
        const order = log.map((entry) => entry[0]);
        expect(order.slice(0, 3)).toEqual(['begin', 'query', 'where']);
        expect(order.at(-1)).toBe('commit');
        expect(log[1]).toEqual([
            'query',
            'SELECT pg_advisory_xact_lock(hashtext($1))',
            ['chatgpt_plan_auth:org-1'],
        ]);
    });

    it('reads only the chatgpt_plan_auth row of the given organisation', async () => {
        const { dataSource, log } = fakeDataSource({
            uuid: 'row-1',
            configValue: value,
        });
        const store = new TypeOrmChatGptPlanAuthStore(dataSource as any);
        await store.read('org-7');
        expect(log).toContainEqual([
            'where',
            'p.configKey = :configKey',
            { configKey: OrganizationParametersKey.CHATGPT_PLAN_AUTH },
        ]);
        expect(log).toContainEqual([
            'andWhere',
            'p.organization_id = :organizationId',
            { organizationId: 'org-7' },
        ]);
    });

    it('answers null when the organisation has no row', async () => {
        const { dataSource } = fakeDataSource();
        const store = new TypeOrmChatGptPlanAuthStore(dataSource as any);
        await expect(store.read('org-1')).resolves.toBeNull();
    });

    it('updates the existing row in the same transaction', async () => {
        const { dataSource, manager } = fakeDataSource({
            uuid: 'row-1',
            configValue: value,
        });
        const store = new TypeOrmChatGptPlanAuthStore(dataSource as any);
        await store.withLock('org-1', (row) =>
            row.write({ ...value, status: 'reauth_required' }),
        );
        expect(manager.update).toHaveBeenCalledWith(
            OrganizationParametersModel,
            { uuid: 'row-1' },
            { configValue: { ...value, status: 'reauth_required' } },
        );
        expect(manager.insert).not.toHaveBeenCalled();
    });

    it('inserts a row keyed chatgpt_plan_auth for the organisation when none exists', async () => {
        const { dataSource, manager } = fakeDataSource();
        const store = new TypeOrmChatGptPlanAuthStore(dataSource as any);
        await store.withLock('org-1', (row) => row.write(value));
        expect(manager.insert).toHaveBeenCalledWith(
            OrganizationParametersModel,
            expect.objectContaining({
                configKey: OrganizationParametersKey.CHATGPT_PLAN_AUTH,
                configValue: value,
                organization: { uuid: 'org-1' },
            }),
        );
    });

    it('lets a throw inside the lock propagate so the transaction rolls back', async () => {
        const { dataSource, log } = fakeDataSource();
        dataSource.transaction.mockImplementationOnce(async (cb: any) => {
            log.push(['begin']);
            try {
                return await cb((dataSource as any).manager);
            } catch (error) {
                log.push(['rollback']);
                throw error;
            }
        });
        const store = new TypeOrmChatGptPlanAuthStore(dataSource as any);
        await expect(
            store.withLock('org-1', async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        expect(log.map((e) => e[0])).toContain('rollback');
        expect(log.map((e) => e[0])).not.toContain('commit');
    });
});
