import { APICallError, generateText, jsonSchema, tool } from 'ai';
import { chatgptPlanModule } from '.';
import {
    ChatGptPlanTokenError,
    setChatGptPlanTokenProvider,
    type ChatGptPlanTokenProvider,
} from './token-provider';
import { USAGE_PAUSE_MS, __planFetchInternals, planFetch } from './plan-fetch';
import {
    FakePlanServer,
    completedStream,
    emptyOutputStream,
    errorEventStream,
    failedStream,
    incompleteStream,
    jsonError,
    sse,
    truncatedStream,
} from '../../testing/fake-plan-server';

const ORG = 'org-1';

function tokens(
    impl?: Partial<ChatGptPlanTokenProvider>,
): jest.Mocked<ChatGptPlanTokenProvider> {
    const provider = {
        getAccessToken: jest.fn(
            async (_org: string, o: { forceRefresh: boolean }) =>
                o.forceRefresh ? 'tok-refreshed' : 'tok-1',
        ),
        ...impl,
    } as jest.Mocked<ChatGptPlanTokenProvider>;
    setChatGptPlanTokenProvider(provider);
    return provider;
}

/** `''` stands for "no organisation": an `undefined` argument would take the default. */
function model(server: FakePlanServer, organizationId: string = ORG) {
    return chatgptPlanModule.build(
        {
            provider: 'chatgpt_plan',
            model: 'gpt-5.4',
            apiKey: '',
            organizationId: organizationId || undefined,
        } as any,
        { fetch: server.fetch },
    );
}

const call = (
    m: ReturnType<typeof model>,
    extra: Record<string, unknown> = {},
) =>
    generateText({
        model: m,
        system: 'review the diff',
        messages: [{ role: 'user', content: 'hi' }],
        maxRetries: 0,
        ...extra,
    });

async function failure(promise: Promise<unknown>): Promise<APICallError> {
    const error = await promise.then(
        () => undefined,
        (e: unknown) => e,
    );
    expect(APICallError.isInstance(error)).toBe(true);
    return error as APICallError;
}

beforeEach(() => {
    __planFetchInternals.clearPauses();
    tokens();
});
afterEach(() => {
    setChatGptPlanTokenProvider(undefined);
    jest.restoreAllMocks();
});

describe('planFetch request shaping', () => {
    it('sends only allowlisted fields and forces store/stream', async () => {
        const server = new FakePlanServer().always(() => completedStream('ok'));
        await call(model(server), {
            temperature: 0.2,
            maxOutputTokens: 99,
            providerOptions: { openai: { user: 'u', metadata: { a: 'b' } } },
        });

        const { body, authorization, accept, url } = server.requests[0];
        expect(url).toBe('https://api.openai.com/v1/responses');
        expect(authorization).toBe('Bearer tok-1');
        expect(accept).toBe('text/event-stream');
        expect(body.store).toBe(false);
        expect(body.stream).toBe(true);
        expect(body.instructions).toBe('review the diff');
        expect(body.include).toEqual(['reasoning.encrypted_content']);
        for (const dropped of [
            'temperature',
            'max_output_tokens',
            'user',
            'metadata',
        ]) {
            expect(body).not.toHaveProperty(dropped);
        }
        expect(Object.keys(body).sort()).toEqual(
            [
                'include',
                'input',
                'instructions',
                'model',
                'store',
                'stream',
            ].sort(),
        );
    });

    it('concatenates every system and developer item into instructions, after any existing value', async () => {
        const server = new FakePlanServer().always(() => completedStream('ok'));
        await planFetch(server.fetch, ORG)(
            'https://api.openai.com/v1/responses',
            {
                method: 'POST',
                body: JSON.stringify({
                    model: 'gpt-5.4',
                    instructions: 'first',
                    input: [
                        { role: 'system', content: 'second' },
                        {
                            role: 'user',
                            content: [{ type: 'input_text', text: 'hi' }],
                        },
                        {
                            role: 'developer',
                            content: [{ type: 'input_text', text: 'third' }],
                        },
                    ],
                }),
            },
        );
        const { body } = server.requests[0];
        expect(body.instructions).toBe('first\n\nsecond\n\nthird');
        expect(body.input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
        ]);
    });

    it('keeps tools, tool_choice, text and reasoning on the allowlist', async () => {
        const server = new FakePlanServer().always(() => completedStream('ok'));
        await call(model(server), {
            tools: {
                lookup: tool({
                    description: 'look it up',
                    inputSchema: jsonSchema({ type: 'object', properties: {} }),
                }),
            },
            providerOptions: { openai: { reasoningEffort: 'low' } },
        });
        const { body } = server.requests[0];
        expect(body.tools[0]).toMatchObject({
            type: 'function',
            name: 'lookup',
        });
        expect(body.reasoning).toMatchObject({ effort: 'low' });
    });

    it('sends one empty user message when nothing but system prompts remain', async () => {
        const server = new FakePlanServer().always(() => completedStream('ok'));
        const fetchLike = planFetch(server.fetch, ORG);
        await fetchLike('https://api.openai.com/v1/responses', {
            method: 'POST',
            body: JSON.stringify({
                model: 'gpt-5.4',
                input: [{ role: 'system', content: 'only system' }],
            }),
        });
        expect(server.requests[0].body.input).toEqual([
            { role: 'user', content: [{ type: 'input_text', text: '' }] },
        ]);
        expect(server.requests[0].body.instructions).toBe('only system');
    });

    it('passes a streaming caller the raw event stream', async () => {
        const server = new FakePlanServer().always(() => completedStream('ok'));
        const res = await planFetch(server.fetch, ORG)(
            'https://api.openai.com/v1/responses',
            {
                method: 'POST',
                body: JSON.stringify({
                    model: 'gpt-5.4',
                    input: [],
                    stream: true,
                }),
            },
        );
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        expect(await res.text()).toContain('response.completed');
    });
});

