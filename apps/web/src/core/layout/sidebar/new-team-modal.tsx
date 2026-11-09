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
import { zodResolver } from "@hookform/resolvers/zod";
import { createTeam } from "@services/teams/fetch";
import type { Team } from "@services/teams/types";
import { AxiosError } from "axios";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

const TEAM_NAME_MAX_LENGTH = 100;

const newTeamSchema = z.object({
    teamName: z.string().trim().min(1).max(TEAM_NAME_MAX_LENGTH),
});

type NewTeamForm = z.infer<typeof newTeamSchema>;

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
    const {
        control,
        handleSubmit,
        setError,
        formState: { errors, isSubmitting, isValid },
    } = useForm<NewTeamForm>({
        mode: "onChange",
        resolver: zodResolver(newTeamSchema),
        defaultValues: { teamName: "" },
    });

    const submit = async ({ teamName }: NewTeamForm) => {
        magicModal.lock();

        try {
            const { data } = await createTeam(teamName);
            magicModal.hide();
            onCreated(data);
        } catch (e) {
            magicModal.unlock();
            setError("teamName", { message: errorMessage(e) });
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
                    onSubmit={handleSubmit(submit)}>
                    <Controller
                        name="teamName"
                        control={control}
                        render={({ field }) => (
                            <FormControl.Root>
                                <FormControl.Label htmlFor="new-team-name-input">
                                    Team name
                                </FormControl.Label>
                                <FormControl.Input>
                                    <Input
                                        {...field}
                                        id="new-team-name-input"
                                        autoFocus
                                        maxLength={TEAM_NAME_MAX_LENGTH}
                                        error={errors.teamName?.message}
                                    />
                                </FormControl.Input>
                                <FormControl.Error>
                                    {errors.teamName?.message}
                                </FormControl.Error>
                            </FormControl.Root>
                        )}
                    />

                    <DialogFooter>
                        <Button
                            type="submit"
                            size="md"
                            variant="primary"
                            loading={isSubmitting}
                            disabled={!isValid}>
                            Create team
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
};
