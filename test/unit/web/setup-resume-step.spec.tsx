/** @jest-environment jsdom */
const mockRedirect = jest.fn((href: string) => {
    throw new Error(`redirect:${href}`);
});
const mockCookies: Record<string, string> = {};
let mockTeamId = 'new-team';

const mockNavigation = {
    redirect: (href: string) => mockRedirect(href),
    usePathname: () => '/setup',
};
jest.mock('next/navigation', () => mockNavigation);
// Local installs can carry separate Next copies at the root and in apps/web.
jest.doMock(
    require.resolve('next/navigation', {
        paths: [`${process.cwd()}/apps/web`],
    }),
    () => mockNavigation,
);
jest.mock('cookies-next/client', () => ({
    getCookie: (name: string) => mockCookies[name],
    setCookie: (name: string, value: string) => {
        mockCookies[name] = value;
    },
}));
jest.mock('src/core/providers/auth.provider', () => ({
    useAuth: () => ({ userId: 'user-1' }),
}));
jest.mock('src/core/providers/selected-team-context', () => ({
    useSelectedTeamId: () => ({ teamId: mockTeamId }),
}));

const Setup = require('../../../apps/web/src/app/(setup)/setup/page').default;
const {
    getSetupCookieName,
} = require('../../../apps/web/src/app/(setup)/setup/_components/setup-step-tracker');

beforeEach(() => {
    for (const key of Object.keys(mockCookies)) delete mockCookies[key];
    mockRedirect.mockClear();
});

it("does not resume another team's setup progress", () => {
    mockCookies[getSetupCookieName('user-1', 'onboarded')] =
        '/setup/choosing-a-pull-request';
    mockTeamId = 'new-team';

    expect(() => Setup()).toThrow('redirect:/setup/choose-workspace');
});

it("resumes the selected team's own setup progress", () => {
    mockCookies[getSetupCookieName('user-1', 'new-team')] =
        '/setup/choosing-repositories';
    mockTeamId = 'new-team';

    expect(() => Setup()).toThrow('redirect:/setup/choosing-repositories');
});