describe('planFetch stream folding', () => {
    it('returns the completed response to a non-streaming caller', async () => {
        const server = new FakePlanServer().always(() =>
            completedStream('plan says hi'),
        );
        const result = await call(model(server));
        expect(result.text).toBe('plan says hi');
        expect(result.usage.inputTokens).toBe(11);
        expect(result.finishReason).toBe('stop');
    });

    it('rebuilds an empty output from response.output_item.done events, in order', async () => {
        const server = new FakePlanServer().always(() =>
            emptyOutputStream('rebuilt'),
        );
        expect((await call(model(server))).text).toBe('rebuilt');
    });

    it('passes response.incomplete through so the SDK maps the finish reason', async () => {
        const server = new FakePlanServer().always(() =>
            incompleteStream('cut off'),
        );
        const result = await call(model(server));
        expect(result.text).toBe('cut off');
        expect(result.finishReason).toBe('length');
    });

    it('rebuilds an empty incomplete output so partial text survives', async () => {
        const server = new FakePlanServer().always(() =>
            incompleteStream('partial', { emptyOutput: true }),
        );
        const result = await call(model(server));
        expect(result.text).toBe('partial');
        expect(result.finishReason).toBe('length');
    });

    it('answers a stream that ends with no terminal event as a retry-worthy 502', async () => {
        const server = new FakePlanServer().always(() => truncatedStream());
        const error = await failure(call(model(server)));
        expect(error.statusCode).toBe(502);
        expect(error.isRetryable).toBe(true);
        expect(error.responseHeaders?.['x-request-id']).toBe('req_trunc');
    });

    it('copes with CRLF framing and events split across chunks', async () => {
        const server = new FakePlanServer().always(() => {
            const full = completedStream('chunked');
            return full.text().then((text) => {
                const crlf = text.replace(/\n/g, '\r\n');
                const encoder = new TextEncoder();
                const bytes = encoder.encode(crlf);
                return new Response(
                    new ReadableStream({
                        start(controller) {
                            for (let i = 0; i < bytes.length; i += 7) {
                                controller.enqueue(bytes.slice(i, i + 7));
                            }
                            controller.close();
                        },
                    }),
                    {
                        status: 200,
                        headers: { 'content-type': 'text/event-stream' },
                    },
                );
            });
        });
        expect((await call(model(server))).text).toBe('chunked');
    });

    it('keeps an abort an abort', async () => {
        const controller = new AbortController();
        const server = new FakePlanServer().always(
            () =>
                new Response(
                    new ReadableStream({
                        start() {
                            controller.abort();
                        },
                        pull() {
                            throw new DOMException('aborted', 'AbortError');
                        },
                    }),
                    { status: 200 },
                ),
        );
        await expect(
            call(model(server), { abortSignal: controller.signal }),
        ).rejects.toBeDefined();
    });
});

