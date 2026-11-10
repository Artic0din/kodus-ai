/**
 * `planFetch`: the transport adapter between the AI SDK's Responses client and
 * OpenAI's ChatGPT plan route. All route rules live here and nowhere else.
 *
 * The route differs from the public API in four ways this adapter hides:
 *   - it only answers as a stream (`400 Stream must be set to true` otherwise),
 *     while every Kodus path calls `generateText`; the stream is folded back
 *     into the single JSON response the SDK expects;
 *   - it wants the system prompt in `instructions`, `store: false`, and takes a
 *     fixed set of body fields;
 *   - it authenticates with a short-lived bearer fetched per request from the
 *     token provider port (an agent loop outlives one token);
 *   - it reports failures in its own codes, mapped to synthetic HTTP statuses so
 *     the existing classifier and failover treat them like any provider's
 *     (route-errors.ts holds the table).
 *
 * Known unverified assumption (the live gate was skipped by the owner): the
 * route accepts `reasoning`, `include` and top-level function tools as sent. If
 * it refuses one, the symptom is `subscription_sharing_unsupported_capability`
 * (a 400, never failed over) and the fix belongs here.
 */
import {
    ChatGptPlanTokenError,
    getChatGptPlanTokenProvider,
} from './token-provider';
import {
    INVALID_USER_CODE,
    NOT_CONFIGURED_CODE,
    SIGNED_OUT_CODE,
    TOKEN_UNAVAILABLE_CODE,
    TRUNCATED_STREAM_CODE,
    USAGE_LIMIT_CODE,
    planRouteErrorFor,
    unknownStreamFailure,
    type PlanRouteError,
} from './route-errors';

const ALLOWED_BODY_KEYS = [
    'model',
    'input',
    'instructions',
    'tools',
    'tool_choice',
    'parallel_tool_calls',
    'text',
    'reasoning',
    'include',
] as const;

/** No reset time is inferred from the route; a fixed window avoids hammering a
 *  spent plan while the fallback model serves. */
export const USAGE_PAUSE_MS = 5 * 60_000;

/** Per organisation, in this process. Cleared by expiry only. */
const pausedUntil = new Map<string, { until: number; requestId?: string }>();

export const __planFetchInternals = {
    clearPauses: () => pausedUntil.clear(),
};

type Json = Record<string, any>;

function syntheticError(
    route: PlanRouteError,
    requestId?: string,
    detail?: string,
): Response {
    const message = detail ? `${route.message} (${detail})` : route.message;
    return new Response(
        JSON.stringify({ error: { message, code: route.code } }),
        {
            status: route.status,
            headers: {
                'content-type': 'application/json',
                ...(requestId ? { 'x-request-id': requestId } : {}),
            },
        },
    );
}

function pauseOnUsageLimit(
    organizationId: string,
    route: PlanRouteError,
    requestId?: string,
): void {
    if (route.code === USAGE_LIMIT_CODE) {
        pausedUntil.set(organizationId, {
            until: Date.now() + USAGE_PAUSE_MS,
            requestId,
        });
    }
}

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('');
}

function buildBody(raw: Json): Json {
    const body: Json = {};
    for (const key of ALLOWED_BODY_KEYS) {
        if (raw[key] !== undefined) body[key] = raw[key];
    }

    // The SDK emits `developer` for reasoning models and `system` for the rest;
    // the route wants both as `instructions`.
    const instructions: string[] = [];
    if (typeof body.instructions === 'string' && body.instructions) {
        instructions.push(body.instructions);
    }
    const input: unknown[] = [];
    for (const item of Array.isArray(body.input) ? body.input : []) {
        if (item?.role === 'system' || item?.role === 'developer') {
            const text = textOf(item.content);
            if (text) instructions.push(text);
        } else {
            input.push(item);
        }
    }
    if (instructions.length > 0) body.instructions = instructions.join('\n\n');
    body.input =
        input.length > 0
            ? input
            : [
                  {
                      role: 'user',
                      content: [{ type: 'input_text', text: '' }],
                  },
              ];
    body.store = false;
    body.stream = true;
    return body;
}

