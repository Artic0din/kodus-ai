import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

export interface NewSignInAttempt {
    state: string;
    nonce: string;
    /** `encrypt()` ciphertext. */
    codeVerifier: string;
    organizationId: string;
    userId: string;
    clientId?: string;
    expectedSub?: string;
    expiresAt: Date;
}

export interface ClaimedSignInAttempt {
    nonce: string;
    codeVerifier: string;
    clientId?: string;
    expectedSub?: string;
}

export type SignInAttemptClaim =
    | { kind: 'claimed'; attempt: ClaimedSignInAttempt }
    | { kind: 'missing' | 'expired' | 'used' };

/** Persistence seam for pending sign-in attempts and the install host id. */
export interface ChatGptPlanSignInStore {
    /** The install's `ext_agent_host_id` (`urn:uuid:…`), created once. */
    getOrCreateHostId(): Promise<string>;
    /** Saves the attempt and drops this user's older ones and any expired. */
    createAttempt(attempt: NewSignInAttempt, now: Date): Promise<void>;
    /**
     * Marks the attempt used and returns it, atomically, so a replayed
     * callback cannot claim it twice. An attempt of another user or
     * organisation reads as `missing`.
     */
    claimAttempt(input: {
        state: string;
        organizationId: string;
        userId: string;
        now: Date;
    }): Promise<SignInAttemptClaim>;
}

export const CHATGPT_PLAN_SIGN_IN_STORE = Symbol('ChatGptPlanSignInStore');

interface AttemptRow {
    uuid: string;
    nonce: string;
    code_verifier: string;
    client_id: string | null;
    expected_sub: string | null;
    expires_at: Date;
    consumed_at: Date | null;
}

@Injectable()
export class TypeOrmChatGptPlanSignInStore implements ChatGptPlanSignInStore {
    constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

    async getOrCreateHostId(): Promise<string> {
        await this.dataSource.query(
            `INSERT INTO "chatgpt_plan_install" ("ext_agent_host_id")
             VALUES ($1) ON CONFLICT ("singleton") DO NOTHING`,
            [`urn:uuid:${randomUUID()}`],
        );
        const rows: Array<{ ext_agent_host_id: string }> =
            await this.dataSource.query(
                `SELECT "ext_agent_host_id" FROM "chatgpt_plan_install" LIMIT 1`,
            );
        return rows[0].ext_agent_host_id;
    }

    async createAttempt(attempt: NewSignInAttempt, now: Date): Promise<void> {
        await this.dataSource.transaction(async (manager) => {
            await manager.query(
                `DELETE FROM "chatgpt_plan_sign_in_attempts"
                 WHERE "expires_at" < $1
                    OR ("organization_id" = $2 AND "user_id" = $3)`,
                [now, attempt.organizationId, attempt.userId],
            );
            await manager.query(
                `INSERT INTO "chatgpt_plan_sign_in_attempts"
                    ("state", "nonce", "code_verifier", "organization_id",
                     "user_id", "client_id", "expected_sub", "expires_at")
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    attempt.state,
                    attempt.nonce,
                    attempt.codeVerifier,
                    attempt.organizationId,
                    attempt.userId,
                    attempt.clientId ?? null,
                    attempt.expectedSub ?? null,
                    attempt.expiresAt,
                ],
            );
        });
    }

    claimAttempt(input: {
        state: string;
        organizationId: string;
        userId: string;
        now: Date;
    }): Promise<SignInAttemptClaim> {
        return this.dataSource.transaction(async (manager) => {
            const rows: AttemptRow[] = await manager.query(
                `SELECT "uuid", "nonce", "code_verifier", "client_id",
                        "expected_sub", "expires_at", "consumed_at"
                 FROM "chatgpt_plan_sign_in_attempts"
                 WHERE "state" = $1 AND "organization_id" = $2 AND "user_id" = $3
                 FOR UPDATE`,
                [input.state, input.organizationId, input.userId],
            );
            const row = rows[0];
            if (!row) return { kind: 'missing' };
            if (row.consumed_at) return { kind: 'used' };
            if (new Date(row.expires_at) <= input.now) {
                return { kind: 'expired' };
            }
            await manager.query(
                `UPDATE "chatgpt_plan_sign_in_attempts"
                 SET "consumed_at" = $2 WHERE "uuid" = $1`,
                [row.uuid, input.now],
            );
            return {
                kind: 'claimed',
                attempt: {
                    nonce: row.nonce,
                    codeVerifier: row.code_verifier,
                    clientId: row.client_id ?? undefined,
                    expectedSub: row.expected_sub ?? undefined,
                },
            };
        });
    }
}
