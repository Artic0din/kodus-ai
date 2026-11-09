import { useState } from "react";
import { Button } from "@components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@components/ui/dialog";
import { FormControl } from "@components/ui/form-control";
import { Input } from "@components/ui/input";
import { magicModal } from "@components/ui/magic-modal";
import { createTeam } from "@services/teams/fetch";
import type { Team } from "@services/teams/types";
import { AxiosError } from "axios";

const TEAM_NAME_MAX_LENGTH = 100;

const errorMessage = (error: unknown) => {
    if (error instanceof AxiosError && error.response?.status === 409) {
        return "A team with this name already exists";
    }
    return "Could not create the team. Try again.";
};

export const NewTeamModal = ({
    onCreated,
}: {
    onCreated: (team: Team) => void;
}) => {
    const [teamName, setTeamName] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const submit = async () => {
        setLoading(true);
        magicModal.lock();

        try {
            const { data } = await createTeam(teamName.trim());
            magicModal.hide();
            onCreated(data);
        } catch (e) {
            magicModal.unlock();
            setError(errorMessage(e));
        } finally {
            setLoading(false);
        }
    };

    return (
        <Dialog open onOpenChange={() => magicModal.hide()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>New team</DialogTitle>
                </DialogHeader>

                <form
                    className="flex flex-col gap-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (teamName.trim() && !loading) submit();
                    }}>
                    <FormControl.Root>
                        <FormControl.Label htmlFor="new-team-name-input">
                            Team name
                        </FormControl.Label>
                        <FormControl.Input>
                            <Input
                                id="new-team-name-input"
                                autoFocus
                                value={teamName}
                                maxLength={TEAM_NAME_MAX_LENGTH}
                                error={error}
                                onChange={(e) => {
                                    setTeamName(e.target.value);
                                    setError("");
                                }}
                            />
                        </FormControl.Input>
                        <FormControl.Error>{error}</FormControl.Error>
                    </FormControl.Root>

                    <DialogFooter>
                        <Button
                            type="submit"
                            size="md"
                            variant="primary"
                            loading={loading}
                            disabled={!teamName.trim()}>
                            Create team
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};
