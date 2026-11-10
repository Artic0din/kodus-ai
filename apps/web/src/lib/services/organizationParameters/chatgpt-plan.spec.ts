import {
    completeChatGptPlanSignIn,
    getChatGptPlanStatus,
    signOutChatGptPlan,
    startChatGptPlanSignIn,
} from "./chatgpt-plan";

const post = jest.fn();
const fetcher = jest.fn();
jest.mock("src/core/utils/axios", () => ({
    axiosAuthorized: {
        post: (...a: unknown[]) => post(...a),
        fetcher: (...a: unknown[]) => fetcher(...a),
    },
}));

jest.mock(".", () => ({
    ORGANIZATION_PARAMETERS_PATHS: {
        CHATGPT_PLAN_STATUS: "/organization-parameters/chatgpt-plan/status",
        CHATGPT_PLAN_SIGN_IN_START:
            "/organization-parameters/chatgpt-plan/sign-in/start",
        CHATGPT_PLAN_SIGN_IN_COMPLETE:
            "/organization-parameters/chatgpt-plan/sign-in/complete",
        CHATGPT_PLAN_SIGN_OUT: "/organization-parameters/chatgpt-plan/sign-out",
    },
}));

afterEach(() => jest.clearAllMocks());

describe("ChatGPT plan service calls", () => {
    it("reads the status and unwraps the API envelope", async () => {
        fetcher.mockResolvedValue({
            data: { status: "connected", email: "owner@example.com" },
        });
        await expect(getChatGptPlanStatus()).resolves.toEqual({
            status: "connected",
            email: "owner@example.com",
        });
        expect(fetcher).toHaveBeenCalledWith(
            "/organization-parameters/chatgpt-plan/status",
        );
    });

    it("starts a sign-in, passing only the account choice", async () => {
        post.mockResolvedValue({
            data: { authorizeUrl: "https://auth.openai.com/x", expiresAt: 5 },
        });
        await expect(
            startChatGptPlanSignIn({ differentAccount: true }),
        ).resolves.toEqual({
            authorizeUrl: "https://auth.openai.com/x",
            expiresAt: 5,
        });
        expect(post).toHaveBeenCalledWith(
            "/organization-parameters/chatgpt-plan/sign-in/start",
            { differentAccount: true },
        );
    });

    it("completes a sign-in with the pasted address in the body, never the URL", async () => {
        post.mockResolvedValue({
            data: { outcome: "connected", status: "connected" },
        });
        const callbackUrl =
            "http://127.0.0.1:1455/auth/callback?code=c&state=s";
        await completeChatGptPlanSignIn({ callbackUrl });

        const [url, body] = post.mock.calls[0];
        expect(url).toBe(
            "/organization-parameters/chatgpt-plan/sign-in/complete",
        );
        expect(url).not.toContain("code=");
        expect(body).toEqual({ callbackUrl });
    });

    it("signs out and reports whether OpenAI confirmed", async () => {
        post.mockResolvedValue({
            data: { status: "reauth_required", revocationConfirmed: false },
        });
        await expect(signOutChatGptPlan()).resolves.toEqual({
            status: "reauth_required",
            revocationConfirmed: false,
        });
        expect(post).toHaveBeenCalledWith(
            "/organization-parameters/chatgpt-plan/sign-out",
            {},
        );
    });
});
