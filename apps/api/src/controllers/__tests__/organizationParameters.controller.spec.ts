import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { OrganizationParametersKey } from '@libs/core/domain/enums';

import { OrganizationParametersController } from '../organizationParameters.controller';

/**
 * Route-level assertions for the v2 delete-by-model-id transport rewire
 * (05-04 Task 1 / REQ-DELETE-01 backend half). These prove the HTTP layer,
 * not the domain: a valid `{ modelId }` reaches DeleteByokConfigUseCase.execute
 * and a missing/empty modelId 400s BEFORE the use-case is touched.
 */
describe('OrganizationParametersController.deleteByokConfig — v2 { modelId } route', () => {
    let controller: OrganizationParametersController;
    let deleteByokConfigUseCase: { execute: jest.Mock };
    let request: { user?: { organization?: { uuid?: string } } };

    function buildController(orgId: string | undefined = 'org-1') {
        deleteByokConfigUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };
        request = {
            user: { organization: { uuid: orgId } },
        };
        // Only deleteByokConfigUseCase (arg 5) and request (last arg) are
        // exercised by this route; the rest are irrelevant here.
        controller = new OrganizationParametersController(
            undefined as any, // createOrUpdateOrganizationParametersUseCase
            undefined as any, // findByKeyOrganizationParametersUseCase
            undefined as any, // getModelsByProviderUseCase
            undefined as any, // getModelCapabilitiesUseCase
            undefined as any, // providerService
            deleteByokConfigUseCase as any,
            undefined as any, // getLLMConfigStatusUseCase
            undefined as any, // getByokProvidersUseCase
            undefined as any, // testByokConnectionUseCase
            undefined as any, // testByokModelUseCase
            undefined as any, // listModelOverridesUseCase
            undefined as any, // clearModelOverridesUseCase
            undefined as any, // getCockpitMetricsVisibilityUseCase
            undefined as any, // ignoreBotsUseCase
            undefined as any, // updateAutoLicenseAllowedUsersUseCase
            request as any,
        );
    }

    it('passes a valid { modelId } straight to the use-case, scoped to the org', async () => {
        buildController('org-1');

        await expect(controller.deleteByokConfig('m2')).resolves.toBe(true);
        expect(deleteByokConfigUseCase.execute).toHaveBeenCalledWith('org-1', {
            modelId: 'm2',
        });
    });

    it('400s on a missing modelId without touching the use-case', async () => {
        buildController('org-1');

        await expect(
            controller.deleteByokConfig(undefined as any),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(deleteByokConfigUseCase.execute).not.toHaveBeenCalled();
    });

    it('400s on an empty/whitespace modelId without touching the use-case', async () => {
        buildController('org-1');

        await expect(controller.deleteByokConfig('   ')).rejects.toBeInstanceOf(
            BadRequestException,
        );
        expect(deleteByokConfigUseCase.execute).not.toHaveBeenCalled();
    });
});

describe('OrganizationParametersController — chatgpt_plan_auth is not a generic parameter', () => {
    function build() {
        const createOrUpdate = { execute: jest.fn().mockResolvedValue(true) };
        const findByKey = { execute: jest.fn().mockResolvedValue(null) };
        const controller = new (OrganizationParametersController as any)(
            createOrUpdate,
            findByKey,
            ...Array(13).fill(undefined),
            { user: { organization: { uuid: 'org-1' } } },
        ) as OrganizationParametersController;
        return { controller, createOrUpdate, findByKey };
    }

    it('refuses to write it through create-or-update', async () => {
        const { controller, createOrUpdate } = build();
        await expect(
            controller.createOrUpdate({
                key: OrganizationParametersKey.CHATGPT_PLAN_AUTH,
                configValue: { status: 'connected', accessToken: 'attacker-chosen' },
            }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(createOrUpdate.execute).not.toHaveBeenCalled();
    });

    it('still writes an ordinary key', async () => {
        const { controller, createOrUpdate } = build();
        await controller.createOrUpdate({
            key: OrganizationParametersKey.REVIEW_MODE_CONFIG,
            configValue: {},
        });
        expect(createOrUpdate.execute).toHaveBeenCalled();
    });

    it('returns nothing for it through find-by-key (the use case withholds the row)', async () => {
        const { controller, findByKey } = build();
        await expect(
            controller.findByKey(OrganizationParametersKey.CHATGPT_PLAN_AUTH),
        ).resolves.toBeNull();
        expect(findByKey.execute).toHaveBeenCalledWith(
            OrganizationParametersKey.CHATGPT_PLAN_AUTH,
            { organizationId: 'org-1' },
        );
    });
});
