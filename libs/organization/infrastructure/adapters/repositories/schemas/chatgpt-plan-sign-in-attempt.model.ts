import { Column, Entity, Index } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';

/**
 * One pending "Sign in with ChatGPT" attempt: single-use, bound to the user and
 * organisation that started it. `codeVerifier` is `encrypt()` ciphertext.
 */
@Entity('chatgpt_plan_sign_in_attempts')
@Index('UQ_chatgpt_plan_sign_in_attempts_state', ['state'], { unique: true })
@Index('IDX_chatgpt_plan_sign_in_attempts_org', ['organizationId'])
export class ChatGptPlanSignInAttemptModel extends CoreModel {
    @Column({ type: 'varchar', length: 64 })
    state: string;

    @Column({ type: 'varchar', length: 64 })
    nonce: string;

    @Column({ type: 'text', name: 'code_verifier' })
    codeVerifier: string;

    @Column({ type: 'uuid', name: 'organization_id' })
    organizationId: string;

    @Column({ type: 'uuid', name: 'user_id' })
    userId: string;

    /** Saved issued client id of a returning sign-in; null registers anew. */
    @Column({ type: 'varchar', length: 255, nullable: true, name: 'client_id' })
    clientId?: string | null;

    /** `sub` a returning sign-in must come back with. */
    @Column({
        type: 'varchar',
        length: 255,
        nullable: true,
        name: 'expected_sub',
    })
    expectedSub?: string | null;

    @Column({ type: 'timestamptz', name: 'expires_at' })
    expiresAt: Date;

    @Column({ type: 'timestamptz', nullable: true, name: 'consumed_at' })
    consumedAt?: Date | null;
}
