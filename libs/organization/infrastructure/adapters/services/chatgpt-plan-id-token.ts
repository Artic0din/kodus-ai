import { createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import type { JsonWebKeyInput } from 'node:crypto';

import { ChatGptPlanSignInError } from './chatgpt-plan-sign-in.error';

/** An RSA key from OpenAI's JWKS. */
export type Jwk = JsonWebKeyInput['key'] & { kid?: string };

export const CHATGPT_PLAN_ISSUER = 'https://auth.openai.com';

/** Clock skew tolerated on `exp`, in seconds. */
const EXPIRY_LEEWAY_SECONDS = 60;

export interface VerifiedIdToken {
    sub: string;
    email?: string;
}

function decodeSegment(segment: string): Record<string, unknown> | null {
    try {
        const value: unknown = JSON.parse(
            Buffer.from(segment, 'base64url').toString('utf8'),
        );
        return value && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

function sameString(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

function signatureIsValid(
    headerPart: string,
    payloadPart: string,
    signaturePart: string,
    jwk: Jwk,
): boolean {
    try {
        return verify(
            'sha256',
            Buffer.from(`${headerPart}.${payloadPart}`),
            createPublicKey({ key: jwk, format: 'jwk' }),
            Buffer.from(signaturePart, 'base64url'),
        );
    } catch {
        return false;
    }
}

function reject(): never {
    throw new ChatGptPlanSignInError('token_rejected');
}

/**
 * Verifies an OpenAI ID token the way the sign-in docs require: RS256
 * signature against the published JWKS, issuer, audience = the issued
 * `client_id`, expiry and the nonce of this attempt. Throws a sanitised
 * `token_rejected` for every failure; the reason is deliberately not reported.
 */
export function verifyIdToken(
    idToken: string,
    jwks: readonly Jwk[],
    expected: { clientId: string; nonce: string; nowSeconds: number },
): VerifiedIdToken {
    const parts = idToken.split('.');
    if (parts.length !== 3) reject();
    const [headerPart, payloadPart, signaturePart] = parts;

    const header = decodeSegment(headerPart);
    const claims = decodeSegment(payloadPart);
    if (!header || !claims) reject();
    // Pinning the algorithm closes the none/HS256 downgrade.
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') reject();

    const jwk = jwks.find(
        (key) => key.kty === 'RSA' && key.kid === header.kid,
    );
    if (!jwk) reject();

    if (!signatureIsValid(headerPart, payloadPart, signaturePart, jwk)) reject();

    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== CHATGPT_PLAN_ISSUER) reject();
    if (!audience.includes(expected.clientId)) reject();
    if (
        typeof claims.exp !== 'number' ||
        claims.exp < expected.nowSeconds - EXPIRY_LEEWAY_SECONDS
    ) {
        reject();
    }
    if (
        typeof claims.nonce !== 'string' ||
        !sameString(claims.nonce, expected.nonce)
    ) {
        reject();
    }
    if (typeof claims.sub !== 'string' || !claims.sub) reject();

    return {
        sub: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
    };
}
