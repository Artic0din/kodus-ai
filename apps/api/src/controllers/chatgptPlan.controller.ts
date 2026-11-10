import { Body, Controller, Get, Inject, Post, UseGuards } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';

import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { ChatGptPlanConnectionUseCase } from '@libs/organization/application/use-cases/organizationParameters/chatgpt-plan-connection.use-case';

import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { TenantScopeGuard } from '../guards/tenant-scope.guard';

/**
 * Connect, switch and sign out of the organisation's ChatGPT plan. Reading the
 * status needs organisation-settings read; every change needs the same
 * permission as editing BYOK settings.
 */
@ApiTags('Organization Parameters')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@UseGuards(TenantScopeGuard)
@Controller('organization-parameters/chatgpt-plan')
export class ChatGptPlanController {
    constructor(
        private readonly connection: ChatGptPlanConnectionUseCase,
        @Inject(REQUEST) private readonly request: UserRequest,
    ) {}

    @Get('/status')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Read,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({
        summary: 'ChatGPT plan connection status',
        description:
            'Return `{ status, email }`: not_connected, connected, reauth_required or not_eligible. Never returns a token.',
    })
    public async status() {
        return this.connection.status(this.organizationId());
    }

    @Post('/sign-in/start')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiBody({
        schema: {
            type: 'object',
            properties: { differentAccount: { type: 'boolean' } },
        },
    })
    @ApiOperation({
        summary: 'Start Sign in with ChatGPT',
        description:
            'Create a single-use, 10-minute sign-in attempt and return the OpenAI address to open in the browser. `differentAccount` registers a new client instead of reusing the saved one.',
    })
    public async start(@Body() body?: { differentAccount?: boolean }) {
        return this.connection.start(this.context(), {
            differentAccount: body?.differentAccount,
        });
    }

    @Post('/sign-in/complete')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiBody({
        schema: {
            type: 'object',
            required: ['callbackUrl'],
            properties: { callbackUrl: { type: 'string' } },
        },
    })
    @ApiOperation({
        summary: 'Finish Sign in with ChatGPT',
        description:
            'Paste the address the browser landed on. Verifies the attempt and the ID token, then stores the connection.',
    })
    public async complete(@Body() body: { callbackUrl?: unknown }) {
        return this.connection.complete(this.context(), body?.callbackUrl);
    }

    @Post('/sign-out')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({
        summary: 'Sign out of ChatGPT',
        description:
            'Revoke the session at OpenAI (best effort) and clear the stored tokens. The registration is kept. `revocationConfirmed` is false when OpenAI did not confirm.',
    })
    public async signOut() {
        return this.connection.signOut(this.organizationId());
    }

    private organizationId(): string {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('Organization ID is missing from request');
        }
        return organizationId;
    }

    private context() {
        const userId = this.request?.user?.uuid;
        if (!userId) throw new Error('User ID is missing from request');
        return { organizationId: this.organizationId(), userId };
    }
}
