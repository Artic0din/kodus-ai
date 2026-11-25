import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { LLM } from '@libs/llm/llm';
import {
    prompt_replyAddressedToKody_system,
    prompt_replyAddressedToKody_user,
    replyAddressedToKodySchema,
    ReplyThreadMessage,
} from '@libs/common/utils/prompts/replyAddressedToKody';
import { isKodyPromptReply } from '@libs/common/utils/codeManagement/bitbucket-suggestion-comment';

/**
 * A reply without @kody in a thread Kody started (#1946). The code gate below
 * runs first and costs nothing; the classifier is one `LLM.run` call on the
 * org's conversation model and runs only when the gate passes.
 */

/**
 * Consecutive Kody replies to bots, with no human in between, after which Kody
 * stops answering unmentioned bot replies in that thread. Two agents that both
 * answer whoever talks to them would otherwise loop on the org's tokens.
 */
export const IMPLICIT_REPLY_BOT_CAP = 5;

/**
 * Kody answers in one thread after which unmentioned replies need @kody,
 * whoever wrote them. Bot detection is partial outside GitHub (Azure exposes
 * no author type), so this bounds a loop with an agent that looks human.
 */
export const IMPLICIT_REPLY_THREAD_CAP = 10;

/** Why an unmentioned reply got no answer. Logged on every silent exit. */
export type ImplicitReplySilence =
    | 'not_kody_thread'
    | 'kody_author'
    | 'resolved_thread'
    | 'terminal_closure'
    | 'bot_cap'
    | 'thread_cap'
    | 'plan_blocked'
    | 'classified_no'
    | 'classifier_error';

export interface ImplicitReplyGateOptions {
    threadResolved?: boolean;
}

export interface ThreadMessage extends ReplyThreadMessage {
    id: string | number;
}

const BOT_LOGIN_PATTERN = /\[bot\]$|(^|[_-])bot([_-]|$)/i;
const MAX_CLOSURE_SCAN_CHARS = 8_000;
const BARE_URL_PATTERN = /https?:\/\/[^\s)>\]]+/g;
const RESPONSE_REQUEST_PATTERN =
    /\b(?:please\s+(?:re-?check|check|verify|confirm|review|explain|clarify)|re-?check\s+(?:this|the|again)|re-?review|re-?evaluate|verify\s+(?:this|the)|confirm\s+(?:this|the)|explain|clarify|elaborate|show\s+me|tell\s+me|suggest|help\s+me|can\s+you|could\s+you|would\s+you|do\s+you\s+agree|why\s+(?:would|does|did|is|are)|thoughts|wdyt|ptal|take\s+(?:a|another)\s+look|let\s+me\s+know|still\s+(?:red|fails?|failing|broken|flaky|unresolved|happening|occurs?|occurring|leaks?|leaking|see|seeing|hit|hitting|getting|throws?|throwing|crashes?|crashing)|(?:fails?|failing|broken|red)\s+again|ci\s+is\s+(?:red|failing|broken)|doesn['’]t\s+work|does\s+not\s+work|didn['’]t\s+fix|not\s+working|how\s+should|should\s+we|what\s+about)\b|(?:^|[.!\n][ \t]*(?:[-*+][ \t]+)?)[*_~]*(?:check|verify|confirm|review|look\s+at)(?![A-Za-z0-9])/i;
