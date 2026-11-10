import { REGISTRY } from '..';
import { describeProviderId } from '../provider-ui-descriptor';
import { chatgptPlanModule } from '.';
import { parsePlanModels, planModelListing } from './listing';
import {
    isKeylessCredential,
    isPlatformFundedProvider,
} from '../../platform-funded-provider';
import { resolveModelSlot, resolveDefaultSlot } from '../../resolve-model-slot';
import { isByokSlotConfigured } from '../../llm-config-status';
import { LLM } from '../../llm';
import { slotForProbe } from '../../probe-slot-call';
import { setChatGptPlanTokenProvider } from './token-provider';
import { FakePlanServer, completedStream } from '../../testing/fake-plan-server';
import type { BYOKConfig, NormalizedModel } from '../../byok-config';

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

const cfg = { provider: 'chatgpt_plan', model: 'gpt-5.4', apiKey: '' } as any;

describe('chatgpt_plan provider module', () => {
    it('is registered under its own id and labelled', () => {
        expect(REGISTRY.get('chatgpt_plan')).toBe(chatgptPlanModule);
        expect(chatgptPlanModule.label).toBe('ChatGPT plan');
    });

    it('collects no key: the connect form derives requiresApiKey false and no base URL', () => {
        expect(chatgptPlanModule.uiFields).toEqual([]);
        const ui = describeProviderId(chatgptPlanModule, 'chatgpt_plan');
        expect(ui).toMatchObject({
            requiresApiKey: false,
            requiresBaseUrl: false,
            acceptsBaseUrl: false,
            autoListModels: true,
            listsModelsLive: true,
        });
    });

    it('takes no sampling parameters', () => {
        expect(chatgptPlanModule.temperaturePolicy(cfg)).toEqual({
            kind: 'unsupported',
        });
    });

    it('answers every protocol fact as native OpenAI does', () => {
        const openai = REGISTRY.get('openai');
        const asOpenAi = { ...cfg, provider: 'openai' };
        expect(
            chatgptPlanModule.providerOptionsNamespace!('chatgpt_plan'),
        ).toBe('openai');
        expect(chatgptPlanModule.capabilities('gpt-5.4')).toEqual(
            openai.capabilities('gpt-5.4'),
        );
        expect(chatgptPlanModule.reasoningTraits(cfg)).toEqual(
            openai.reasoningTraits(asOpenAi),
        );
        expect(chatgptPlanModule.reasoning!(cfg, 'high')).toEqual({
            openai: { reasoningEffort: 'high' },
        });
        expect(chatgptPlanModule.structuredOutputPolicy(cfg)).toBe(
            'json_schema',
        );
        expect(
            chatgptPlanModule.reasoningOverrideExample!(
                'chatgpt_plan',
                'gpt-5.4',
            ),
        ).toBe(openai.reasoningOverrideExample!('openai', 'gpt-5.4'));
    });

    it('builds without a token or an organisation and wraps the supplied fetch', async () => {
        const server = new FakePlanServer().always(() => completedStream('ok'));
        setChatGptPlanTokenProvider({ getAccessToken: async () => 'tok' });
        const spy = jest.fn(server.fetch);
        const model: any = chatgptPlanModule.build(
            { ...cfg, organizationId: 'org-1' },
            { fetch: spy },
        );
        expect(model.provider).toContain('openai');
        await model.doGenerate({
            prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        });
        expect(spy).toHaveBeenCalledTimes(1);
        setChatGptPlanTokenProvider(undefined);
    });
});

