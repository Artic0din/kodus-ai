import { BYOKProvider } from './model-providers';
import type { NormalizedModel } from './byok-config';

/**
 * Stamp the authenticated tenant on a slot that selects per-tenant credentials
 * (today only `chatgpt_plan`, whose tokens are looked up by it). Always
 * overwritten: a slot's `organizationId` is trusted only because this is the one
 * place that sets it, from the request, never from stored credential settings.
 * Other providers' slots pass through untouched.
 */
function stampSlot<T extends NormalizedModel>(
    slot: T,
    organizationId: string | undefined,
): T {
    return slot.provider === BYOKProvider.CHATGPT_PLAN &&
        slot.organizationId !== organizationId
        ? { ...slot, organizationId }
        : slot;
}

/**
 * Stamp the primary and its fallback with the request's tenant (`LLM.run`) or
 * the invocation's (`resolveTaskInvocation`). Returns the same object when nothing changes. */
export function stampOrganizationId(
    slot: NormalizedModel | undefined,
    organizationId: string | undefined,
): NormalizedModel | undefined {
    if (!slot) {
        return slot;
    }
    const primary = stampSlot(slot, organizationId);
    const fallback = slot.fallback
        ? stampSlot(slot.fallback, organizationId)
        : undefined;
    return primary === slot && fallback === slot.fallback
        ? slot
        : { ...primary, ...(fallback ? { fallback } : {}) };
}
