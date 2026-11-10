import 'reflect-metadata';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';

import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { PermissionsAbilityFactory } from '@libs/identity/infrastructure/adapters/services/permissions/permissionsAbility.factory';
import { ChatGptPlanConnectionUseCase } from '@libs/organization/application/use-cases/organizationParameters/chatgpt-plan-connection.use-case';
import { ChatGptPlanSignInError } from '@libs/organization/infrastructure/adapters/services/chatgpt-plan-sign-in.error';

import { TenantScopeGuard } from '../../guards/tenant-scope.guard';
import { ChatGptPlanController } from '../chatgptPlan.controller';
import { OrganizationParametersController } from '../organizationParameters.controller';

type Handler = (ability: unknown, request: unknown) => boolean;

async function allowed(
    controller: { prototype: object },
    method: string,
    role: Role,
): Promise<boolean> {
    const handler = (controller.prototype as Record<string, object>)[method];
    const handlers = Reflect.getMetadata('check_policy', handler) as Handler[];
    const factory = new PermissionsAbilityFactory({
        findOne: async () => ({ permissions: { assignedRepositoryIds: [] } }),
    } as never);
    const user = {
        uuid: `u-${role}`,
        role,
        status: STATUS.ACTIVE,
        organization: { uuid: 'org-1' },
    };
    const ability = await factory.createForUser(user as unknown as IUser, []);
    return handlers.every((handler) => handler(ability, { user }));
}

describe('ChatGptPlanController permissions', () => {
    const roles = [Role.OWNER, Role.BILLING_MANAGER, Role.REPO_ADMIN, Role.CONTRIBUTOR];

    // Editing BYOK settings is POST /organization-parameters/create-or-update;
    // reading them is GET /organization-parameters/find-by-key.
    it.each(['start', 'complete', 'signOut'])(
        '%s needs the same permission as editing BYOK settings',
        async (method) => {
            for (const role of roles) {
                expect({
                    role,
                    allowed: await allowed(ChatGptPlanController, method, role),
                }).toEqual({
                    role,
                    allowed: await allowed(OrganizationParametersController, 'createOrUpdate', role),
                });
            }
        },
    );

    it('status needs the same permission as reading organization settings', async () => {
        for (const role of roles) {
            expect(await allowed(ChatGptPlanController, 'status', role)).toBe(
                await allowed(OrganizationParametersController, 'findByKey', role),
            );
        }
    });

    it('only an owner can change the connection', async () => {
        for (const method of ['start', 'complete', 'signOut']) {
            expect(await allowed(ChatGptPlanController, method, Role.OWNER)).toBe(true);
            expect(await allowed(ChatGptPlanController, method, Role.CONTRIBUTOR)).toBe(false);
            expect(await allowed(ChatGptPlanController, method, Role.REPO_ADMIN)).toBe(false);
        }
    });

    it('is guarded by tenant scope like the other organization-parameters routes', () => {
        const guards = Reflect.getMetadata('__guards__', ChatGptPlanController) as unknown[];
        expect(guards).toContain(TenantScopeGuard);
        expect(Reflect.getMetadata('path', ChatGptPlanController)).toBe(
            'organization-parameters/chatgpt-plan',
        );
    });
});

