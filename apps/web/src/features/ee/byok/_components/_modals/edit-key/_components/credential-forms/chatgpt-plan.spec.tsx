/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { AxiosError } from "axios";

import { ChatGptPlanFields } from "./chatgpt-plan";

const refresh = jest.fn();
jest.mock("next/navigation", () => ({
    useRouter: () => ({ refresh }),
}));

const toast = jest.fn();
jest.mock("@components/ui/toaster/use-toast", () => ({
    toast: (...args: unknown[]) => toast(...args),
}));

const mockStatus = jest.fn();
const startSignIn = jest.fn();
const completeSignIn = jest.fn();
const signOut = jest.fn();
jest.mock("@services/organizationParameters/chatgpt-plan", () => ({
    CHATGPT_PLAN_STATUS_QUERY_KEY: ["chatgpt-plan-status"],
    useChatGptPlanStatus: () => mockStatus(),
    startChatGptPlanSignIn: (...a: unknown[]) => startSignIn(...a),
    completeChatGptPlanSignIn: (...a: unknown[]) => completeSignIn(...a),
    signOutChatGptPlan: (...a: unknown[]) => signOut(...a),
}));

const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize?state=s";
const CALLBACK = "http://127.0.0.1:1455/auth/callback?code=c&state=s";

const withStatus = (data: unknown, extra: Record<string, unknown> = {}) =>
    mockStatus.mockReturnValue({
        data,
        isLoading: false,
        isError: false,
        refetch: jest.fn(),
        ...extra,
    });

function setup() {
    const client = new QueryClient();
    const invalidate = jest.spyOn(client, "invalidateQueries");
    render(
        <QueryClientProvider client={client}>
            <ChatGptPlanFields />
        </QueryClientProvider>,
    );
    return { invalidate };
}

const click = async (name: RegExp | string) => {
    await act(async () => {
        fireEvent.click(screen.getByRole("button", { name }));
    });
};

const paste = (value: string) =>
    fireEvent.change(screen.getByLabelText(/address from the browser/i), {
        target: { value },
    });

const rejection = (status: number, message: string, code?: string) =>
    new AxiosError("failed", String(status), undefined, undefined, {
        status,
        data: { message, code },
    } as never);

let open: jest.SpyInstance;
beforeEach(() => {
    jest.clearAllMocks();
    open = jest.spyOn(window, "open").mockImplementation(() => null);
    startSignIn.mockResolvedValue({
        authorizeUrl: AUTHORIZE_URL,
        expiresAt: 1,
    });
    completeSignIn.mockResolvedValue({
        outcome: "connected",
        status: "connected",
        email: "owner@example.com",
    });
    signOut.mockResolvedValue({
        status: "reauth_required",
        revocationConfirmed: true,
    });
});
afterEach(() => open.mockRestore());

