/**
 * The ChatGPT plan through `LLM.run`, against a fake Responses SSE server.
 *
 * Every row of the design's error table is run twice: with no fallback, to read
 * the status and category the call fails with and how many requests the primary
 * took; and with the org's API-key model as the fallback, to see whether it
 * serves. The fake server stands in for OpenAI at the global `fetch`, so the
 * real SDK, the real adapter, the real classifier and the real failover run.
 */
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        warn: jest.fn(),
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        log: jest.fn(),
    }),
}));

import type { NormalizedModel } from '@libs/llm/byok-config';
import { classifyLLMError, LlmErrorCategory } from '@libs/llm/error-classifier';
import { LLM } from '@libs/llm/llm';
import { recordModelFailovers } from '@libs/llm/model-failover';
import '@libs/llm/providers';
import {
    ChatGptPlanTokenError,
    setChatGptPlanTokenProvider,
} from './token-provider';
import { __planFetchInternals } from './plan-fetch';
import {
    FakePlanServer,
    apiJsonResponse,
    completedStream,
    failedStream,
    truncatedStream,
    type RecordedRequest,
} from '../../testing/fake-plan-server';

const ORG = 'org-run';
const PLAN_BEARER = 'Bearer plan-token';
const API_BEARER = 'Bearer sk-fallback';

const planSlot: NormalizedModel = {
    provider: 'chatgpt_plan',
    apiKey: '',
    model: 'gpt-5.4',
    byokModelId: 'plan-model',
    credentialId: 'plan-cred',
} as NormalizedModel;

const apiSlot = {
    provider: 'openai',
    apiKey: 'sk-fallback',
    model: 'gpt-5.4-mini',
    byokModelId: 'api-model',
    credentialId: 'api-cred',
} as NormalizedModel;

const withFallback: NormalizedModel = { ...planSlot, fallback: apiSlot };

let server: FakePlanServer;
let forcedRefreshes: number;

/** Plan requests answer `onPlan`; the API-key fallback always succeeds. */
function serve(onPlan: () => Response): void {
    server.always((req: RecordedRequest) =>
        req.authorization === API_BEARER
            ? apiJsonResponse('served by fallback')
            : onPlan(),
    );
}
const planRequests = () =>
    server.requests.filter((r) => r.authorization === PLAN_BEARER);
const fallbackRequests = () =>
    server.requests.filter((r) => r.authorization === API_BEARER);

const runText = (slot: NormalizedModel) =>
    LLM.run({
        byokConfig: slot,
        user: 'review',
        system: 'sys',
        runName: 'plan.test',
        organizationId: ORG,
    });

async function failureOf(slot: NormalizedModel) {
    const error = await runText(slot).then(
        () => undefined,
        (e: unknown) => e,
    );
    expect(error).toBeDefined();
    return classifyLLMError(error);
}

beforeEach(() => {
    server = new FakePlanServer();
    forcedRefreshes = 0;
    __planFetchInternals.clearPauses();
    setChatGptPlanTokenProvider({
        getAccessToken: async (org, { forceRefresh }) => {
            expect(org).toBe(ORG);
            if (forceRefresh) forcedRefreshes += 1;
            return 'plan-token';
        },
    });
    jest.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
    // The one-shot re-issue waits a jittered backoff; do not wait it out.
    jest.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
    setChatGptPlanTokenProvider(undefined);
    jest.restoreAllMocks();
});

interface Row {
    name: string;
    stream: () => Response;
    status: number;
    category: LlmErrorCategory;
    /** Requests the plan takes before the call gives up (one-shot path). */
    primaryRequests: number;
    failsOver: boolean;
}

