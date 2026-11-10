/**
 * Test double for OpenAI's ChatGPT plan route: a `fetch` that answers
 * `/v1/responses` with a scripted Server-Sent Events stream (or a pre-stream
 * error) and records every request. A real fake, not a mock: the adapter under
 * test talks to it exactly as it would to the network.
 */

export interface RecordedRequest {
    url: string;
    authorization: string | null;
    accept: string | null;
    body: Record<string, any>;
}

export type FakeHandler = (
    request: RecordedRequest,
) => Response | Promise<Response>;

export interface SseEvent {
    type: string;
    [key: string]: unknown;
}

export function sse(
    events: SseEvent[],
    opts: { requestId?: string } = {},
): Response {
    const body = events
        .map(
            (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join('');
    return new Response(body, {
        status: 200,
        headers: {
            'content-type': 'text/event-stream',
            ...(opts.requestId ? { 'x-request-id': opts.requestId } : {}),
        },
    });
}

export function jsonError(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

const USAGE = {
    input_tokens: 11,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 7,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 18,
};

export function messageItem(text: string): Record<string, unknown> {
    return {
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
    };
}

export function responseObject(
    output: unknown[],
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        id: 'resp_1',
        object: 'response',
        created_at: 1_700_000_000,
        status: 'completed',
        model: 'gpt-5.4',
        output,
        usage: USAGE,
        incomplete_details: null,
        error: null,
        ...overrides,
    };
}

/** What the public API answers a non-streaming `/v1/responses` call with: the
 *  org's API-key fallback model is reached this way, not through the plan. */
export function apiJsonResponse(text: string): Response {
    return new Response(JSON.stringify(responseObject([messageItem(text)])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

/** A well-formed stream ending in `response.completed` with its output filled in. */
export function completedStream(text: string, requestId = 'req_ok'): Response {
    const item = messageItem(text);
    return sse(
        [
            {
                type: 'response.created',
                response: responseObject([], { status: 'in_progress' }),
            },
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: responseObject([item]) },
        ],
        { requestId },
    );
}

/** The shape the route has been seen to produce: output items stream, but the
 *  terminal event's `response.output` is empty. */
export function emptyOutputStream(
    text: string,
    requestId = 'req_empty',
): Response {
    const item = messageItem(text);
    return sse(
        [
            { type: 'response.output_item.done', output_index: 0, item },
            { type: 'response.completed', response: responseObject([]) },
        ],
        { requestId },
    );
}

export function incompleteStream(text: string): Response {
    const item = messageItem(text);
    return sse([
        { type: 'response.output_item.done', output_index: 0, item },
        {
            type: 'response.incomplete',
            response: responseObject([item], {
                status: 'incomplete',
                incomplete_details: { reason: 'max_output_tokens' },
            }),
        },
    ]);
}

export function failedStream(
    code: string,
    message = 'failed',
    requestId = 'req_failed',
): Response {
    return sse(
        [
            {
                type: 'response.created',
                response: responseObject([], { status: 'in_progress' }),
            },
            {
                type: 'response.failed',
                response: responseObject([], {
                    status: 'failed',
                    error: { code, message },
                }),
            },
        ],
        { requestId },
    );
}

export function errorEventStream(
    code: string,
    message = 'errored',
    requestId = 'req_err',
): Response {
    return sse([{ type: 'error', code, message }], { requestId });
}

export function truncatedStream(requestId = 'req_trunc'): Response {
    return sse(
        [
            {
                type: 'response.created',
                response: responseObject([], { status: 'in_progress' }),
            },
        ],
        { requestId },
    );
}

export class FakePlanServer {
    readonly requests: RecordedRequest[] = [];
    private readonly queue: FakeHandler[] = [];
    private fallbackHandler: FakeHandler = () =>
        jsonError(500, { error: { message: 'no scripted response' } });

    /** Answer the next request (FIFO). */
    enqueue(...handlers: FakeHandler[]): this {
        this.queue.push(...handlers);
        return this;
    }

    /** Answer every request the queue has not claimed. */
    always(handler: FakeHandler): this {
        this.fallbackHandler = handler;
        return this;
    }

    readonly fetch: typeof fetch = async (input, init) => {
        const headers = new Headers(init?.headers);
        const request: RecordedRequest = {
            url: String(input),
            authorization: headers.get('authorization'),
            accept: headers.get('accept'),
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : {},
        };
        this.requests.push(request);
        return (this.queue.shift() ?? this.fallbackHandler)(request);
    };
}