describe('chatgpt_plan model listing', () => {
    const body = {
        models: [
            { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list' },
            {
                slug: 'gpt-5.4-mini',
                display_name: 'GPT-5.4 Mini',
                visibility: 'list',
            },
            {
                slug: 'internal-only',
                display_name: 'Hidden',
                visibility: 'hide',
            },
            { display_name: 'no slug', visibility: 'list' },
            null,
        ],
    };

    it('keeps visibility "list", maps slug to id and display_name to name, with reasoning facts', () => {
        const models = parsePlanModels(body);
        expect(models.map((m) => [m.id, m.name])).toEqual([
            ['gpt-5.4', 'GPT-5.4'],
            ['gpt-5.4-mini', 'GPT-5.4 Mini'],
        ]);
        expect(models[0].supportsReasoning).toBe(true);
        expect(models[0].reasoningConfig).toBeDefined();
    });

    it('derives a name from the slug when display_name is absent', () => {
        const [model] = parsePlanModels({
            models: [{ slug: 'gpt-5.4', visibility: 'list' }],
        });
        expect(model.name).toBe('GPT 5.4');
    });

    it.each([undefined, null, {}, { models: 'nope' }, { data: [{ id: 'x' }] }])(
        'answers an empty list for %j',
        (value) => {
            expect(parsePlanModels(value)).toEqual([]);
        },
    );

    it('lists from OpenAI with the access token as the bearer, no env key', () => {
        expect(planModelListing.kind).toBe('http');
        if (planModelListing.kind !== 'http') return;
        expect(planModelListing.url({})).toBe(
            'https://api.openai.com/v1/models',
        );
        expect(
            planModelListing.headers({ apiKey: 'access-token' }).Authorization,
        ).toBe('Bearer access-token');
        expect(planModelListing.apiKeyEnv).toBeUndefined();
        expect(chatgptPlanModule.modelListing!('openai')).toBeNull();
    });
});

describe('keyless credentials', () => {
    it('treats kodus and chatgpt_plan as keyless, and only kodus as platform-funded', () => {
        expect(isKeylessCredential('kodus')).toBe(true);
        expect(isKeylessCredential('chatgpt_plan')).toBe(true);
        expect(isKeylessCredential('openai')).toBe(false);
        expect(isKeylessCredential(undefined)).toBe(false);
        expect(isPlatformFundedProvider('chatgpt_plan')).toBe(false);
    });

    const config: BYOKConfig = {
        version: 2,
        credentials: [{ id: 'plan', provider: 'chatgpt_plan' }],
        models: [{ id: 'm1', credentialId: 'plan', model: 'gpt-5.4' }],
        routing: { defaultModelId: 'm1' },
    };

    it('resolves a plan credential with no key to a slot, and reports it configured', () => {
        const slot = resolveModelSlot(config, 'm1');
        expect(slot).toMatchObject({
            provider: 'chatgpt_plan',
            model: 'gpt-5.4',
            apiKey: '',
        });
        expect(isByokSlotConfigured(slot)).toBe(true);
        expect(resolveDefaultSlot(config)?.provider).toBe('chatgpt_plan');
    });

    it('never reads the organisation from credential settings', async () => {
        const forged: BYOKConfig = {
            ...config,
            credentials: [
                {
                    id: 'plan',
                    provider: 'chatgpt_plan',
                    settings: { organizationId: 'org-victim' },
                },
            ],
        };
        const slot = resolveModelSlot(forged, 'm1')!;
        expect(slot.organizationId).toBeUndefined();

        // And end to end: whatever the settings say, the bearer is the caller's.
        const seen: string[] = [];
        setChatGptPlanTokenProvider({
            getAccessToken: async (org) => {
                seen.push(org);
                return 'tok';
            },
        });
        const server = new FakePlanServer().always(() => completedStream('ok'));
        jest.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);
        await LLM.run({
            byokConfig: slot,
            user: 'u',
            runName: 'forged',
            organizationId: 'org-real',
        });
        expect(seen).toEqual(['org-real']);
        jest.restoreAllMocks();
        setChatGptPlanTokenProvider(undefined);
    });
});

describe('the connection probe keeps the trusted organisation', () => {
    it('slotForProbe drops throughput policy but not the tenant', () => {
        const slot = slotForProbe({
            provider: 'chatgpt_plan',
            apiKey: '',
            model: 'gpt-5.4',
            organizationId: 'org-1',
            rpm: 5,
        } as NormalizedModel);
        expect(slot.organizationId).toBe('org-1');
        expect(slot.rpm).toBeUndefined();
    });
});
