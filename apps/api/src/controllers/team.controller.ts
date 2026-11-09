import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    CheckPolicies,
    PolicyGuard,
} from '@libs/identity/infrastructure/adapters/services/permissions/policy.guard';
import { checkPermissions } from '@libs/identity/infrastructure/adapters/services/permissions/policy.handlers';
import { AddTeamUseCase } from '@libs/organization/application/use-cases/team/add.use-case';
import { ListTeamsWithIntegrationsUseCase } from '@libs/organization/application/use-cases/team/list-with-integrations.use-case';
import { ListTeamsUseCase } from '@libs/organization/application/use-cases/team/list.use-case';
import {
    ApiBearerAuth,
    ApiCreatedResponse,
    ApiOkResponse,
    ApiOperation,
    ApiTags,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';
import { ApiArrayResponseDto } from '../dtos/api-response.dto';
import { CreateTeamDto } from '../dtos/create-team.dto';
import {
    TeamListResponseDto,
    TeamResponseDto,
} from '../dtos/team-response.dto';

@ApiTags('Team')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('team')
export class TeamController {
    constructor(
        private readonly addTeamUseCase: AddTeamUseCase,
        private readonly listTeamsUseCase: ListTeamsUseCase,
        private readonly listTeamsWithIntegrationsUseCase: ListTeamsWithIntegrationsUseCase,
    ) {}

    @Get('/')
    @ApiOperation({
        summary: 'List teams',
        description: 'Return teams for the authenticated organization.',
    })
    @ApiOkResponse({ type: TeamListResponseDto })
    public async list() {
        return await this.listTeamsUseCase.execute();
    }

    @Get('/list-with-integrations')
    @ApiOperation({
        summary: 'List teams with integrations',
        description: 'Return teams and their integration status.',
    })
    @ApiOkResponse({ type: ApiArrayResponseDto })
    public async listWithIntegrations() {
        return await this.listTeamsWithIntegrationsUseCase.execute();
    }

    @Post('/')
    @UseGuards(PolicyGuard)
    @CheckPolicies(
        checkPermissions({
            action: Action.Create,
            resource: ResourceType.OrganizationSettings,
        }),
    )
    @ApiOperation({
        summary: 'Create team',
        description:
            'Create an active team in the authenticated organization and add the caller as its leader.',
    })
    @ApiCreatedResponse({ type: TeamResponseDto })
    public async create(@Body() body: CreateTeamDto) {
        return await this.addTeamUseCase.execute(body.teamName);
    }
}
