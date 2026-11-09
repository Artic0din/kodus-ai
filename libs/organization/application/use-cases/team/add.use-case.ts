import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import {
    IProfileService,
    PROFILE_SERVICE_TOKEN,
} from '@libs/identity/domain/profile/contracts/profile.service.contract';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { ITeam } from '@libs/organization/domain/team/interfaces/team.interface';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@libs/organization/domain/teamMembers/contracts/teamMembers.service.contracts';
import { TeamMemberRole } from '@libs/organization/domain/teamMembers/enums/teamMemberRole.enum';

import { CreateTeamUseCase } from './create.use-case';

@Injectable()
export class AddTeamUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: ITeamMemberService,

        @Inject(USER_SERVICE_TOKEN)
        private readonly userService: IUsersService,

        @Inject(PROFILE_SERVICE_TOKEN)
        private readonly profileService: IProfileService,

        private readonly createTeamUseCase: CreateTeamUseCase,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: {
                uuid: string;
                organization: { uuid: string; name?: string };
            };
        },
    ) {}

    public async execute(teamName: string): Promise<Partial<ITeam>> {
        const { uuid: userId, organization } = this.request.user;

        const [user, profile] = await Promise.all([
            this.userService.findOne({ uuid: userId }),
            this.profileService.findOne({ user: { uuid: userId } }),
        ]);

        if (!user || !profile) {
            throw new Error('User or profile not found for the requester');
        }

        const team = await this.createTeamUseCase.execute({
            teamName,
            organizationId: organization.uuid,
            organizationName: organization.name,
            actorUserId: userId,
        });

        if (!team) {
            throw new Error('Team creation failed');
        }

        // Teams start PENDING and only turn ACTIVE once repositories are saved,
        // but the web switcher disables PENDING teams, so the user could never
        // select this one to connect a Git provider.
        try {
            const activeTeam = await this.teamService.update(
                { uuid: team.uuid },
                { status: STATUS.ACTIVE },
            );

            if (!activeTeam) {
                throw new Error('Failed to activate the new team');
            }

            // The repository returns database errors instead of throwing.
            const member: unknown = await this.teamMembersService.create({
                user,
                name: profile.name,
                organization: user.organization,
                team: activeTeam,
                teamRole: TeamMemberRole.TEAM_LEADER,
                status: true,
            });

            if (member instanceof Error) {
                throw member;
            }

            return activeTeam.toJson();
        } catch (error) {
            // Soft delete frees the name: the duplicate check ignores REMOVED teams.
            await this.teamService.deleteOne(team.uuid);
            throw error;
        }
    }
}
