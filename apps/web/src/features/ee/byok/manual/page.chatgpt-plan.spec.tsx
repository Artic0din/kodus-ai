/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import type { ReactNode } from "react";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { useFormContext } from "react-hook-form";

import type { BYOKConfig } from "../_types";
import { ByokManualPageClient } from "./page.client";

/**
 * The manual form for the ChatGPT plan: the credential row the sign-in created
 * must never read as "a stored key". The form always renders, and Test & save
 * always runs the live probe, then updates that credential instead of adding a
 * second one.
 */
const push = jest.fn();
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push, replace: jest.fn(), refresh: jest.fn() }),
}));
jest.mock("next/link", () => ({
    __esModule: true,
    default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const testBYOK = jest.fn();
const testBYOKModel = jest.fn();
const createOrUpdate = jest.fn();
jest.mock("@services/organizationParameters/fetch", () => ({
    testBYOK: (...a: unknown[]) => testBYOK(...a),
    testBYOKModel: (...a: unknown[]) => testBYOKModel(...a),
    createOrUpdateOrganizationParameter: (...a: unknown[]) =>
        createOrUpdate(...a),
}));
jest.mock("@services/organizationParameters/hooks", () => ({
    useSuspenseGetLLMProviders: () => ({
        providers: [
            { id: "chatgpt_plan", name: "ChatGPT plan", requiresApiKey: false },
        ],
    }),
}));
jest.mock("@components/ui/toaster/use-toast", () => ({ toast: jest.fn() }));
jest.mock("src/core/utils/revalidate-server-side", () => ({
    revalidateServerSidePath: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("src/app/(app)/settings/_components/context", () => ({
    useFeatureFlags: () => ({ kodusProvider: false }),
}));
jest.mock("../_hooks/use-kodus-credit-balance", () => ({
    KODUS_CREDITS_PATH: "/credits",
    useKodusCreditBalance: () => ({ usesKodusProvider: false }),
}));
jest.mock("@components/system/page-skeletons", () => ({
    AiProvidersPageSkeleton: () => null,
}));

// The pieces that fetch or are covered by their own specs.
jest.mock(
    "../_components/_modals/edit-key/_components/credentials-input",
    () => ({
        ByokCredentialsInput: () => <div data-testid="credentials-form" />,
    }),
);
jest.mock("../_components/_modals/edit-key/_components/baseurl-input", () => ({
    ByokBaseURLInput: () => null,
}));
jest.mock(
    "../_components/_modals/edit-key/_components/advanced-settings",
    () => ({
        ByokAdvancedSettings: () => null,
    }),
);
jest.mock("../_components/_modals/edit-key/_components/provider", () => ({
    ByokProviderSelect: () => null,
}));
jest.mock(
    "../_components/_modals/edit-key/_components/provider-doc-link",
    () => ({
        ProviderDocLink: () => null,
    }),
);
jest.mock("../_components/_modals/edit-key/_components/models", () => ({
    ByokManualModelInput: () => null,
    ByokModelSelect: ({ credentialStored }: { credentialStored: boolean }) => {
        const form = useFormContext();
        return (
            <input
                aria-label="Model"
                data-credential-stored={String(credentialStored)}
                value={form.watch("model") ?? ""}
                onChange={(e) =>
                    form.setValue("model", e.target.value, {
                        shouldValidate: true,
                    })
                }
            />
        );
    },
}));

const signedInConfig: BYOKConfig = {
    version: 2,
    credentials: [{ id: "plan-cred", provider: "chatgpt_plan" }],
    models: [],
};

function renderPage(existing: BYOKConfig | null = signedInConfig) {
    return render(
        <ByokManualPageClient
            existing={existing}
            presetProvider="chatgpt_plan"
            llmConfigStatus={null}
        />,
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    testBYOK.mockResolvedValue({ ok: true, code: "ok", latencyMs: 12 });
    createOrUpdate.mockResolvedValue({});
});

describe("manual form — ChatGPT plan", () => {
    it("renders the ChatGPT account form, never the stored-key view", () => {
        renderPage();
        expect(screen.getByTestId("credentials-form")).toBeInTheDocument();
        expect(screen.getByText("ChatGPT account")).toBeInTheDocument();
        expect(
            screen.queryByText(/using your stored key/i),
        ).not.toBeInTheDocument();
        expect(screen.queryByText("API key")).not.toBeInTheDocument();
    });

    it("renders the same form before the first sign-in", () => {
        renderPage(null);
        expect(screen.getByTestId("credentials-form")).toBeInTheDocument();
    });

    it("Test & save probes the live connection, not the stored credential", async () => {
        renderPage();
        fireEvent.change(screen.getByLabelText("Model"), {
            target: { value: "gpt-5.1-codex" },
        });

        const save = screen.getByRole("button", { name: /test & save/i });
        await waitFor(() => expect(save).toBeEnabled());
        await act(async () => {
            fireEvent.click(save);
        });

        await waitFor(() => expect(createOrUpdate).toHaveBeenCalled());
        expect(testBYOK).toHaveBeenCalledWith(
            expect.objectContaining({
                provider: "chatgpt_plan",
                model: "gpt-5.1-codex",
            }),
        );
        expect(testBYOKModel).not.toHaveBeenCalled();
    });

    it("saves onto the credential the sign-in created instead of adding a second", async () => {
        renderPage();
        fireEvent.change(screen.getByLabelText("Model"), {
            target: { value: "gpt-5.1-codex" },
        });
        const save = screen.getByRole("button", { name: /test & save/i });
        await waitFor(() => expect(save).toBeEnabled());
        await act(async () => {
            fireEvent.click(save);
        });

        await waitFor(() => expect(createOrUpdate).toHaveBeenCalled());
        const [, blob] = createOrUpdate.mock.calls[0] as [string, BYOKConfig];
        expect(blob.credentials).toHaveLength(1);
        expect(blob.credentials[0]).toMatchObject({
            id: "plan-cred",
            provider: "chatgpt_plan",
        });
        expect(blob.credentials[0].apiKey ?? "").toBe("");
        expect(blob.models).toEqual([
            expect.objectContaining({
                credentialId: "plan-cred",
                model: "gpt-5.1-codex",
            }),
        ]);
    });

    it("does not save when the live probe fails (not signed in)", async () => {
        testBYOK.mockResolvedValue({
            ok: false,
            code: "auth",
            latencyMs: 3,
            message: "ChatGPT is not signed in for this organisation.",
        });
        renderPage();
        fireEvent.change(screen.getByLabelText("Model"), {
            target: { value: "gpt-5.1-codex" },
        });
        const save = screen.getByRole("button", { name: /test & save/i });
        await waitFor(() => expect(save).toBeEnabled());
        await act(async () => {
            fireEvent.click(save);
        });

        expect(
            await screen.findByText("ChatGPT sign-in needed"),
        ).toBeInTheDocument();
        expect(screen.queryByText("Invalid API key")).not.toBeInTheDocument();
        expect(createOrUpdate).not.toHaveBeenCalled();
    });
});
