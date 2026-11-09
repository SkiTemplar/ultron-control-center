// «Proyectos recientes» abre el proyecto de la fila, no solo la lista de Projects.

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { RecentProjectsCard } from "../RecentProjectsCard";

const PROJECTS = [
  { id: "cc", name: "Control Center", path: "/p/cc", last_active: new Date().toISOString() },
  { id: "tfg", name: "TFG", path: "/p/tfg", last_active: new Date(Date.now() - 86_400_000).toISOString() },
];

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue(PROJECTS);
});

describe("RecentProjectsCard", () => {
  it("un clic en la fila abre ese proyecto", async () => {
    const onOpenProject = vi.fn();
    const onOpenProjects = vi.fn();
    render(<RecentProjectsCard onOpenProject={onOpenProject} onOpenProjects={onOpenProjects} />);
    fireEvent.click(await screen.findByText("TFG"));
    expect(onOpenProject).toHaveBeenCalledWith({ id: "tfg", name: "TFG" });
    expect(onOpenProjects).not.toHaveBeenCalled();
  });

  it("Enter en la fila también lo abre", async () => {
    const onOpenProject = vi.fn();
    render(<RecentProjectsCard onOpenProject={onOpenProject} />);
    const row = (await screen.findByText("Control Center")).closest("li");
    expect(row).toBeTruthy();
    fireEvent.keyDown(row as HTMLElement, { key: "Enter" });
    expect(onOpenProject).toHaveBeenCalledWith({ id: "cc", name: "Control Center" });
  });

  it("sin onOpenProject cae a la lista (caso negativo)", async () => {
    const onOpenProjects = vi.fn();
    render(<RecentProjectsCard onOpenProjects={onOpenProjects} />);
    await waitFor(() => expect(screen.getByText("TFG")).toBeTruthy());
    fireEvent.click(screen.getByText("TFG"));
    expect(onOpenProjects).toHaveBeenCalledTimes(1);
  });
});