describe("ChatGptPlanFields — status", () => {
    it("shows a placeholder while the connection loads, and no actions", () => {
        mockStatus.mockReturnValue({ data: undefined, isLoading: true });
        setup();
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("offers a retry when the status cannot be read", () => {
        const refetch = jest.fn();
        mockStatus.mockReturnValue({
            data: undefined,
            isLoading: false,
            isError: true,
            refetch,
        });
        setup();
        expect(
            screen.getByText(/couldn't load the chatgpt connection/i),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: /try again/i }));
        expect(refetch).toHaveBeenCalled();
    });

    it("not connected: only Continue with ChatGPT", () => {
        withStatus({ status: "not_connected" });
        setup();
        expect(
            screen.getByRole("button", { name: "Continue with ChatGPT" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /sign out/i }),
        ).not.toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /different account/i }),
        ).not.toBeInTheDocument();
    });

    it("connected: names the account and offers switch, usage and sign out", () => {
        withStatus({ status: "connected", email: "owner@example.com" });
        setup();
        expect(
            screen.getByText("Connected as owner@example.com"),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Use a different account" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Sign out" }),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: "Continue with ChatGPT" }),
        ).not.toBeInTheDocument();
        const usage = screen.getByRole("link", { name: /manage usage/i });
        expect(usage).toHaveAttribute(
            "href",
            "https://chatgpt.com/settings/usage",
        );
        expect(usage).toHaveAttribute("target", "_blank");
        expect(usage).toHaveAttribute(
            "rel",
            expect.stringContaining("noopener"),
        );
    });

    it("connected without an email still says connected", () => {
        withStatus({ status: "connected" });
        setup();
        expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    it("needs sign-in: Sign in again, and a way to switch account", () => {
        withStatus({ status: "reauth_required", email: "owner@example.com" });
        setup();
        expect(
            screen.getByRole("button", { name: "Sign in again" }),
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Use a different account" }),
        ).toBeInTheDocument();
        expect(
            screen.getByText(/last connected as owner@example.com/i),
        ).toBeInTheDocument();
        expect(
            screen.queryByRole("button", { name: /sign out/i }),
        ).not.toBeInTheDocument();
    });

    it("not eligible: no sign-in loop, only a different account", () => {
        withStatus({ status: "not_eligible" });
        setup();
        expect(screen.getByText(/can't share its plan/i)).toBeInTheDocument();
        expect(
            screen.queryByRole("button", {
                name: /continue with chatgpt|sign in again/i,
            }),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Use a different account" }),
        ).toBeInTheDocument();
    });
});

describe("ChatGptPlanFields — sign in", () => {
    it("opens the OpenAI address in a new tab and asks for the pasted address", async () => {
        withStatus({ status: "not_connected" });
        setup();
        await click("Continue with ChatGPT");

        expect(startSignIn).toHaveBeenCalledWith({ differentAccount: false });
        expect(open).toHaveBeenCalledWith(
            AUTHORIZE_URL,
            "_blank",
            "noopener,noreferrer",
        );
        expect(
            screen.getByLabelText(/address from the browser/i),
        ).toBeInTheDocument();
        const again = screen.getByRole("link", {
            name: /open the sign-in tab again/i,
        });
        expect(again).toHaveAttribute("href", AUTHORIZE_URL);
        expect(again).toHaveAttribute("target", "_blank");
    });

    it("keeps Finish sign-in disabled until the address looks right", async () => {
        withStatus({ status: "not_connected" });
        setup();
        await click("Continue with ChatGPT");

        const finish = screen.getByRole("button", { name: "Finish sign-in" });
        expect(finish).toBeDisabled();
        paste("https://example.com/auth/callback?code=c&state=s");
        expect(finish).toBeDisabled();
        expect(
            screen.getByText(/should start with http:\/\/127\.0\.0\.1:1455/i),
        ).toBeInTheDocument();
        paste(`  ${CALLBACK}  `);
        expect(finish).toBeEnabled();
    });

    it("sends the pasted address, then refreshes status, models and page data", async () => {
        withStatus({ status: "not_connected" });
        const { invalidate } = setup();
        await click("Continue with ChatGPT");
        paste(`  ${CALLBACK}  `);
        await click("Finish sign-in");

        expect(completeSignIn).toHaveBeenCalledWith({ callbackUrl: CALLBACK });
        await waitFor(() => expect(refresh).toHaveBeenCalled());
        const keys = invalidate.mock.calls.map(
            (c) => (c[0] as { queryKey: unknown[] }).queryKey,
        );
        expect(keys).toContainEqual(["chatgpt-plan-status"]);
        expect(keys).toContainEqual(["byok-provider-models-preview"]);
        expect(toast).toHaveBeenCalledWith(
            expect.objectContaining({
                variant: "success",
                title: "Connected as owner@example.com",
            }),
        );
        // The pasted address does not linger on screen.
        expect(
            screen.queryByLabelText(/address from the browser/i),
        ).not.toBeInTheDocument();
    });

    it("shows the server's reason, drops the dead address and returns to the start", async () => {
        withStatus({ status: "not_connected" });
        setup();
        completeSignIn.mockRejectedValue(
            rejection(
                400,
                "This sign-in expired after 10 minutes. Start again.",
            ),
        );
        await click("Continue with ChatGPT");
        paste(CALLBACK);
        await click("Finish sign-in");

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "This sign-in expired after 10 minutes. Start again.",
        );
        expect(
            screen.queryByLabelText(/address from the browser/i),
        ).not.toBeInTheDocument();
        expect(
            screen.getByRole("button", { name: "Continue with ChatGPT" }),
        ).toBeInTheDocument();
        expect(refresh).not.toHaveBeenCalled();
        expect(screen.queryByDisplayValue(CALLBACK)).not.toBeInTheDocument();
    });

    it("keeps the paste field when the address itself was refused", async () => {
        withStatus({ status: "not_connected" });
        setup();
        completeSignIn.mockRejectedValue(
            rejection(
                400,
                "Paste the full address the browser landed on.",
                "callback_invalid",
            ),
        );
        await click("Continue with ChatGPT");
        paste(CALLBACK);
        await click("Finish sign-in");

        expect(
            await screen.findByText(
                /paste the full address the browser landed on/i,
            ),
        ).toBeInTheDocument();
        expect(screen.getByLabelText(/address from the browser/i)).toHaveValue(
            CALLBACK,
        );
    });

    it("falls back to a plain message when the API cannot be reached", async () => {
        withStatus({ status: "not_connected" });
        setup();
        startSignIn.mockRejectedValue(new Error("Network Error"));
        await click("Continue with ChatGPT");
        expect(await screen.findByRole("alert")).toHaveTextContent(
            /couldn't reach kodus/i,
        );
        expect(open).not.toHaveBeenCalled();
    });

    it("warns when ChatGPT did not allow plan use, without a success toast", async () => {
        withStatus({ status: "not_connected" });
        setup();
        completeSignIn.mockResolvedValue({
            outcome: "plan_not_granted",
            status: "reauth_required",
            email: "owner@example.com",
        });
        await click("Continue with ChatGPT");
        paste(CALLBACK);
        await click("Finish sign-in");

        expect(
            await screen.findByText(/did not allow kodus to use the plan/i),
        ).toBeInTheDocument();
        expect(toast).not.toHaveBeenCalled();
        expect(refresh).toHaveBeenCalled();
    });

    it("cancel returns to the start without calling the API again", async () => {
        withStatus({ status: "not_connected" });
        setup();
        await click("Continue with ChatGPT");
        paste(CALLBACK);
        await click("Cancel");

        expect(
            screen.getByRole("button", { name: "Continue with ChatGPT" }),
        ).toBeInTheDocument();
        expect(completeSignIn).not.toHaveBeenCalled();
    });
});

describe("ChatGptPlanFields — switch account and sign out", () => {
    it("Use a different account starts a new registration", async () => {
        withStatus({ status: "connected", email: "owner@example.com" });
        setup();
        await click("Use a different account");
        expect(startSignIn).toHaveBeenCalledWith({ differentAccount: true });
        expect(
            screen.getByLabelText(/address from the browser/i),
        ).toBeInTheDocument();
    });

    it("Sign in again reuses the registration", async () => {
        withStatus({ status: "reauth_required", email: "owner@example.com" });
        setup();
        await click("Sign in again");
        expect(startSignIn).toHaveBeenCalledWith({ differentAccount: false });
    });

    it("Sign out refreshes status, models and page data", async () => {
        withStatus({ status: "connected", email: "owner@example.com" });
        const { invalidate } = setup();
        await click("Sign out");

        expect(signOut).toHaveBeenCalled();
        await waitFor(() => expect(refresh).toHaveBeenCalled());
        const keys = invalidate.mock.calls.map(
            (c) => (c[0] as { queryKey: unknown[] }).queryKey,
        );
        expect(keys).toContainEqual(["chatgpt-plan-status"]);
        expect(keys).toContainEqual(["byok-provider-models-preview"]);
        expect(screen.queryByText(/did not confirm/i)).not.toBeInTheDocument();
    });

    it("says so when OpenAI did not confirm the revocation", async () => {
        withStatus({ status: "connected", email: "owner@example.com" });
        setup();
        signOut.mockResolvedValue({
            status: "reauth_required",
            revocationConfirmed: false,
        });
        await click("Sign out");
        expect(
            await screen.findByText(/did not confirm the session ended/i),
        ).toBeInTheDocument();
    });

    it("shows why a sign-out failed and leaves the state alone", async () => {
        withStatus({ status: "connected", email: "owner@example.com" });
        setup();
        signOut.mockRejectedValue(new Error("Network Error"));
        await click("Sign out");
        expect(await screen.findByRole("alert")).toHaveTextContent(
            /couldn't reach kodus/i,
        );
        expect(refresh).not.toHaveBeenCalled();
    });
});

describe("ChatGptPlanFields — it is a form control, not a form", () => {
    it("every button is type=button so it never submits the model form", () => {
        withStatus({ status: "connected", email: "owner@example.com" });
        setup();
        for (const button of screen.getAllByRole("button")) {
            expect(button).toHaveAttribute("type", "button");
        }
    });
});