const ROWS: Row[] = [
    {
        name: 'usage limit',
        stream: () => failedStream('subscription_sharing_usage_limit_exceeded'),
        status: 402,
        category: LlmErrorCategory.QUOTA_EXCEEDED,
        primaryRequests: 1,
        failsOver: true,
    },
    {
        name: 'invalid user',
        stream: () => failedStream('subscription_sharing_invalid_user'),
        status: 401,
        category: LlmErrorCategory.AUTH_INVALID,
        primaryRequests: 1,
        failsOver: true,
    },
    {
        name: 'user not eligible',
        stream: () => failedStream('subscription_sharing_user_not_eligible'),
        status: 401,
        category: LlmErrorCategory.AUTH_INVALID,
        primaryRequests: 1,
        failsOver: true,
    },
    {
        name: 'chatpass code',
        stream: () => failedStream('chatpass_v2_account_blocked'),
        status: 401,
        category: LlmErrorCategory.AUTH_INVALID,
        primaryRequests: 1,
        failsOver: true,
    },
    {
        name: 'usage unavailable',
        stream: () => failedStream('subscription_sharing_usage_unavailable'),
        status: 503,
        category: LlmErrorCategory.TRANSIENT,
        primaryRequests: 2,
        failsOver: true,
    },
    {
        name: 'user unavailable',
        stream: () => failedStream('subscription_sharing_user_unavailable'),
        status: 503,
        category: LlmErrorCategory.TRANSIENT,
        primaryRequests: 2,
        failsOver: true,
    },
    {
        name: 'truncated stream',
        stream: () => truncatedStream(),
        status: 502,
        category: LlmErrorCategory.TRANSIENT,
        primaryRequests: 2,
        failsOver: true,
    },
    {
        name: 'unsupported capability',
        stream: () =>
            failedStream(
                'subscription_sharing_unsupported_capability',
                'no tools',
            ),
        status: 400,
        category: LlmErrorCategory.REQUEST_REJECTED,
        primaryRequests: 1,
        failsOver: false,
    },
    {
        name: 'route not supported',
        stream: () => failedStream('subscription_sharing_route_not_supported'),
        status: 400,
        category: LlmErrorCategory.REQUEST_REJECTED,
        primaryRequests: 1,
        failsOver: false,
    },
];