const TERMINAL_CLOSURE_PATTERN =
    /^(?:(?:declining|declined|won['’]t\s+fix|wontfix|not\s+fixing|not\s+changing|skipping|leaving\s+as[- ]is|by\s+design|intentional|working\s+as\s+intended|out\s+of\s+scope|no\s+changes?\s+needed|closing\s+as|resolving\s+as)(?:\b|[:.,!—–-]|$)|(?:(?:good\s+catch[.,!]?\s+)?(?:fixed|addressed|resolved|done|applied|updated|removed|reverted|switched|changed|tightened|added|implemented)(?:\s+(?:in|by|with|on|via)\b|[:.,!—–-]|$))|(?:(?:thanks|thank\s+you|ty|thx|makes\s+sense|lgtm|good\s+catch|noted|acknowledged|got\s+it)[.,!]?$))/i;

function isEscaped(text: string, index: number): boolean {
    let slashes = 0;
    for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
        slashes++;
    }
    return slashes % 2 === 1;
}

function isAtLineStart(text: string, index: number): boolean {
    let i = index - 1;
    let spaces = 0;
    while (i >= 0 && text[i] === ' ') {
        spaces++;
        i--;
    }
    return spaces <= 3 && (i < 0 || text[i] === '\n');
}

function isOpeningFenceLine(
    text: string,
    index: number,
    ticks: number,
): boolean {
    for (let i = index + ticks; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\n' || ch === '\r') return true;
        if (ch === '`') return false;
    }
    return true;
}

function isClosingFenceLine(
    text: string,
    index: number,
    ticks: number,
): boolean {
    let i = index + ticks;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
        i++;
    }
    return i >= text.length || text[i] === '\n' || text[i] === '\r';
}

/**
 * Strictly O(n) pass over a bounded prefix that removes HTML comments outside
 * backtick spans and optionally replaces backtick code spans with spaces.
 * Pre-indexes backtick runs in one pass so delimiter matching never rescans
 * suffixes. Follows CommonMark: only line-start fences (`>= 3` ticks) cross
 * blank lines and close on any line-start fence of `>= ticks`, and a backslash
 * escapes only the single opening backtick in prose.
 */
function scanMarkdownText(raw: string, stripCodeSpans: boolean): string {
    const text = raw.slice(0, MAX_CLOSURE_SCAN_CHARS);
    const len = text.length;

    const runsByLen = new Map<number, Array<{ pos: number; para: number }>>();
    const closingFences: Array<{ pos: number; ticks: number }> = [];
    const allRuns: Array<{
        pos: number;
        ticks: number;
        para: number;
        escaped: boolean;
        atLineStart: boolean;
    }> = [];
    const pushBucket = (
        ticks: number,
        entry: { pos: number; para: number },
    ) => {
        let bucket = runsByLen.get(ticks);
        if (!bucket) {
            bucket = [];
            runsByLen.set(ticks, bucket);
        }
        bucket.push(entry);
    };

    let para = 0;
    for (let i = 0; i < len; ) {
        if (text[i] === '\n') {
            let j = i + 1;
            while (
                j < len &&
                (text[j] === ' ' || text[j] === '\t' || text[j] === '\r')
            ) {
                j++;
            }
            if (j < len && text[j] === '\n') {
                para++;
                i = j;
                continue;
            }
            i++;
            continue;
        }
        if (text[i] === '`') {
            const escaped = isEscaped(text, i);
            const atLineStart = isAtLineStart(text, i);
            let ticks = 1;
            while (i + ticks < len && text[i + ticks] === '`') {
                ticks++;
            }
            pushBucket(ticks, { pos: i, para });
            if (
                !escaped &&
                atLineStart &&
                ticks >= 3 &&
                isClosingFenceLine(text, i, ticks)
            ) {
                closingFences.push({ pos: i, ticks });
            }
            allRuns.push({ pos: i, ticks, para, escaped, atLineStart });
            if (escaped && ticks > 1) {
                allRuns.push({
                    pos: i + 1,
                    ticks: ticks - 1,
                    para,
                    escaped: false,
                    atLineStart: false,
                });
            }
            i += ticks;
            continue;
        }
        i++;
    }

    const bucketPtr = new Map<number, number>();
    let fenceIdx = 0;
    let runIdx = 0;
    let nextComment = text.indexOf('<!--');
    let out = '';
    let cursor = 0;

    while (cursor < len) {
        if (nextComment >= 0 && nextComment < cursor) {
            nextComment = text.indexOf('<!--', cursor);
        }
        while (runIdx < allRuns.length && allRuns[runIdx].pos < cursor) {
            runIdx++;
        }
        const nextRun = runIdx < allRuns.length ? allRuns[runIdx] : undefined;

        if (cursor === nextComment) {
            const close = text.indexOf('-->', cursor + 4);
            if (close < 0) {
                break;
            }
            cursor = close + 3;
            continue;
        }

        if (nextRun && cursor === nextRun.pos) {
            const { ticks, para: openPara, escaped, atLineStart } = nextRun;
            if (escaped) {
                out += text[cursor];
                cursor += 1;
                continue;
            }
            if (
                ticks >= 3 &&
                atLineStart &&
                isOpeningFenceLine(text, cursor, ticks)
            ) {
                while (
                    fenceIdx < closingFences.length &&
                    closingFences[fenceIdx].pos <= cursor
                ) {
                    fenceIdx++;
                }
                let matchIdx = fenceIdx;
                while (
                    matchIdx < closingFences.length &&
                    closingFences[matchIdx].ticks < ticks
                ) {
                    matchIdx++;
                }
                if (matchIdx < closingFences.length) {
                    const closer = closingFences[matchIdx];
                    fenceIdx = matchIdx + 1;
                    out += stripCodeSpans
                        ? ' '
                        : text.slice(cursor, closer.pos + closer.ticks);
                    cursor = closer.pos + closer.ticks;
                    continue;
                }
            }
            const bucket = runsByLen.get(ticks);
            if (bucket) {
                let ptr = bucketPtr.get(ticks) ?? 0;
                while (ptr < bucket.length && bucket[ptr].pos <= cursor) {
                    ptr++;
                }
                bucketPtr.set(ticks, ptr);
                const closer = bucket[ptr];
                if (closer && closer.para === openPara) {
                    bucketPtr.set(ticks, ptr + 1);
                    out += stripCodeSpans
                        ? ' '
                        : text.slice(cursor, closer.pos + ticks);
                    cursor = closer.pos + ticks;
                    continue;
                }
            }
            out += text.slice(cursor, cursor + ticks);
            cursor += ticks;
            continue;
        }

        let next = len;
        if (nextRun && nextRun.pos < next) next = nextRun.pos;
        if (nextComment >= 0 && nextComment < next) next = nextComment;
        out += text.slice(cursor, next);
        cursor = next;
    }

    return out;
}

/**
 * Leading markdown quote blocks (such as GitHub `> [!NOTE]` banners) and
 * formatting prefixes are stripped so the first real sentence is inspected.
 */
function stripLeadingQuoteBanners(cleaned: string): string {
    const lines = cleaned.split(/\r?\n/);
    let index = 0;
    while (index < lines.length) {
        const trimmed = lines[index].trim();
        if (!trimmed || trimmed.startsWith('>')) {
            index++;
            continue;
        }
        break;
    }
    const rest = (index < lines.length ? lines.slice(index) : lines)
        .join('\n')
        .trim();
    return rest.replace(/^[\s>*_~-]+/, '').trim();
}

/**
 * True when an unmentioned reply is a one-way closure or status note
 * ("Fixed in abc123", "Declining: ...", "Not changing this.", "Thanks.") that
 * does not ask a question or request a re-check.
 */
export function isTerminalClosureNote(body: string): boolean {
    const raw = body ?? '';
    // Long replies fail open to the classifier so tail questions are never truncated.
    if (raw.length > MAX_CLOSURE_SCAN_CHARS) {
        return false;
    }
    const lead = stripLeadingQuoteBanners(scanMarkdownText(raw, false));
    if (!lead) {
        return false;
    }
    const prose = stripLeadingQuoteBanners(scanMarkdownText(raw, true)).replace(
        BARE_URL_PATTERN,
        (match) => {
            const trailing = match.match(/[?.!]+$/);
            return trailing ? ` ${trailing[0]}` : ' ';
        },
    );
    if (prose.includes('?') || RESPONSE_REQUEST_PATTERN.test(prose)) {
        return false;
    }
    return TERMINAL_CLOSURE_PATTERN.test(lead);
}

/**
 * Bot detection from what the platform exposes: GitHub's user type, GitLab's
 * `bot` flag, and the `[bot]` / `*_bot_*` login conventions the platforms use
 * for apps and access-token users.
 */
export function isBotAuthor(author: {
    login?: string;
    type?: string;
    bot?: boolean;
}): boolean {
    if (author?.bot === true) return true;
    const type = author?.type?.toLowerCase();
    if (type === 'bot' || type === 'app_user') return true;
    return !!author?.login && BOT_LOGIN_PATTERN.test(author.login);
}

/**
 * The free part of the decision. `thread` is oldest first and ends with the
 * reply being routed. Returns why Kody stays quiet, or undefined to go on.
 */
export function implicitReplyGate(
    fullThread: ThreadMessage[] | undefined,
    options?: ImplicitReplyGateOptions,
): ImplicitReplySilence | undefined {
    // The prompt reply Kody posts under a Bitbucket finding is part of the
    // finding, not an answer: it does not count toward either cap. The routed
    // message stays, so Kody's own prompt reply is still silenced as Kody's.
    const thread = fullThread?.filter(
        (m, i) =>
            i === 0 ||
            i === fullThread.length - 1 ||
            !(m.isKody && isKodyPromptReply(m.body)),
    );
    if (!thread || thread.length < 2 || !thread[0].isKody) {
        return 'not_kody_thread';
    }

    const reply = thread[thread.length - 1];

    if (reply.isKody) {
        return 'kody_author';
    }

    if (options?.threadResolved) {
        return 'resolved_thread';
    }

    if (isTerminalClosureNote(reply.body)) {
        return 'terminal_closure';
    }

    if (
        reply.isBot &&
        kodyRepliesSinceLastHuman(thread) >= IMPLICIT_REPLY_BOT_CAP
    ) {
        return 'bot_cap';
    }

    const kodyReplies = thread.slice(1).filter((m) => m.isKody).length;
    if (kodyReplies >= IMPLICIT_REPLY_THREAD_CAP) {
        return 'thread_cap';
    }

    return undefined;
}

/** Kody replies after the last human message, not counting the root. */
function kodyRepliesSinceLastHuman(thread: ThreadMessage[]): number {
    const replies = thread.slice(1, -1);
    let count = 0;

    for (let i = replies.length - 1; i >= 0; i--) {
        const message = replies[i];
        if (!message.isKody && !message.isBot) break;
        if (message.isKody) count++;
    }

    return count;
}

/**
 * Asks the org's conversation model whether the newest message is directed at
 * Kody. Throws on any model failure; the caller treats that as silence.
 */
export async function classifyReplyAddressedToKody(params: {
    thread: ThreadMessage[];
    byokConfig?: NormalizedModel;
    organizationAndTeamData: OrganizationAndTeamData;
    prNumber?: number;
    platformType?: string;
}): Promise<boolean> {
    const result = await LLM.run({
        schema: replyAddressedToKodySchema,
        system: prompt_replyAddressedToKody_system(),
        user: prompt_replyAddressedToKody_user(params.thread),
        runName: 'ChatWithKodyFromGitUseCase::classifyImplicitReply',
        organizationId: params.organizationAndTeamData?.organizationId,
        attrs: {
            prNumber: params.prNumber,
            teamId: params.organizationAndTeamData?.teamId,
            platformType: params.platformType,
        },
        byokConfig: params.byokConfig,
    });

    if (typeof result?.addressedToKody !== 'boolean') {
        throw new Error('Reply classifier returned no verdict');
    }

    return result.addressedToKody;
}
