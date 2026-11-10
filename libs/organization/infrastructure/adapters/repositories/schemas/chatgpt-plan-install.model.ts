import { Column, Entity, Index } from 'typeorm';

import { CoreModel } from '@libs/core/infrastructure/repositories/model/typeOrm';

/**
 * The one `ext_agent_host_id` this Kodus install sends to OpenAI, created on
 * first use. `singleton` is always true; its unique index keeps the table to
 * one row.
 */
@Entity('chatgpt_plan_install')
@Index('UQ_chatgpt_plan_install_singleton', ['singleton'], { unique: true })
export class ChatGptPlanInstallModel extends CoreModel {
    @Column({ type: 'varchar', length: 64, name: 'ext_agent_host_id' })
    extAgentHostId: string;

    @Column({ type: 'boolean', default: true })
    singleton: boolean;
}
