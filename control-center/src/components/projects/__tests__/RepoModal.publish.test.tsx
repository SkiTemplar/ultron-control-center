// RepoModal: publicar una rama sin upstream (o un repo sin remoto) llama a
// git_publish tras confirmar y enseña el error si falla.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoModal } from "../RepoModal";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

type Remote = string | null;

function snapshot(remote: Remote) {
  return {
    state: {
      is_repo: true,
      branch: "feat/x",
      remote,
      ahead: 0,
      behind: 0,
      dirty: false,
      dirty_count: 0,
    },
    changes: [],
  };
}

function backend(remote: Remote, publish: (args: unknown) => unknown) {
  invokeMock.mockImplementation(async (cmd: string, args: unknown) => {
    if (cmd === "git_repo_snapshot") return snapshot(remote);
    if (cmd === "git_publish") return publish(args);
    return null;
  });
}

const publishCalls = () => invokeMock.mock.calls.filter(([cmd]) => cmd === "git_publish");

describe("RepoModal · publicar", () => {
  beforeEach(() => invokeMock.mockReset());

  it("con upstream no ofrece publicar", async () => {
    backend("origin/feat/x", () => "");
    render(<RepoModal path="C:/repo" onClose={() => {}} />);
    await screen.findByText("feat/x");
    expect(screen.queryByRole("button", { name: /Publicar/ })).toBeNull();
  });

  it("sin upstream pide confirmación antes de llamar a git_publish", async () => {
    backend(null, () => "Rama feat/x publicada en origin.\nbranch set up");
    render(<RepoModal path="C:/repo" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Publicar rama" }));
    expect(publishCalls()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Publicar feat/x" }));
    await screen.findByText("Rama feat/x publicada en origin.");
    expect(publishCalls()).toEqual([["git_publish", { path: "C:/repo", remoteUrl: null }]]);
  });

  it("cancelar no publica", async () => {
    backend(null, () => "");
    render(<RepoModal path="C:/repo" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Publicar rama" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("button", { name: "Publicar feat/x" })).toBeNull();
    expect(publishCalls()).toHaveLength(0);
  });

  it("envía la URL escrita y enseña el error del backend sin cerrar la confirmación", async () => {
    backend(null, () => {
      throw "el repositorio no tiene remoto: indica la URL para crear origin";
    });
    render(<RepoModal path="C:/repo" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Publicar rama" }));
    fireEvent.change(screen.getByLabelText("URL del remoto (opcional)"), {
      target: { value: "  https://example.com/r.git  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Publicar feat/x" }));
    await screen.findByText(/no tiene remoto/);
    expect(publishCalls()).toEqual([
      ["git_publish", { path: "C:/repo", remoteUrl: "https://example.com/r.git" }],
    ]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Publicar feat/x" })).not.toBeDisabled(),
    );
  });
});