interface RouteFailure {
    status: number;
    code?: string;
    message?: string;
    requestId?: string;
}

async function readFailure(res: Response): Promise<RouteFailure> {
    const requestId = res.headers.get('x-request-id') ?? undefined;
    let parsed: Json | undefined;
    try {
        parsed = JSON.parse(await res.text());
    } catch {
        parsed = undefined;
    }
    const error = parsed?.error;
    const detail = parsed?.detail;
    const code: unknown =
        error?.code ?? parsed?.code ?? (detail && detail.code);
    const message: unknown =
        error?.message ??
        parsed?.message ??
        (typeof detail === 'string' ? detail : detail?.message);
    return {
        status: res.status,
        code: typeof code === 'string' ? code : undefined,
        message: typeof message === 'string' ? message : undefined,
        requestId,
    };
}

function failureResponse(
    failure: RouteFailure,
    organizationId: string,
): Response {
    const route = planRouteErrorFor(failure.code);
    if (route) {
        pauseOnUsageLimit(organizationId, route, failure.requestId);
        return syntheticError(
            route,
            failure.requestId,
            route.status === 400 ? failure.message : undefined,
        );
    }
    // No code Kodus knows (a `{"detail": "..."}` body, say): the real status
    // passes through unchanged.
    return new Response(
        JSON.stringify({
            error: {
                message: failure.message ?? `HTTP ${failure.status}`,
                ...(failure.code ? { code: failure.code } : {}),
            },
        }),
        {
            status: failure.status,
            headers: {
                'content-type': 'application/json',
                ...(failure.requestId
                    ? { 'x-request-id': failure.requestId }
                    : {}),
            },
        },
    );
}

function tokenFailureResponse(err: ChatGptPlanTokenError): Response {
    if (err.code === 'not_eligible') {
        return syntheticError(
            planRouteErrorFor('subscription_sharing_user_not_eligible')!,
        );
    }
    if (err.code === 'unavailable') {
        return syntheticError(planRouteErrorFor(TOKEN_UNAVAILABLE_CODE)!);
    }
    return syntheticError(planRouteErrorFor(SIGNED_OUT_CODE)!);
}

/** Yields each `data:` payload of an SSE body as parsed JSON. */
async function* sseEvents(res: Response): AsyncGenerator<Json> {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer = (buffer + decoder.decode(value, { stream: true })).replace(
                /\r\n/g,
                '\n',
            );
            let boundary = buffer.indexOf('\n\n');
            while (boundary !== -1) {
                const block = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const data = block
                    .split('\n')
                    .filter((line) => line.startsWith('data:'))
                    .map((line) => line.slice(5).trimStart())
                    .join('\n');
                if (data && data !== '[DONE]') {
                    try {
                        yield JSON.parse(data) as Json;
                    } catch {
                        // A malformed event is skipped; the terminal event decides.
                    }
                }
                boundary = buffer.indexOf('\n\n');
            }
        }
    } finally {
        reader.cancel().catch(() => undefined);
    }
}

function jsonResponse(response: Json, requestId?: string): Response {
    return new Response(JSON.stringify(response), {
        status: 200,
        headers: {
            'content-type': 'application/json',
            ...(requestId ? { 'x-request-id': requestId } : {}),
        },
    });
}

/** Fold the route's SSE stream into the single response a `generateText` call
 *  expects, or the synthetic error for a failed or truncated stream. */
