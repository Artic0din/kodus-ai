import { BYOKProvider } from './model-providers';
import {
    isKeylessCredential,
    isPlatformFundedProvider,
} from './platform-funded-provider';
import type { NormalizedModel } from './byok-config';

type AuthMaterial = {
    apiKey?: unknown;
    awsBearerToken?: unknown;
    awsAccessKeyId?: unknown;
    awsSecretAccessKey?: unknown;
};

/** Shared credential presence and Bedrock auth priority; accepts ciphertext too. */
export function byokAuthKind(
    provider: string | undefined,
    material: AuthMaterial | null | undefined,
):
    | 'platform'
    | 'keyless'
    | 'api-key'
    | 'bedrock-bearer'
    | 'bedrock-iam'
    | undefined {
    const has = (value: unknown) =>
        typeof value === 'string' && value.trim().length > 0;
    if (isPlatformFundedProvider(provider)) return 'platform';
    // `chatgpt_plan` fetches its bearer per request; billed to the org's plan.
    if (isKeylessCredential(provider)) return 'keyless';
    if (provider === BYOKProvider.AMAZON_BEDROCK) {
        if (has(material?.awsBearerToken)) return 'bedrock-bearer';
        if (has(material?.awsAccessKeyId) && has(material?.awsSecretAccessKey))
            return 'bedrock-iam';
        return undefined;
    }
    return has(material?.apiKey) ? 'api-key' : undefined;
}

export function isByokSlotConfigured(
    slot: Partial<NormalizedModel> | null | undefined,
): boolean {
    return !!slot && byokAuthKind(slot.provider, slot) !== undefined;
}
