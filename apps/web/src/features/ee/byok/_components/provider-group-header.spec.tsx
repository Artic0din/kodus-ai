/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen } from "@testing-library/react";

import type { BYOKCredential } from "../_types";
import { ProviderGroupHeader } from "./provider-group-header";

const mockStatus = jest.fn();
jest.mock("@services/organizationParameters/chatgpt-plan", () => ({
    useChatGptPlanStatus: (...a: unknown[]) => mockStatus(...a),
}));
jest.mock("../_hooks/use-kodus-credit-balance", () => ({
    useKodusCreditBalance: () => ({}),
}));
jest.mock("./credits-wallet", () => ({ CreditsWalletStrip: () => null }));

const credential = (over: Partial<BYOKCredential>): BYOKCredential =>
    ({ id: "c1", provider: "chatgpt_plan", ...over }) as BYOKCredential;

const renderHeader = (cred: BYOKCredential, onRotate = jest.fn()) => {
    render(
        <ProviderGroupHeader
            credential={cred}
            modelCount={2}
            onRotate={onRotate}>
            <div />
        </ProviderGroupHeader>,
    );
    return onRotate;
};

beforeEach(() => mockStatus.mockReset());

describe("ProviderGroupHeader — ChatGPT plan shows the connection, not a key", () => {
    it("connected: the account, no masked key", () => {
        mockStatus.mockReturnValue({
            data: { status: "connected", email: "owner@example.com" },
            isLoading: false,
        });
        renderHeader(credential({ apiKey: undefined }));
        expect(
            screen.getByText("Connected as owner@example.com"),
        ).toBeInTheDocument();
        expect(screen.queryByText(/••••/)).not.toBeInTheDocument();
        expect(mockStatus).toHaveBeenCalledWith(true);
    });

    it.each([
        [{ status: "reauth_required" }, /sign in again to use the plan/i],
        [{ status: "not_connected" }, /not signed in to chatgpt/i],
        [{ status: "not_eligible" }, /plan use not available/i],
    ])("%j reads as a state to fix", (data, text) => {
        mockStatus.mockReturnValue({ data, isLoading: false });
        renderHeader(credential({}));
        expect(screen.getByText(text)).toBeInTheDocument();
    });

    it("says it is checking while the status loads", () => {
        mockStatus.mockReturnValue({ data: undefined, isLoading: true });
        renderHeader(credential({}));
        expect(
            screen.getByText(/checking chatgpt connection/i),
        ).toBeInTheDocument();
    });

    it("the action manages the account instead of editing a key", () => {
        mockStatus.mockReturnValue({
            data: { status: "connected" },
            isLoading: false,
        });
        const onRotate = renderHeader(credential({}));
        fireEvent.click(screen.getByRole("button", { name: "Manage account" }));
        expect(onRotate).toHaveBeenCalled();
        expect(
            screen.queryByRole("button", { name: "Edit provider" }),
        ).not.toBeInTheDocument();
    });
});

describe("ProviderGroupHeader — other providers are unchanged", () => {
    it("shows the masked key, edits the provider, and never asks for the plan status", () => {
        mockStatus.mockReturnValue({ data: undefined, isLoading: false });
        renderHeader(credential({ provider: "openai", apiKey: "sk-••••abcd" }));

        expect(screen.getByText(/••••/)).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Edit provider" }),
        ).toBeInTheDocument();
        expect(mockStatus).toHaveBeenCalledWith(false);
    });
});
