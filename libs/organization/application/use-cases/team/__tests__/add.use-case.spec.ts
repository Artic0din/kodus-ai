import { ConflictException } from '@nestjs/common';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { TeamEntity } from '@libs/organization/domain/team/entities/team.entity';
import { TeamMemberRole } from '@libs/organization/domain/teamMembers/enums/teamMemberRole.enum';

import { AddTeamUseCase } from '../add.use-case';

describe('AddTeamUseCase', () => {
    const organization = { uuid: 'org-1', name: 'Acme' };
    const requestUser = {
        uuid: 'user-1',
        role: 'owner',
        organization,
    };

    const buildUseCase = () => {
        const pendingTeam = TeamEntity.create({
            uuid: 'team-2',
            name: 'Plaintext-Lab',
            status: STATUS.PENDING,
            organization,
        });
        const activeTeam = TeamEntity.create({
            uuid: 'team-2',
            name: 'Plaintext-Lab',
            status: STATUS.ACTIVE,
            organization,
        });

        const createTeamUseCase = {
            execute: jest.fn().mockResolvedValue(pendingTeam),
        };
        const teamService = {
            update: jest.fn().mockResolvedValue(activeTeam),
            deleteOne: jest.fn().mockResolvedValue(undefined),
        };
        const teamMembersService = {
            create: jest.fn().mockResolvedValue({ uuid: 'member-1' }),
        };
        const userService = {
            findOne: jest
                .fn()
                .mockResolvedValue({ uuid: 'user-1', organization }),
        };
        const profileService = {
            findOne: jest.fn().mockResolvedValue({ name: 'Ryan' }),
        };

        const useCase = new AddTeamUseCase(
            teamService as any,
            teamMembersService as any,
            userService as any,
            profileService as any,
            createTeamUseCase as any,
            { user: requestUser } as any,
        );

        return {
            useCase,
            createTeamUseCase,
            teamService,
            teamMembersService,
        };
    };

    it('creates the team in the caller organisation and returns it active', async () => {
        const { useCase, createTeamUseCase, teamService } = buildUseCase();

        const result = await useCase.execute('Plaintext-Lab');

        expect(createTeamUseCase.execute).toHaveBeenCalledWith({
            teamName: 'Plaintext-Lab',
            organizationId: 'org-1',
            organizationName: 'Acme',
            actorUserId: 'user-1',
        });
        expect(teamService.update).toHaveBeenCalledWith(
            { uuid: 'team-2' },
            { status: STATUS.ACTIVE },
        );
        expect(result).toEqual({
            uuid: 'team-2',
            name: 'Plaintext-Lab',
            status: STATUS.ACTIVE,
            cliConfig: undefined,
        });
    });

    it('adds the caller as team leader of the new team', async () => {
        const { useCase, teamMembersService } = buildUseCase();

        await useCase.execute('Plaintext-Lab');

        expect(teamMembersService.create).toHaveBeenCalledWith(
            expect.objectContaining({
                user: expect.objectContaining({ uuid: 'user-1' }),
                name: 'Ryan',
                organization,
                team: expect.objectContaining({ uuid: 'team-2' }),
                teamRole: TeamMemberRole.TEAM_LEADER,
                status: true,
            }),
        );
    });

    it('propagates a duplicate team name and creates nothing else', async () => {
        const { useCase, createTeamUseCase, teamService, teamMembersService } =
            buildUseCase();
        createTeamUseCase.execute.mockRejectedValue(
            new ConflictException('api.team.team_name_already_exists'),
        );

        await expect(useCase.execute('Plaintext-Lab')).rejects.toBeInstanceOf(
            ConflictException,
        );
        expect(teamService.update).not.toHaveBeenCalled();
        expect(teamMembersService.create).not.toHaveBeenCalled();
    });

    it('removes the new team and fails when the leader membership is not saved', async () => {
        const { useCase, teamService, teamMembersService } = buildUseCase();
        const dbError = new Error('insert failed');
        // The repository returns database errors instead of throwing them.
        teamMembersService.create.mockResolvedValue(dbError);

        await expect(useCase.execute('Plaintext-Lab')).rejects.toBe(dbError);
        expect(teamService.deleteOne).toHaveBeenCalledWith('team-2');
    });

    it('removes the new team and fails when activation fails', async () => {
        const { useCase, teamService, teamMembersService } = buildUseCase();
        teamService.update.mockResolvedValue(undefined);

        await expect(useCase.execute('Plaintext-Lab')).rejects.toThrow(
            'Failed to activate the new team',
        );
        expect(teamService.deleteOne).toHaveBeenCalledWith('team-2');
        expect(teamMembersService.create).not.toHaveBeenCalled();
    });
});