describe('ChatGptPlanController requests', () => {
    function build(user: unknown = { uuid: 'user-1', organization: { uuid: 'org-1' } }) {
        const connection = {
            status: jest.fn().mockResolvedValue({ status: 'connected', email: 'a@b.c' }),
            start: jest.fn().mockResolvedValue({ authorizeUrl: 'u', expiresAt: 1 }),
            complete: jest.fn().mockResolvedValue({ outcome: 'connected' }),
            signOut: jest.fn().mockResolvedValue({ status: 'reauth_required', revocationConfirmed: true }),
        };
        const controller = new ChatGptPlanController(connection as never, { user } as never);
        return { controller, connection };
    }

    it('scopes every call to the authenticated org and user, never the body', async () => {
        const { controller, connection } = build();

        await controller.status();
        await controller.start({
            differentAccount: true,
            organizationId: 'victim-org',
            userId: 'victim-user',
        } as never);
        await controller.complete({ callbackUrl: 'http://127.0.0.1:1455/auth/callback?x=1' });
        await controller.signOut();

        expect(connection.status).toHaveBeenCalledWith('org-1');
        expect(connection.start).toHaveBeenCalledWith(
            { organizationId: 'org-1', userId: 'user-1' },
            { differentAccount: true },
        );
        expect(connection.complete).toHaveBeenCalledWith(
            { organizationId: 'org-1', userId: 'user-1' },
            'http://127.0.0.1:1455/auth/callback?x=1',
        );
        expect(connection.signOut).toHaveBeenCalledWith('org-1');
    });

    it('starts with no body at all', async () => {
        const { controller, connection } = build();
        await controller.start();
        expect(connection.start).toHaveBeenCalledWith(expect.anything(), {
            differentAccount: undefined,
        });
    });

    it('refuses a request without an organisation or a user', async () => {
        await expect(build({ uuid: 'u' }).controller.status()).rejects.toThrow('Organization ID');
        await expect(
            build({ organization: { uuid: 'org-1' } }).controller.start({}),
        ).rejects.toThrow('User ID');
    });
});

describe('ChatGptPlanConnectionUseCase.complete', () => {
    const ctx = { organizationId: 'org-1', userId: 'user-1' };

    function build(completeSignIn: jest.Mock) {
        const auth = {
            completeSignIn,
            getStatus: jest.fn().mockResolvedValue({ status: 'connected', email: 'a@b.c' }),
        };
        return new ChatGptPlanConnectionUseCase(auth as never);
    }

    it('returns the outcome with the fresh status', async () => {
        const useCase = build(jest.fn().mockResolvedValue({ outcome: 'connected', email: 'a@b.c' }));
        await expect(useCase.complete(ctx, 'http://127.0.0.1:1455/auth/callback?a=b')).resolves.toEqual({
            outcome: 'connected',
            email: 'a@b.c',
            status: 'connected',
        });
    });

    it('answers a sign-in failure with 400, a code and the fixed message only', async () => {
        const useCase = build(
            jest.fn().mockRejectedValue(new ChatGptPlanSignInError('attempt_expired')),
        );
        const error = await useCase.complete(ctx, 'http://127.0.0.1:1455/auth/callback?code=SECRET').catch((e) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.getResponse()).toEqual({
            code: 'attempt_expired',
            message: new ChatGptPlanSignInError('attempt_expired').message,
        });
        expect(JSON.stringify(error.getResponse())).not.toContain('SECRET');
    });

    it('answers an unreachable auth server with 503', async () => {
        const useCase = build(
            jest.fn().mockRejectedValue(new ChatGptPlanSignInError('unavailable')),
        );
        await expect(useCase.complete(ctx, 'http://127.0.0.1:1455/auth/callback?a=b')).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
    });

    it.each([undefined, null, '', '   ', 42, {}])(
        'rejects a missing callback address (%p) without calling the service',
        async (value) => {
            const completeSignIn = jest.fn();
            const useCase = build(completeSignIn);
            const error = await useCase.complete(ctx, value).catch((e) => e);
            expect(error).toBeInstanceOf(BadRequestException);
            expect(error.getResponse()).toMatchObject({ code: 'callback_invalid' });
            expect(completeSignIn).not.toHaveBeenCalled();
        },
    );

    it('does not translate an unexpected error into a sign-in message', async () => {
        const boom = new Error('database exploded');
        const useCase = build(jest.fn().mockRejectedValue(boom));
        await expect(useCase.complete(ctx, 'http://127.0.0.1:1455/auth/callback?a=b')).rejects.toBe(boom);
    });
});
