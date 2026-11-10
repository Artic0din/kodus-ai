/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen } from "@testing-library/react";

import { ConnectProviderFlow } from "./connect-provider-flow";

const push = jest.fn();
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push, replace: jest.fn() }),
}));
jest.mock("@services/organizationParameters/fetch", () => ({
    listByokProviders: jest.fn().mockResolvedValue([
        { id: "openai", label: "OpenAI", aliases: [], autoListModels: true },
        {
            id: "chatgpt_plan",
            label: "ChatGPT plan",
            aliases: [],
            autoListModels: false,
        },
    ]),
}));

describe("ConnectProviderFlow — ChatGPT plan card", () => {
    beforeEach(() => push.mockClear());

    it("is a keyless provider card that says to sign in, not to add an endpoint", async () => {
        render(<ConnectProviderFlow />);
        const card = (await screen.findByText("ChatGPT plan")).closest(
            "button",
        )!;

        expect(card).toHaveTextContent("No API key · sign in with ChatGPT");
        expect(card).not.toHaveTextContent(/custom endpoint/i);
    });

    it("sits with the providers, not under Custom, and opens its form", async () => {
        render(<ConnectProviderFlow />);
        const card = (await screen.findByText("ChatGPT plan")).closest(
            "button",
        )!;

        // "Providers" heading comes before the card; no "Custom" group exists.
        expect(screen.getByText("Providers")).toBeInTheDocument();
        expect(screen.queryByText("Custom")).not.toBeInTheDocument();

        fireEvent.click(card);
        expect(push).toHaveBeenCalledWith("/byok/manual?provider=chatgpt_plan");
    });

    it("reads Connected once the org has the credential", async () => {
        render(
            <ConnectProviderFlow
                existingKeyByProvider={{ chatgpt_plan: "••••" }}
                connectedModelCountByProvider={{ chatgpt_plan: 2 }}
            />,
        );
        const card = (await screen.findByText("ChatGPT plan")).closest(
            "button",
        )!;
        expect(card).toHaveTextContent(/Connected\s*·\s*2 models/);
        expect(card).not.toHaveTextContent(/sign in with chatgpt/i);
    });
});
