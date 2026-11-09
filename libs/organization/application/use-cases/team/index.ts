import { AddTeamUseCase } from './add.use-case';
import { CreateTeamUseCase } from './create.use-case';
import { ListTeamsWithIntegrationsUseCase } from './list-with-integrations.use-case';
import { ListTeamsUseCase } from './list.use-case';

export const UseCases = [
    AddTeamUseCase,
    CreateTeamUseCase,
    ListTeamsUseCase,
    ListTeamsWithIntegrationsUseCase,
];
