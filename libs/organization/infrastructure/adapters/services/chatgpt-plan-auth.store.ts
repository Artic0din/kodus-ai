import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { OrganizationParametersKey } from '@libs/core/domain/enums/organization-parameters-key.enum';

import { OrganizationParametersModel } from '../repositories/schemas/organizationParameters.model';

/** What `ChatGptPlanAuthService` keeps in the `chatgpt_plan_auth` row. Token
 *  fields are `encrypt()` ciphertext; the rest is not secret. */
export interface StoredChatGptPlanAuth {
    status: 'connected' | 'reauth_required' | 'not_eligible';
    email?: string;
    /** Dynamic-registration client id; kept across sign-out. */
    clientId?: string;
    sub?: string;
    /** Access token expiry, epoch milliseconds. */
    expiresAt?: number;
    scopes?: string[];
    accessToken?: string;
    refreshToken?: string;
    /** Kept across sign-out: it is the `id_token_hint` of the next sign-in. */
    idToken?: string;
}

/** The row, held under the org's advisory lock for the length of a transaction. */
export interface LockedChatGptPlanAuth {
    read(): Promise<StoredChatGptPlanAuth | null>;
    write(value: StoredChatGptPlanAuth): Promise<void>;
}

/** Persistence seam: the service owns the rules, the store owns Postgres. */
export interface ChatGptPlanAuthStore {
    read(organizationId: string): Promise<StoredChatGptPlanAuth | null>;
    /** Runs `fn` in a transaction holding the org's advisory lock. A throw rolls
     *  the transaction back, so `fn` returns failures it wants to keep. */
    withLock<T>(
        organizationId: string,
        fn: (row: LockedChatGptPlanAuth) => Promise<T>,
    ): Promise<T>;
}

export const CHATGPT_PLAN_AUTH_STORE = Symbol('ChatGptPlanAuthStore');

@Injectable()
export class TypeOrmChatGptPlanAuthStore implements ChatGptPlanAuthStore {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    read(organizationId: string): Promise<StoredChatGptPlanAuth | null> {
        return this.readRow(this.dataSource.manager, organizationId);
    }

    withLock<T>(
        organizationId: string,
        fn: (row: LockedChatGptPlanAuth) => Promise<T>,
    ): Promise<T> {
        return this.dataSource.transaction(async (manager) => {
            await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
                `chatgpt_plan_auth:${organizationId}`,
            ]);
            return fn({
                read: () => this.readRow(manager, organizationId),
                write: (value) => this.writeRow(manager, organizationId, value),
            });
        });
    }

    private async findRow(
        manager: EntityManager,
        organizationId: string,
    ): Promise<OrganizationParametersModel | null> {
        return manager
            .createQueryBuilder(OrganizationParametersModel, 'p')
            .where('p.configKey = :configKey', {
                configKey: OrganizationParametersKey.CHATGPT_PLAN_AUTH,
            })
            .andWhere('p.organization_id = :organizationId', { organizationId })
            .getOne();
    }

    private async readRow(
        manager: EntityManager,
        organizationId: string,
    ): Promise<StoredChatGptPlanAuth | null> {
        const row = await this.findRow(manager, organizationId);
        return (row?.configValue as StoredChatGptPlanAuth | undefined) ?? null;
    }

    private async writeRow(
        manager: EntityManager,
        organizationId: string,
        value: StoredChatGptPlanAuth,
    ): Promise<void> {
        const row = await this.findRow(manager, organizationId);
        if (row) {
            await manager.update(
                OrganizationParametersModel,
                { uuid: row.uuid },
                {
                    configValue:
                        value as OrganizationParametersModel['configValue'],
                },
            );
            return;
        }
        await manager.insert(OrganizationParametersModel, {
            uuid: uuidv4(),
            configKey: OrganizationParametersKey.CHATGPT_PLAN_AUTH,
            configValue: value,
            organization: { uuid: organizationId },
        } as OrganizationParametersModel);
    }
}