describe('planFetch error mapping', () => {
    it.each([
        ['subscription_sharing_usage_limit_exceeded', 402],
        ['subscription_sharing_invalid_user', 401],
        ['subscription_sharing_user_not_eligible', 401],
        ['chatpass_v2_account_blocked', 401],
        ['subscription_sharing_usage_unavailable', 503],
        ['subscription_sharing_user_unavailable', 503],
        ['subscription_sharing_unsupported_capability', 400],
        ['subscription_sharing_route_not_supported', 400],
        ['context_length_exceeded', 400],
        ['rate_limit_exceeded', 429],
        ['something_new', 502],
    ])('a failed stream with %s becomes HTTP %i', async (code, status) => {
        const server = new FakePlanServer().always(() =>
            failedStream(code, 'upstream words'),
        );
        const error = await failure(call(model(server)));
        expect(error.statusCode).toBe(status);
        expect(error.responseBody).toContain(code);
        expect(error.responseHeaders?.['x-request-id']).toBe('req_failed');
    });

    it('maps an error event the same way as response.failed', async () => {
        const server = new FakePlanServer().always(() =>
            errorEventStream('subscription_sharing_usage_limit_exceeded'),
        );
        const error = await failure(call(model(server)));
        expect(error.statusCode).toBe(402);
        expect(error.responseHeaders?.['x-request-id']).toBe('req_err');
    });

    it('maps a coded pre-stream error through the same table', async () => {
        const server = new FakePlanServer().always(() =>
            jsonError(
                403,
                {
                    error: {
                        code: 'subscription_sharing_user_not_eligible',
                        message: 'no',
                    },
                },
                { 'x-request-id': 'req_pre' },
            ),
        );
        const error = await failure(call(model(server)));
        expect(error.statusCode).toBe(401);
        expect(error.responseHeaders?.['x-request-id']).toBe('req_pre');
    });

    it('passes a code-less pre-stream error through with its real status', async () => {
        const server = new FakePlanServer().always(() =>
            jsonError(
                400,
                { detail: 'Stream must be set to true' },
                { 'x-request-id': 'req_d' },
            ),
        );
        const error = await failure(call(model(server)));
        expect(error.statusCode).toBe(400);
        expect(JSON.parse(error.responseBody!)).toEqual({
            error: { message: 'Stream must be set to true' },
        });
        expect(error.responseHeaders?.['x-request-id']).toBe('req_d');
    });

    it('appends the upstream sentence to an unsupported-request 400 only', async () => {
        const server = new FakePlanServer().always(() =>
            failedStream(
                'subscription_sharing_unsupported_capability',
                'tools are not allowed',
            ),
        );
        const error = await failure(call(model(server)));
        expect(JSON.parse(error.responseBody!).error.message).toContain(
            'tools are not allowed',
        );
    });
});

