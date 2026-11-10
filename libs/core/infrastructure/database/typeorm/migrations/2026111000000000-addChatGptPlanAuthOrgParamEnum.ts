import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `chatgpt_plan_auth` to the `organization_parameters_configkey_enum`
 * Postgres enum so an organization's encrypted ChatGPT plan sign-in can be
 * persisted as an organization_parameters row. Without it, any read or write of
 * the key fails with `invalid input value for enum ...`.
 *
 * TypeORM cannot auto-generate `ALTER TYPE ... ADD VALUE` migrations, so this
 * is hand-written following the same idempotent pattern as
 * `2026072200000000-addGlobalRulesSourceOrgParamEnum.ts`.
 */
export class AddChatGptPlanAuthOrgParamEnum2026111000000000 implements MigrationInterface {
    name = 'AddChatGptPlanAuthOrgParamEnum2026111000000000';

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'organization_parameters_configkey_enum') THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM pg_enum
                        WHERE enumlabel = 'chatgpt_plan_auth'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum')
                    ) THEN
                        ALTER TYPE "public"."organization_parameters_configkey_enum"
                        ADD VALUE 'chatgpt_plan_auth';
                    END IF;
                END IF;
            END $$;
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'organization_parameters_configkey_enum') THEN
                    IF EXISTS (
                        SELECT 1 FROM pg_enum
                        WHERE enumlabel = 'chatgpt_plan_auth'
                        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum')
                    ) THEN
                        DELETE FROM "organization_parameters" WHERE "configKey" = 'chatgpt_plan_auth';

                        ALTER TYPE "public"."organization_parameters_configkey_enum" RENAME TO "organization_parameters_configkey_enum_old";

                        EXECUTE (
                            SELECT 'CREATE TYPE "public"."organization_parameters_configkey_enum" AS ENUM (' ||
                            string_agg(quote_literal(enumlabel), ', ' ORDER BY enumsortorder) ||
                            ')'
                            FROM pg_enum
                            WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'organization_parameters_configkey_enum_old')
                            AND enumlabel <> 'chatgpt_plan_auth'
                        );

                        ALTER TABLE "organization_parameters"
                        ALTER COLUMN "configKey" TYPE "public"."organization_parameters_configkey_enum"
                        USING "configKey"::"text"::"public"."organization_parameters_configkey_enum";

                        DROP TYPE "public"."organization_parameters_configkey_enum_old";
                    END IF;
                END IF;
            END $$;
        `);
    }
}