async function foldStream(
    res: Response,
    organizationId: string,
    signal: AbortSignal | null | undefined,
): Promise<Response> {
    const requestId = res.headers.get('x-request-id') ?? undefined;
    const items: unknown[] = [];
    const fail = (code?: string, message?: string): Response => {
        const route =
            planRouteErrorFor(code) ?? unknownStreamFailure(code, message);
        pauseOnUsageLimit(organizationId, route, requestId);
        return syntheticError(
            route,
            requestId,
            route.status === 400 ? message : undefined,
        );
    };

    try {
        for await (const event of sseEvents(res)) {
            switch (event.type) {
                case 'response.output_item.done':
                    if (event.item) items.push(event.item);
                    break;
                case 'response.completed':
                case 'response.incomplete': {
                    const response: Json = event.response ?? {};
                    if (
                        !Array.isArray(response.output) ||
                        !response.output.length
                    ) {
                        response.output = items;
                    }
                    return jsonResponse(response, requestId);
                }
                case 'response.failed':
                    return fail(
                        event.response?.error?.code,
                        event.response?.error?.message,
                    );
                case 'error':
                    return fail(
                        event.code ?? event.error?.code,
                        event.message ?? event.error?.message,
                    );
            }
        }
    } catch (err) {
        // A caller's abort must stay an abort; any other read failure is a
        // dropped connection.
        if (signal?.aborted) throw err;
    }
    return syntheticError(planRouteErrorFor(TRUNCATED_STREAM_CODE)!, requestId);
}

/**
 * Wrap a fetch so Responses calls reach the ChatGPT plan route. `baseFetch`
 * defaults to the global one (looked up per call, so a test can replace it) and
 * is wrapped, never replaced, so the probe's no-redirect transport still applies.
 */
export function planFetch(
    baseFetch: typeof fetch | undefined,
    organizationId: string | undefined,
): typeof fetch {
    const send: typeof fetch = (input, init) =>
        (baseFetch ?? globalThis.fetch)(input, init);

    return async (input, init) => {
        const tokens = getChatGptPlanTokenProvider();
        if (!organizationId || !tokens) {
            return syntheticError(planRouteErrorFor(NOT_CONFIGURED_CODE)!);
        }
        const paused = pausedUntil.get(organizationId);
        if (paused) {
            if (paused.until > Date.now()) {
                return syntheticError(
                    planRouteErrorFor(USAGE_LIMIT_CODE)!,
                    paused.requestId,
                );
            }
            pausedUntil.delete(organizationId);
        }

        let original: Json | undefined;
        if (typeof init?.body === 'string') {
            try {
                original = JSON.parse(init.body) as Json;
            } catch {
                original = undefined;
            }
        }
        const body = original
            ? JSON.stringify(buildBody(original))
            : init?.body;

        const call = (token: string): Promise<Response> => {
            const headers = new Headers(init?.headers);
            headers.set('Authorization', `Bearer ${token}`);
            headers.set('Accept', 'text/event-stream');
            return send(input, { ...init, headers, body });
        };

        let res: Response;
        try {
            res = await call(
                await tokens.getAccessToken(organizationId, {
                    forceRefresh: false,
                }),
            );
        } catch (err) {
            if (err instanceof ChatGptPlanTokenError) {
                return tokenFailureResponse(err);
            }
            throw err;
        }

        if (res.status === 401) {
            const failure = await readFailure(res);
            // Only a real pre-stream 401 with no code (or the invalid-user
            // code) is a stale bearer worth one forced refresh.
            if (!failure.code || failure.code === INVALID_USER_CODE) {
                try {
                    res = await call(
                        await tokens.getAccessToken(organizationId, {
                            forceRefresh: true,
                        }),
                    );
                } catch (err) {
                    if (err instanceof ChatGptPlanTokenError) {
                        return tokenFailureResponse(err);
                    }
                    throw err;
                }
            } else {
                return failureResponse(failure, organizationId);
            }
        }

        if (!res.ok) {
            return failureResponse(await readFailure(res), organizationId);
        }
        return original?.stream === true
            ? res
            : foldStream(res, organizationId, init?.signal);
    };
}
