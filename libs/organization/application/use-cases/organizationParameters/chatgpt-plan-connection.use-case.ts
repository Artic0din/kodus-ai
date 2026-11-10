import {
    BadRequestException,
    Injectable,
    ServiceUnavailableException,
} from '@nestjs/common';

import {
    ChatGptPlanAuthService,
    type ChatGptPlanAuthStatus,
    type ChatGptPlanSignInContext,
    type ChatGptPlanSignInResult,
} from '@libs/organization/infrastructure/adapters/services/chatgpt-plan-auth.service';
import { ChatGptPlanSignInError } from '@libs/organization/infrastructure/adapters/services/chatgpt-plan-sign-in.error';

/** Sign-in, status and sign-out of the org's ChatGPT plan. Maps the service's
 *  sanitised domain errors to HTTP errors that carry only a code and a fixed
 *  message. */
@Injectable()
export class ChatGptPlanConnectionUseCase {
    constructor(private readonly auth: ChatGptPlanAuthService) {}

    status(organizationId: string): Promise<ChatGptPlanAuthStatus> {
        return this.auth.getStatus(organizationId);
    }

    start(
        ctx: ChatGptPlanSignInContext,
        options: { differentAccount?: boolean },
    ): Promise<{ authorizeUrl: string; expiresAt: number }> {
        return this.auth.startSignIn(ctx, {
            differentAccount: options.differentAccount === true,
        });
    }

    async complete(
        ctx: ChatGptPlanSignInContext,
        callbackUrl: unknown,
    ): Promise<ChatGptPlanSignInResult & ChatGptPlanAuthStatus> {
        if (typeof callbackUrl !== 'string' || !callbackUrl.trim()) {
            throw new BadRequestException({
                code: 'callback_invalid',
                message: new ChatGptPlanSignInError('callback_invalid').message,
            });
        }
        try {
            const result = await this.auth.completeSignIn(ctx, callbackUrl);
            return {
                ...result,
                ...(await this.auth.getStatus(ctx.organizationId)),
            };
        } catch (error) {
            if (error instanceof ChatGptPlanSignInError) {
                const body = { code: error.code, message: error.message };
                throw error.code === 'unavailable'
                    ? new ServiceUnavailableException(body)
                    : new BadRequestException(body);
            }
            throw error;
        }
    }

    async signOut(
        organizationId: string,
    ): Promise<ChatGptPlanAuthStatus & { revocationConfirmed: boolean }> {
        const { revocationConfirmed } =
            await this.auth.signOut(organizationId);
        return {
            ...(await this.auth.getStatus(organizationId)),
            revocationConfirmed,
        };
    }
}
