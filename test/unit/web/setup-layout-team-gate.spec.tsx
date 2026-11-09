const mockRedirect = jest.fn((href: string) => {
    throw new Error(`redirect:${href}`);
});
const mockGetTeamParameters = jest.fn();
let mockCookieTeamId: string | undefined;

const mockNavigation = {
    redirect: (href: string) => mockRedirect(href),
};
const mockHeaders = {
    cookies: async () => ({
        get: () =>
            mockCookieTeamId ? { value: mockCookieTeamId } : undefined,
    }),
};
jest.mock('next/navigation', () => mockNavigation);
jest.mock('next/headers', () => mockHeaders);
// Local installs can carry separate Next copies at the root and in apps/web.
const webNext = (name: string) =>
    require.resolve(name, { paths: [`${process.cwd()}/apps/web`] });
jest.doMock(webNext('next/navigation'), () => mockNavigation);
jest.doMock(webNext('next/headers'), () => mockHeaders);
jest.mock('@services/teams/fetch', () => ({
    getTeams: async () => [
        { uuid: 'onboarded', name: 'Artic0din', status: 'active' },
        { uuid: 'new-team', name: 'Plaintext-Lab', status: 'active' },
    ],
}));
jest.mock('@services/organizations/fetch', () => ({
    getOrganizationId: async () => 'org-1',
    getOrganizationName: async () => 'Org',
}));
jest.mock('@services/parameters/fetch', () => ({
    getTeamParametersNoCache: (args: { teamId: string }) =>
        mockGetTeamParameters(args),
}));
jest.mock('src/core/config/auth', () => ({
    auth: async () => ({ user: { status: 'active' } }),
}));
jest.mock('src/core/utils/headers', () => ({
    getCurrentPathnameOnServerComponents: async () => '/setup',
}));
jest.mock('src/core/layout/navbar/_components/support', () => ({
    SupportDropdown: () => null,
}));
jest.mock('src/core/providers/auth.provider', () => ({
    AuthProvider: () => null,
}));
jest.mock('src/core/providers/all-teams-context', () => ({
    AllTeamsProvider: () => null,
}));
jest.mock('src/core/providers/selected-team-context', () => ({
    SelectedTeamProvider: () => null,
}));
jest.mock(
    'src/features/organization/_providers/organization-context',
    () => ({ OrganizationProvider: () => null }),
);
jest.mock('@components/ui/magic-modal', () => ({
    MagicModalPortal: () => null,
}));
jest.mock(
    '../../../apps/web/src/app/(setup)/_components/setup-github-stars',
    () => ({ SetupGithubStars: () => null }),
);
jest.mock(
    '../../../apps/web/src/app/(setup)/_components/setup-user-nav',
    () => ({ SetupUserNav: () => null }),
);
jest.mock(
    '../../../apps/web/src/app/(setup)/setup/_components/setup-step-tracker',
    () => ({ SetupProgressSaver: () => null }),
);

const Layout = require('../../../apps/web/src/app/(setup)/layout').default;

beforeEach(() => {
    jest.clearAllMocks();
    mockGetTeamParameters.mockImplementation(
        async ({ teamId }: { teamId: string }) => ({
            configValue: { finishOnboard: teamId === 'onboarded' },
        }),
    );
});

it('lets a selected team that has not finished onboarding stay on setup', async () => {
    mockCookieTeamId = 'new-team';

    await Layout({ children: null });

    expect(mockGetTeamParameters).toHaveBeenCalledWith(
        expect.objectContaining({ teamId: 'new-team' }),
    );
    expect(mockRedirect).not.toHaveBeenCalled();
});

it('sends an onboarded selected team back to the app', async () => {
    mockCookieTeamId = 'onboarded';

    await expect(Layout({ children: null })).rejects.toThrow('redirect:/');
});

it('falls back to the first active team without a selection cookie', async () => {
    mockCookieTeamId = undefined;

    await expect(Layout({ children: null })).rejects.toThrow('redirect:/');
});
