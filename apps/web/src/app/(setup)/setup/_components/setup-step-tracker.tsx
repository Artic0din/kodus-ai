"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { setCookie } from "cookies-next/client";
import { useAuth } from "src/core/providers/auth.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { getStepByPath } from "../_config/setup-steps";

export const SETUP_LAST_STEP_PREFIX = "setup-last-step";

// Scoped per team: a user setting up an additional team must not resume the
// steps they reached for another team.
export const getSetupCookieName = (userId: string, teamId: string) =>
    `${SETUP_LAST_STEP_PREFIX}-${userId}-${teamId}`;

export const SetupProgressSaver = () => {
    const pathname = usePathname();
    const { userId } = useAuth();
    const { teamId } = useSelectedTeamId();

    useEffect(() => {
        if (!userId || !teamId) return;

        const matchedStep = getStepByPath(pathname);

        if (matchedStep) {
            setCookie(getSetupCookieName(userId, teamId), matchedStep.path, {
                expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
            });
        }
    }, [pathname, userId, teamId]);

    return null;
};
