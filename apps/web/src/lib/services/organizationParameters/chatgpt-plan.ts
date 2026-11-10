import { useQuery } from "@tanstack/react-query";
import { axiosAuthorized } from "src/core/utils/axios";

import { ORGANIZATION_PARAMETERS_PATHS } from ".";

/*
 * Client-side calls for the org's ChatGPT plan sign-in. Kept out of `fetch.ts`
 * on purpose: that file pulls the server fetch stack (next-auth), and the BYOK
 * credential-forms registry imports this module, so it has to stay light.
 */
export type ChatGptPlanConnectionStatus =
    "not_connected" | "connected" | "reauth_required" | "not_eligible";

export type ChatGptPlanStatus = {
    status: ChatGptPlanConnectionStatus;
    email?: string;
};

export type ChatGptPlanSignInResult = ChatGptPlanStatus & {
    /** `plan_not_granted`: signed in, but OpenAI did not grant plan use. The
     *  next sign-in asks for consent again. */
    outcome: "connected" | "plan_not_granted";
};

export const getChatGptPlanStatus = async (): Promise<ChatGptPlanStatus> => {
    const envelope = await axiosAuthorized.fetcher<{ data: ChatGptPlanStatus }>(
        ORGANIZATION_PARAMETERS_PATHS.CHATGPT_PLAN_STATUS,
    );
    return envelope.data;
};

/** Starts a sign-in; `authorizeUrl` is the OpenAI address to open in a new tab. */
export const startChatGptPlanSignIn = async (params: {
    differentAccount?: boolean;
}): Promise<{ authorizeUrl: string; expiresAt: number }> => {
    const envelope = await axiosAuthorized.post<{
        data: { authorizeUrl: string; expiresAt: number };
    }>(ORGANIZATION_PARAMETERS_PATHS.CHATGPT_PLAN_SIGN_IN_START, params);
    return envelope.data;
};

/** `callbackUrl` is the address the browser landed on, pasted by the admin. A
 *  rejected sign-in is a 4xx whose `message` names the fix. */
export const completeChatGptPlanSignIn = async (params: {
    callbackUrl: string;
}): Promise<ChatGptPlanSignInResult> => {
    const envelope = await axiosAuthorized.post<{
        data: ChatGptPlanSignInResult;
    }>(ORGANIZATION_PARAMETERS_PATHS.CHATGPT_PLAN_SIGN_IN_COMPLETE, params);
    return envelope.data;
};

export const signOutChatGptPlan = async (): Promise<
    ChatGptPlanStatus & { revocationConfirmed: boolean }
> => {
    const envelope = await axiosAuthorized.post<{
        data: ChatGptPlanStatus & { revocationConfirmed: boolean };
    }>(ORGANIZATION_PARAMETERS_PATHS.CHATGPT_PLAN_SIGN_OUT, {});
    return envelope.data;
};

export const CHATGPT_PLAN_STATUS_QUERY_KEY = ["chatgpt-plan-status"] as const;

/** The org's ChatGPT plan connection. Non-suspense so the BYOK screens render
 *  while it loads. `enabled` keeps other providers from asking. */
export function useChatGptPlanStatus(enabled = true) {
    return useQuery<ChatGptPlanStatus>({
        queryKey: CHATGPT_PLAN_STATUS_QUERY_KEY,
        queryFn: getChatGptPlanStatus,
        enabled,
        // A sign-in or sign-out in another tab is only seen on refocus.
        staleTime: 30 * 1000,
        retry: false,
    });
}
