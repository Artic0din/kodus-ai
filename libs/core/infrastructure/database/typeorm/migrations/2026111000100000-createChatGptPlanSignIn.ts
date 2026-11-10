import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Pending "Sign in with ChatGPT" attempts (single-use, 10-minute, bound to a
 * user and organisation) and the one `ext_agent_host_id` this install sends to
 * OpenAI.
 */
export class CreateChatGptPlanSignIn2026111000100000 implements MigrationInterface {
    name = 'CreateChatGptPlanSignIn2026111000100000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "chatgpt_plan_sign_in_attempts" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "updatedAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "state" varchar(64) NOT NULL,
                "nonce" varchar(64) NOT NULL,
                "code_verifier" text NOT NULL,
                "organization_id" uuid NOT NULL,
                "user_id" uuid NOT NULL,
                "client_id" varchar(255),
                "expected_sub" varchar(255),
                "expires_at" timestamptz NOT NULL,
                "consumed_at" timestamptz,
                CONSTRAINT "PK_chatgpt_plan_sign_in_attempts_uuid" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_chatgpt_plan_sign_in_attempts_state"
            ON "chatgpt_plan_sign_in_attempts" ("state")
        `);
        await queryRunner.query(`
            CREATE INDEX "IDX_chatgpt_plan_sign_in_attempts_org"
            ON "chatgpt_plan_sign_in_attempts" ("organization_id")
        `);

        await queryRunner.query(`
            CREATE TABLE "chatgpt_plan_install" (
                "uuid" uuid NOT NULL DEFAULT uuid_generate_v4(),
                "createdAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "updatedAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
                "ext_agent_host_id" varchar(64) NOT NULL,
                "singleton" boolean NOT NULL DEFAULT true,
                CONSTRAINT "PK_chatgpt_plan_install_uuid" PRIMARY KEY ("uuid")
            )
        `);
        await queryRunner.query(`
            CREATE UNIQUE INDEX "UQ_chatgpt_plan_install_singleton"
            ON "chatgpt_plan_install" ("singleton")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "chatgpt_plan_install"`);
        await queryRunner.query(`DROP TABLE "chatgpt_plan_sign_in_attempts"`);
    }
}