describe('the plan on the one-shot path (LLM.run text call)', () => {
    it('serves a review from the plan with no fallback involved', async () => {
        serve(() => completedStream('plan answer'));
        await expect(runText(withFallback)).resolves.toBe('plan answer');
        expect(planRequests()).toHaveLength(1);
        expect(fallbackRequests()).toHaveLength(0);
    });

    describe.each(ROWS)('$name', (row) => {
        it(`fails as HTTP ${row.status} / ${row.category} after ${row.primaryRequests} plan request(s)`, async () => {
            serve(row.stream);
            const classified = await failureOf(planSlot);
            expect(classified.httpStatus).toBe(row.status);
            expect(classified.category).toBe(row.category);
            expect(planRequests()).toHaveLength(row.primaryRequests);
            expect(fallbackRequests()).toHaveLength(0);
            // The user-facing sentence follows the route code, not the category.
            expect(classified.friendlyMessage).not.toMatch(/API key/i);
        });

        it(
            row.failsOver
                ? 'then the fallback serves, recorded as a failover'
                : 'and the fallback is NOT used',
            async () => {
                serve(row.stream);
                const outcome = await recordModelFailovers(() =>
                    runText(withFallback),
                ).then(
                    (r) => ({ ok: true as const, ...r }),
                    (error: unknown) => ({ ok: false as const, error }),
                );
                expect(planRequests()).toHaveLength(row.primaryRequests);
                if (row.failsOver) {
                    expect(outcome.ok).toBe(true);
                    if (outcome.ok) {
                        expect(outcome.value).toBe('served by fallback');
                        expect(outcome.failovers).toEqual([
                            {
                                runName: 'plan.test',
                                failedModel: 'gpt-5.4',
                                usedModel: 'gpt-5.4-mini',
                            },
                        ]);
                    }
                    expect(fallbackRequests()).toHaveLength(1);
                } else {
                    expect(outcome.ok).toBe(false);
                    expect(fallbackRequests()).toHaveLength(0);
                }
                // A synthetic status never forces a token refresh.
                expect(forcedRefreshes).toBe(0);
            },
        );
    });

    it('copy names the usage page for a usage limit and sign-in for an invalid user', async () => {
        serve(() => failedStream('subscription_sharing_usage_limit_exceeded'));
        expect((await failureOf(planSlot)).friendlyMessage).toContain(
            'chatgpt.com/settings/usage',
        );

        server.requests.length = 0;
        __planFetchInternals.clearPauses();
        serve(() => failedStream('subscription_sharing_invalid_user'));
        expect((await failureOf(planSlot)).friendlyMessage).toMatch(
            /sign in again/i,
        );
    });

    it('a signed-out organisation fails AUTH_INVALID without a plan request and the fallback serves', async () => {
        setChatGptPlanTokenProvider({
            getAccessToken: async () => {
                throw new ChatGptPlanTokenError('signed_out', 'not signed in');
            },
        });
        serve(() => completedStream('never reached'));

        expect((await failureOf(planSlot)).category).toBe(
            LlmErrorCategory.AUTH_INVALID,
        );
        await expect(runText(withFallback)).resolves.toBe('served by fallback');
        expect(planRequests()).toHaveLength(0);
        expect(fallbackRequests()).toHaveLength(1);
    });

    it('a real pre-stream 401 refreshes once and the review still runs on the plan', async () => {
        let first = true;
        serve(() => {
            if (first) {
                first = false;
                return new Response(JSON.stringify({ detail: 'expired' }), {
                    status: 401,
                });
            }
            return completedStream('after refresh');
        });
        await expect(runText(withFallback)).resolves.toBe('after refresh');
        expect(forcedRefreshes).toBe(1);
        expect(fallbackRequests()).toHaveLength(0);
    });

    it('after a usage limit, later calls skip the plan network call and use the fallback', async () => {
        serve(() => failedStream('subscription_sharing_usage_limit_exceeded'));
        await runText(withFallback);
        expect(planRequests()).toHaveLength(1);

        await runText(withFallback);
        expect(planRequests()).toHaveLength(1);
        expect(fallbackRequests()).toHaveLength(2);
    });

    it('uses the organisation stamped by LLM.run, ignoring a forged one on the slot', async () => {
        const seen: string[] = [];
        setChatGptPlanTokenProvider({
            getAccessToken: async (org) => {
                seen.push(org);
                return 'plan-token';
            },
        });
        serve(() => completedStream('ok'));
        await LLM.run({
            byokConfig: { ...planSlot, organizationId: 'org-forged' },
            user: 'u',
            runName: 'plan.test',
            organizationId: ORG,
        });
        expect(seen).toEqual([ORG]);
    });
});

describe('the plan inside an agent loop (LLM.run loop call)', () => {
    const runLoop = (slot: NormalizedModel) =>
        LLM.run({
            byokConfig: slot,
            system: 'sys',
            messages: [{ role: 'user', content: 'review' }],
            loop: { tools: {}, maxSteps: 2 },
            runName: 'plan.loop',
            organizationId: ORG,
        });

    it('a usage limit fails over before the first step, with a single plan request', async () => {
        serve(() => failedStream('subscription_sharing_usage_limit_exceeded'));
        const result = await runLoop(withFallback);
        expect(result.text).toBe('served by fallback');
        expect(planRequests()).toHaveLength(1);
        expect(fallbackRequests()).toHaveLength(1);
    });

    it('an unsupported request is not retried and does not fail over', async () => {
        serve(() =>
            failedStream('subscription_sharing_unsupported_capability'),
        );
        await expect(runLoop(withFallback)).rejects.toBeDefined();
        expect(planRequests()).toHaveLength(1);
        expect(fallbackRequests()).toHaveLength(0);
    });

    it('a 503 is retried by the SDK before the fallback serves', async () => {
        jest.useFakeTimers({
            doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
        });
        try {
            serve(() => failedStream('subscription_sharing_usage_unavailable'));
            const pending = runLoop(withFallback);
            await jest.advanceTimersByTimeAsync(60_000);
            const result = await pending;
            expect(result.text).toBe('served by fallback');
            // The first attempt plus the SDK's three retries.
            expect(planRequests()).toHaveLength(4);
            expect(fallbackRequests()).toHaveLength(1);
        } finally {
            jest.useRealTimers();
        }
    });
});
