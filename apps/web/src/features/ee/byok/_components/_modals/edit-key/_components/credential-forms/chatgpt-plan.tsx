"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription } from "@components/ui/alert";
import { Button } from "@components/ui/button";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { Skeleton } from "@components/ui/skeleton";
import { toast } from "@components/ui/toaster/use-toast";
import {
    CHATGPT_PLAN_STATUS_QUERY_KEY,
    completeChatGptPlanSignIn,
    signOutChatGptPlan,
    startChatGptPlanSignIn,
    useChatGptPlanStatus,
} from "@services/organizationParameters/chatgpt-plan";
import { useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import {
    AlertTriangleIcon,
    CheckCircle2Icon,
    ExternalLinkIcon,
    InfoIcon,
    LogOutIcon,
} from "lucide-react";
import { extractRejectionMessage } from "src/core/utils/extract-error-message";

import { CHATGPT_USAGE_URL } from "../../../../../_data/chatgpt-plan";

const CALLBACK_PREFIX = "http://127.0.0.1:1455/auth/callback";
const UNREACHABLE_MESSAGE = "Couldn't reach Kodus. Try again in a moment.";

/** The API's `code` for a pasted address it refused before using the attempt. */
const isRepasteable = (error: unknown): boolean =>
    isAxiosError(error) &&
    (error.response?.data as { code?: string } | undefined)?.code ===
        "callback_invalid";

type Step =
    | { kind: "idle" }
    /** The OpenAI address is open (or openable) and the admin is to paste back. */
    | { kind: "awaiting_paste"; authorizeUrl: string };

type Busy = "starting" | "completing" | "signing_out" | null;

/**
 * ChatGPT plan — sign in with the org's ChatGPT account. The server cannot
 * receive OpenAI's 127.0.0.1 callback, so the admin pastes the address the
 * browser lands on. Nothing here is stored: tokens live on the server.
 */
export const ChatGptPlanFields = () => {
    const router = useRouter();
    const queryClient = useQueryClient();
    const {
        data: status,
        isLoading,
        isError,
        refetch,
    } = useChatGptPlanStatus();

    const [step, setStep] = useState<Step>({ kind: "idle" });
    const [callbackUrl, setCallbackUrl] = useState("");
    const [busy, setBusy] = useState<Busy>(null);
    const [error, setError] = useState<string | null>(null);
    const [planNotGranted, setPlanNotGranted] = useState(false);
    const [revocationUnconfirmed, setRevocationUnconfirmed] = useState(false);

    /** Everything on screen that depends on the connection reads it again. */
    const refreshConnectionData = async () => {
        await Promise.all([
            queryClient.invalidateQueries({
                queryKey: CHATGPT_PLAN_STATUS_QUERY_KEY,
            }),
            queryClient.invalidateQueries({
                queryKey: ["byok-provider-models-preview"],
            }),
        ]);
        router.refresh();
    };

    const startSignIn = async (differentAccount: boolean) => {
        setBusy("starting");
        setError(null);
        setPlanNotGranted(false);
        setRevocationUnconfirmed(false);
        try {
            const { authorizeUrl } = await startChatGptPlanSignIn({
                differentAccount,
            });
            window.open(authorizeUrl, "_blank", "noopener,noreferrer");
            setCallbackUrl("");
            setStep({ kind: "awaiting_paste", authorizeUrl });
        } catch (e) {
            setError(extractRejectionMessage(e) ?? UNREACHABLE_MESSAGE);
        } finally {
            setBusy(null);
        }
    };

    const completeSignIn = async () => {
        setBusy("completing");
        setError(null);
        try {
            const result = await completeChatGptPlanSignIn({
                callbackUrl: callbackUrl.trim(),
            });
            setCallbackUrl("");
            setStep({ kind: "idle" });
            if (result.outcome === "plan_not_granted") {
                setPlanNotGranted(true);
            } else {
                toast({
                    variant: "success",
                    title: result.email
                        ? `Connected as ${result.email}`
                        : "ChatGPT connected",
                });
            }
            await refreshConnectionData();
        } catch (e) {
            setError(extractRejectionMessage(e) ?? UNREACHABLE_MESSAGE);
            // A malformed address is refused before the attempt is used, so the
            // admin can paste again. Any other failure consumed the attempt: ask
            // for a fresh sign-in instead.
            if (!isRepasteable(e)) {
                setCallbackUrl("");
                setStep({ kind: "idle" });
            }
        } finally {
            setBusy(null);
        }
    };

    const signOut = async () => {
        setBusy("signing_out");
        setError(null);
        setPlanNotGranted(false);
        try {
            const result = await signOutChatGptPlan();
            setRevocationUnconfirmed(!result.revocationConfirmed);
            toast({ variant: "success", title: "Signed out of ChatGPT" });
            await refreshConnectionData();
        } catch (e) {
            setError(extractRejectionMessage(e) ?? UNREACHABLE_MESSAGE);
        } finally {
            setBusy(null);
        }
    };

    const working = busy !== null;
    const pastedLooksRight = callbackUrl.trim().startsWith(CALLBACK_PREFIX);

    if (isLoading) return <Skeleton className="h-10" />;

    if (isError || !status) {
        return (
            <Alert
                variant="danger"
                className="flex items-start justify-between gap-6">
                <span className="text-sm">
                    Couldn&apos;t load the ChatGPT connection.
                </span>
                <Button
                    type="button"
                    variant="tertiary"
                    size="xs"
                    onClick={() => {
                        refetch();
                    }}>
                    Try again
                </Button>
            </Alert>
        );
    }

    const connected = status.status === "connected";
    const needsSignIn = status.status === "reauth_required";
    const notEligible = status.status === "not_eligible";

    return (
        <div className="flex flex-col gap-4">
            {connected ? (
                <div className="flex flex-col gap-1">
                    <p className="text-success flex items-center gap-2 text-sm font-medium">
                        <CheckCircle2Icon className="size-4 shrink-0" />
                        {status.email
                            ? `Connected as ${status.email}`
                            : "Connected"}
                    </p>
                    <p className="text-text-secondary text-xs text-pretty">
                        Every team in this organisation reviews on this ChatGPT
                        plan, and its usage limits apply.
                    </p>
                </div>
            ) : (
                <p className="text-text-secondary text-sm text-pretty">
                    {needsSignIn
                        ? `ChatGPT needs you to sign in again${status.email ? ` (last connected as ${status.email})` : ""}.`
                        : notEligible
                          ? "This ChatGPT account can't share its plan."
                          : "Sign in with the ChatGPT account whose plan should pay for reviews."}
                </p>
            )}

            {planNotGranted && (
                <Alert variant="warning">
                    <AlertTriangleIcon />
                    <AlertDescription className="text-pretty">
                        ChatGPT signed you in but did not allow Kodus to use the
                        plan. Sign in again and approve plan use when asked.
                    </AlertDescription>
                </Alert>
            )}

            {revocationUnconfirmed && (
                <Alert variant="warning">
                    <AlertTriangleIcon />
                    <AlertDescription className="text-pretty">
                        Signed out here, but ChatGPT did not confirm the session
                        ended. Disconnect Kodus under{" "}
                        <a
                            href={CHATGPT_USAGE_URL}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary-light underline">
                            ChatGPT usage settings
                        </a>{" "}
                        to be sure.
                    </AlertDescription>
                </Alert>
            )}

            {error && (
                <Alert variant="danger" role="alert">
                    <AlertDescription className="text-pretty">
                        {error}
                    </AlertDescription>
                </Alert>
            )}

            {step.kind === "awaiting_paste" ? (
                <div className="flex flex-col gap-3">
                    <Alert variant="info">
                        <InfoIcon />
                        <AlertDescription className="text-pretty">
                            Sign in to ChatGPT in the tab that opened. When it
                            ends on a page that won&apos;t load at{" "}
                            <code className="bg-card-lv2 rounded px-1 py-0.5 font-mono text-[11px]">
                                127.0.0.1:1455
                            </code>
                            , that is expected: copy the full address from the
                            address bar and paste it below.{" "}
                            <a
                                href={step.authorizeUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-primary-light underline">
                                Open the sign-in tab again
                            </a>
                            .
                        </AlertDescription>
                    </Alert>
                    <FormControl.Root>
                        <FormControl.Label htmlFor="chatgpt-callback-url">
                            Address from the browser
                        </FormControl.Label>
                        <FormControl.Input>
                            <Input
                                id="chatgpt-callback-url"
                                size="md"
                                value={callbackUrl}
                                autoComplete="off"
                                spellCheck={false}
                                onChange={(e) => setCallbackUrl(e.target.value)}
                                placeholder={`${CALLBACK_PREFIX}?code=…`}
                            />
                        </FormControl.Input>
                        {callbackUrl.trim() && !pastedLooksRight && (
                            <FormControl.Helper>
                                The address should start with {CALLBACK_PREFIX}.
                            </FormControl.Helper>
                        )}
                    </FormControl.Root>
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            type="button"
                            size="md"
                            variant="primary"
                            loading={busy === "completing"}
                            disabled={!pastedLooksRight || working}
                            onClick={() => {
                                completeSignIn();
                            }}>
                            Finish sign-in
                        </Button>
                        <Button
                            type="button"
                            size="md"
                            variant="cancel"
                            disabled={working}
                            onClick={() => {
                                setCallbackUrl("");
                                setStep({ kind: "idle" });
                            }}>
                            Cancel
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="flex flex-wrap items-center gap-2">
                    {!connected && !notEligible && (
                        <Button
                            type="button"
                            size="md"
                            variant="primary"
                            loading={busy === "starting"}
                            disabled={working}
                            onClick={() => {
                                startSignIn(false);
                            }}>
                            {needsSignIn
                                ? "Sign in again"
                                : "Continue with ChatGPT"}
                        </Button>
                    )}
                    {(connected || needsSignIn || notEligible) && (
                        <Button
                            type="button"
                            size="md"
                            variant="helper"
                            disabled={working}
                            onClick={() => {
                                startSignIn(true);
                            }}>
                            Use a different account
                        </Button>
                    )}
                    {connected && (
                        <>
                            <a
                                href={CHATGPT_USAGE_URL}
                                target="_blank"
                                rel="noopener noreferrer">
                                <Button
                                    type="button"
                                    size="md"
                                    variant="helper"
                                    rightIcon={<ExternalLinkIcon />}>
                                    Manage usage
                                </Button>
                            </a>
                            <Button
                                type="button"
                                size="md"
                                variant="cancel"
                                leftIcon={<LogOutIcon />}
                                loading={busy === "signing_out"}
                                disabled={working}
                                onClick={() => {
                                    signOut();
                                }}>
                                Sign out
                            </Button>
                        </>
                    )}
                </div>
            )}
        </div>
    );
};
