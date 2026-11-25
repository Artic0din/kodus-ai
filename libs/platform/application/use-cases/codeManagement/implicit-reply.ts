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
const MAX_CLOSURE_CHARS = 240;
const STANDALONE_CLOSURE_PATTERN =
    /^(?:good\s+catch|thanks|thank\s+you|ty|thx|makes\s+sense|lgtm|sgtm|noted|acknowledged|got\s+it|done|fixed|addressed|resolved|applied|updated|removed|reverted|declined|declining|won['’]t\s+fix|wontfix|not\s+fixing|not\s+changing(?:\s+this)?|skipping|skipped|leaving\s+as[- ]is|by\s+design|intentional|working\s+as\s+intended|out\s+of\s+scope|no\s+changes?\s+needed)[.,!]?$/i;
const REF_CLOSURE_PATTERN =
    /^(?:(?:good\s+catch|thanks|thank\s+you)[.,!]?\s+)?(?:(?:fixed|addressed|resolved|done|applied|updated|removed|reverted|implemented|tracked|deferred)\s+(?:in|by|via|to)\s+(?:(?:the\s+)?(?:latest|last|follow[- ]up)\s+)?(?:(?:commit|pr|pull\s+request|issue|push)\s+)?`?[A-Za-z0-9#/_.-]+`?|(?:out\s+of\s+scope|deferred|declining|declined|won['’]t\s+fix|wontfix|by\s+design|intentional)(?::\s*|,\s+|\s+[—–-]\s+|\s+)(?:tracked\s+in|see|per)\s+`?[A-Za-z0-9#/_.-]+`?)[.,!]?$/i;

/**
 * Strips leading markdown quote blocks (such as GitHub `> [!NOTE]` agent
 * banners) so the author's actual note can be checked. Returns empty when the
 * reply contains only quotes or whitespace.
 */
function stripLeadingQuoteBanners(raw: string): string {
    const lines = raw.split(/\r?\n/);
    let index = 0;
    while (index < lines.length) {
        const trimmed = lines[index].trim();
        if (!trimmed || trimmed.startsWith('>')) {
            index++;
            continue;
        }
        break;
    }
    if (index >= lines.length) {
        return '';
    }
    return lines.slice(index).join('\n').trim();
}

/**
 * True only for unambiguous, single-line closure or acknowledgment notes
 * ("Fixed in `cb01ad78`.", "Addressed in commit abc1234.", "Thanks!",
 * "Out of scope, tracked in #93."). Any reply with extra sentences or
 * potentially actionable prose fails open to the classifier.
 */
export function isTerminalClosureNote(body: string): boolean {
    const text = stripLeadingQuoteBanners(body ?? '');
    if (!text || text.length > MAX_CLOSURE_CHARS || text.includes('\n')) {
        return false;
    }
    return (
        STANDALONE_CLOSURE_PATTERN.test(text) || REF_CLOSURE_PATTERN.test(text)
    );
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
