"use client";

import { redirect } from "next/navigation";
import { getCookie } from "cookies-next/client";
import { useAuth } from "src/core/providers/auth.provider";
import { useSelectedTeamId } from "src/core/providers/selected-team-context";

import { getSetupCookieName } from "./_components/setup-step-tracker";
import { getStepByPath, SETUP_STEPS } from "./_config/setup-steps";

export default function Setup() {
    const { userId } = useAuth();
    const { teamId } = useSelectedTeamId();

    if (userId === undefined) {
        return null;
    }

    if (userId && teamId) {
        const lastStep = getCookie(getSetupCookieName(userId, teamId)) as
            string | undefined;
        const isValidLastStep = lastStep && getStepByPath(lastStep);

        if (isValidLastStep) {
            redirect(lastStep);
        }
    }

    redirect(SETUP_STEPS[0].path);
}