describe('planFetch authentication', () => {
    it('forces one refresh and retries on a real pre-stream 401 with no code', async () => {
        const provider = tokens();
        const server = new FakePlanServer().enqueue(
            () => jsonError(401, { detail: 'token expired' }),
            () => completedStream('after refresh'),
        );
        const result = await call(model(server));
        expect(result.text).toBe('after refresh');
        expect(server.requests.map((r) => r.authorization)).toEqual([
            'Bearer tok-1',
            'Bearer tok-refreshed',
        ]);
        expect(provider.getAccessToken.mock.calls.map((c) => c[1])).toEqual([
            { forceRefresh: false },
            { forceRefresh: true },
        ]);
    });

    it('refreshes on a real 401 coded invalid_user, but only once', async () => {
        const provider = tokens();
        const server = new FakePlanServer().always(() =>
            jsonError(401, {
                error: {
                    code: 'subscription_sharing_invalid_user',
                    message: 'x',
                },
            }),
        );
        const error = await failure(call(model(server)));
        expect(error.statusCode).toBe(401);
        expect(server.requests).toHaveLength(2);
        expect(provider.getAccessToken).toHaveBeenCalledTimes(2);
    });

    it('does not refresh on a 403-origin code', async () => {
        const provider = tokens();
        const server = new FakePlanServer().always(() =>
            jsonError(403, {
                error: {
                    code: 'subscription_sharing_user_not_eligible',
                    message: 'x',
                },
            }),
        );
        await failure(call(model(server)));
        expect(server.requests).toHaveLength(1);
        expect(provider.getAccessToken).toHaveBeenCalledTimes(1);
    });

    it('does not refresh on a synthetic 401 from a failed stream', async () => {
        const provider = tokens();
        const server = new FakePlanServer().always(() =>
            failedStream('subscription_sharing_invalid_user'),
        );
        const error = await failure(call(model(server)));
        expect(error.statusCode).toBe(401);
        expect(server.requests).toHaveLength(1);
        expect(provider.getAccessToken).toHaveBeenCalledTimes(1);
        expect(provider.getAccessToken).toHaveBeenCalledWith(ORG, {
            forceRefresh: false,
        });
    });

    it('fetches a token for every request, not once per model', async () => {
        const provider = tokens();
        const server = new FakePlanServer().always(() => completedStream('ok'));
        const m = model(server);
        await call(m);
        await call(m);
        expect(provider.getAccessToken).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['signed_out', 401],
        ['not_eligible', 401],
        ['unavailable', 503],
    ] as const)(
        'a %s token error answers HTTP %i without a network call',
        async (code, status) => {
            tokens({
                getAccessToken: async () => {
                    throw new ChatGptPlanTokenError(code, 'secret detail');
                },
            });
            const server = new FakePlanServer();
            const error = await failure(call(model(server)));
            expect(error.statusCode).toBe(status);
            expect(server.requests).toHaveLength(0);
            expect(error.responseBody).not.toContain('secret detail');
        },
    );

    it('answers a 400 not-configured error when the organisation is missing', async () => {
        const server = new FakePlanServer();
        const error = await failure(call(model(server, '')));
        expect(error.statusCode).toBe(400);
        expect(server.requests).toHaveLength(0);
    });

    it('answers a 400 not-configured error when no token provider is bound', async () => {
        setChatGptPlanTokenProvider(undefined);
        const server = new FakePlanServer();
        const error = await failure(call(model(server)));
        expect(error.statusCode).toBe(400);
        expect(server.requests).toHaveLength(0);
    });

    it('builds without resolving a token or an organisation', () => {
        const provider = tokens();
        expect(() => model(new FakePlanServer(), undefined)).not.toThrow();
        expect(provider.getAccessToken).not.toHaveBeenCalled();
    });
});

describe('planFetch usage-limit pause', () => {
    it('serves a synthetic 402 without a network call for five minutes, per organisation', async () => {
        let now = 1_000_000;
        jest.spyOn(Date, 'now').mockImplementation(() => now);
        const server = new FakePlanServer().enqueue(
            () =>
                failedStream(
                    'subscription_sharing_usage_limit_exceeded',
                    'limit',
                    'req_limit',
                ),
            () => completedStream('later'),
        );
        const m = model(server);

        expect((await failure(call(m))).statusCode).toBe(402);
        expect(server.requests).toHaveLength(1);

        now += USAGE_PAUSE_MS - 1;
        const paused = await failure(call(m));
        expect(paused.statusCode).toBe(402);
        expect(paused.responseHeaders?.['x-request-id']).toBe('req_limit');
        expect(server.requests).toHaveLength(1);

        // Another organisation is unaffected.
        const other = new FakePlanServer().always(() =>
            completedStream('other org'),
        );
        expect((await call(model(other, 'org-2'))).text).toBe('other org');

        now += 2;
        expect((await call(m)).text).toBe('later');
        expect(server.requests).toHaveLength(2);
    });

    it('also pauses on a coded pre-stream usage-limit error', async () => {
        const server = new FakePlanServer().always(() =>
            jsonError(429, {
                error: {
                    code: 'subscription_sharing_usage_limit_exceeded',
                    message: 'x',
                },
            }),
        );
        const m = model(server);
        expect((await failure(call(m))).statusCode).toBe(402);
        expect((await failure(call(m))).statusCode).toBe(402);
        expect(server.requests).toHaveLength(1);
    });

    it('does not pause on other errors', async () => {
        const server = new FakePlanServer().always(() =>
            failedStream('subscription_sharing_usage_unavailable'),
        );
        const m = model(server);
        await failure(call(m));
        await failure(call(m));
        expect(server.requests).toHaveLength(2);
    });
});

describe('sse helper', () => {
    it('frames events as the route does', async () => {
        const text = await sse([{ type: 'x' }]).text();
        expect(text).toBe('event: x\ndata: {"type":"x"}\n\n');
    });
});
