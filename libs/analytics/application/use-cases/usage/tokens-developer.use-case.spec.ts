import { TokensByDeveloperUseCase } from './tokens-developer.use-case';

describe('TokensByDeveloperUseCase cache lifetime', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    // Midday UTC, so the "includes today" classification cannot flip mid-test.
    const NOW = new Date('2026-11-10T12:00:00.000Z');

    beforeEach(() => {
        jest.useFakeTimers({ now: NOW });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    const cacheLifetimeFor = async (end: Date) => {
        const cacheService = {
            getFromCache: jest.fn().mockResolvedValue(null),
            addToCache: jest.fn(),
        };
        const useCase = new TokensByDeveloperUseCase(
            { getUsageByPr: jest.fn().mockResolvedValue([]) } as any,
            {} as any,
            cacheService as any,
        );
        jest.spyOn(useCase as any, 'getPullRequestsMap').mockResolvedValue(
            new Map(),
        );

        await useCase.execute(
            {
                organizationId: 'org-1',
                byok: true,
                start: new Date(end.getTime() - 14 * DAY_MS),
                end,
            } as any,
            false,
        );

        return cacheService.addToCache.mock.calls[0][2];
    };

    it('refreshes a window that includes today within 5 minutes', async () => {
        expect(await cacheLifetimeFor(NOW)).toBe(5 * 60 * 1000);
    });

    it('keeps a window that ended before today for 4 hours', async () => {
        expect(
            await cacheLifetimeFor(new Date(NOW.getTime() - 3 * DAY_MS)),
        ).toBe(4 * 60 * 60 * 1000);
    });
});
