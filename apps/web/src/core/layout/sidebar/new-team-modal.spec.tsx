/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AxiosError } from "axios";

import { NewTeamModal } from "./new-team-modal";

const createTeam = jest.fn();
jest.mock("@services/teams/fetch", () => ({
    createTeam: (...args: unknown[]) => createTeam(...args),
}));

const hide = jest.fn();
jest.mock("@components/ui/magic-modal", () => ({
    ...jest.requireActual("@components/ui/magic-modal"),
    magicModal: { hide: () => hide(), lock: jest.fn(), unlock: jest.fn() },
}));

const created = { uuid: "team-2", name: "Plaintext-Lab", status: "active" };

const submitName = async (name: string) => {
    fireEvent.change(screen.getByLabelText("Team name"), {
        target: { value: name },
    });
    const button = screen.getByRole("button", { name: "Create team" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
};

beforeEach(() => {
    createTeam.mockReset();
    hide.mockReset();
});

describe("NewTeamModal", () => {
    it("keeps Create team disabled until a name is typed", async () => {
        render(<NewTeamModal onCreated={jest.fn()} />);

        const button = screen.getByRole("button", { name: "Create team" });
        expect(button).toBeDisabled();

        fireEvent.change(screen.getByLabelText("Team name"), {
            target: { value: "   " },
        });
        await waitFor(() => expect(button).toBeDisabled());
    });

    it("creates the team with the trimmed name, closes, and reports it", async () => {
        createTeam.mockResolvedValue({ data: created });
        const onCreated = jest.fn();
        render(<NewTeamModal onCreated={onCreated} />);

        await submitName("  Plaintext-Lab  ");

        await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
        expect(createTeam).toHaveBeenCalledWith("Plaintext-Lab");
        expect(hide).toHaveBeenCalled();
    });

    it("shows a duplicate-name error and stays open", async () => {
        createTeam.mockRejectedValue(
            new AxiosError("conflict", "ERR_BAD_REQUEST", undefined, null, {
                status: 409,
            } as never),
        );
        const onCreated = jest.fn();
        render(<NewTeamModal onCreated={onCreated} />);

        await submitName("Plaintext-Lab");

        expect(
            await screen.findByText("A team with this name already exists"),
        ).toBeInTheDocument();
        expect(onCreated).not.toHaveBeenCalled();
        expect(hide).not.toHaveBeenCalled();
    });

    it("shows a generic error for other failures", async () => {
        createTeam.mockRejectedValue(new Error("network"));
        render(<NewTeamModal onCreated={jest.fn()} />);

        await submitName("Plaintext-Lab");

        expect(
            await screen.findByText("Could not create the team. Try again."),
        ).toBeInTheDocument();
    });
});
