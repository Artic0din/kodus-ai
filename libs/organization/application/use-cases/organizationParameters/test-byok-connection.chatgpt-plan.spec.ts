/**
 * The connection probe for the ChatGPT plan: it needs no key, threads the
 * authenticated organisation (never a client-sent one) onto the probed slot,
 * and words a route failure by its code.
 */
import { APICallError } from 'ai';

import { TestByokConnectionUseCase } from './test-byok-connection.use-case';

const probeSlotCall = jest.fn();
jest.mock('@libs/llm/probe-slot-call', () => ({
    probeSlotCall: (...args: unknown[]) => probeSlotCall(...args),
}));
jest.mock('@libs/common/utils/crypto', () => ({
    encrypt: (v: string) => `enc(${v})`,
    decrypt: (v: string) => v,
}));

const useCase = () =>
    new TestByokConnectionUseCase({ isProviderSupported: () => true } as any);

const input = { provider: 'chatgpt_plan', model: 'gpt-5.4' };

const routeError = (status: number, code: string) =>
    new APICallError({
        message: 'Bad',
        url: 'https://api.openai.com/v1/responses',
        requestBodyValues: {},
        statusCode: status,
        responseBody: JSON.stringify({
            error: { code, message: 'route words' },
        }),
    });

beforeEach(() => {
    probeSlotCall.mockReset();
    probeSlotCall.mockResolvedValue({
        latencyMs: 5,
        unreachedOverrideKeys: [],
    });
});

describe('TestByokConnectionUseCase — chatgpt_plan', () => {
    it('probes without an apiKey and stamps the executing organisation on the slot', async () => {
        const result = await useCase().execute(input, 'org-real');
        expect(result).toMatchObject({ ok: true, verifiedBy: 'probe' });
        expect(probeSlotCall.mock.calls[0][0]).toMatchObject({
            provider: 'chatgpt_plan',
            model: 'gpt-5.4',
            organizationId: 'org-real',
        });
    });

    it('ignores an organisation id smuggled in the form input', async () => {
        await useCase().execute(
            { ...input, organizationId: 'org-forged' } as any,
            'org-real',
        );
        expect(probeSlotCall.mock.calls[0][0].organizationId).toBe('org-real');
    });

    it('stamps no organisation when the caller has none, rather than a client-sent one', async () => {
        await useCase().execute({
            ...input,
            organizationId: 'org-forged',
        } as any);
        expect(probeSlotCall.mock.calls[0][0].organizationId).toBeUndefined();
    });

    it('still demands a key from every other provider', async () => {
        await expect(
            useCase().execute(
                { provider: 'openai', model: 'gpt-5.4' },
                'org-1',
            ),
        ).rejects.toThrow(/apiKey is required/);
    });

    it.each([
        [
            'subscription_sharing_usage_limit_exceeded',
            402,
            'payment',
            /usage limit is reached/,
        ],
        ['subscription_sharing_invalid_user', 401, 'auth', /Sign in again/],
        [
            'subscription_sharing_user_not_eligible',
            401,
            'auth',
            /not available for this ChatGPT account/,
        ],
        [
            'chatpass_v2_account_blocked',
            401,
            'auth',
            /not available for this ChatGPT account/,
        ],
        [
            'subscription_sharing_usage_unavailable',
            503,
            'server_error',
            /temporarily unavailable/,
        ],
        [
            'subscription_sharing_unsupported_capability',
            400,
            'bad_request',
            /does not support this request/,
        ],
    ])(
        'words %s by its route code, not the API-key copy',
        async (code, status, resultCode, copy) => {
            probeSlotCall.mockRejectedValue(routeError(status, code));
            const result = await useCase().execute(input, 'org-1');
            expect(result).toMatchObject({
                ok: false,
                code: resultCode,
                httpStatus: status,
            });
            expect(result.message).toMatch(copy);
            expect(result.message).not.toMatch(/API key/i);
        },
    );

    it('falls back to the status mapping for an error with no route code', async () => {
        probeSlotCall.mockRejectedValue(
            new APICallError({
                message: 'Not Found',
                url: 'https://api.openai.com/v1/responses',
                requestBodyValues: {},
                statusCode: 404,
                responseBody: JSON.stringify({
                    error: { message: 'no such model' },
                }),
            }),
        );
        const result = await useCase().execute(input, 'org-1');
        expect(result).toMatchObject({ ok: false, code: 'not_found' });
    });

    it('does not apply route wording to another provider that happens to quote a code', async () => {
        probeSlotCall.mockRejectedValue(
            routeError(401, 'subscription_sharing_invalid_user'),
        );
        const result = await useCase().execute(
            { provider: 'openai', model: 'gpt-5.4', apiKey: 'sk' },
            'org-1',
        );
        expect(result.message).toMatch(/rejected this API key/);
    });
});
