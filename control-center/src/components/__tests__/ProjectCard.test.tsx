// ProjectCard — unit tests for the extracted card component
// Verifies rendering, action buttons, and accessibility basics.

import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { ProjectCard } from "../projects/ProjectCard";
import type { ProjectInfo } from "../../types";

const BASE_PROJECT: ProjectInfo = {
  id: "my-proj",
  name: "My Project",
  path: "C:\\Users\\user\\projects\\my-proj",
  status: "active",
  language: "TypeScript",
  tags: ["work", "react"],
  items: [],
  default_provider: "claude",
  ide: null,
  last_active: "2026-05-27",
  type_: null,
  notes: null,
  default_shell: null,
  parent_folder_override: null,
  executables: [],
};

const noop = vi.fn();

function renderCard(overrides: Partial<ProjectInfo> = {}) {
  return render(
    <ProjectCard
      p={{ ...BASE_PROJECT, ...overrides }}
      stats={{ pending: 3 }}
      onOpenWorkspace={noop}
      onOpenFolder={noop}
      onOpenIde={noop}
      onOpenAi={noop}
      onEdit={noop}
      onDelete={noop}
    />,
  );
}

describe("ProjectCard", () => {
  it("renders project name", () => {
    renderCard();
    expect(screen.getByText("My Project")).toBeTruthy();
  });

  it("renders project path", () => {
    renderCard();
    expect(screen.getByTitle("C:\\Users\\user\\projects\\my-proj")).toBeTruthy();
  });

  it("renders status badge", () => {
    renderCard();
    expect(screen.getByText("active")).toBeTruthy();
  });

  it("does not render tag chips (tags UI removed)", () => {
    const { container } = renderCard();
    // Tags are in the data model but not rendered in the card UI
    expect(container.querySelector('[data-testid="tag-chip"]')).toBeNull();
    expect(container.textContent).not.toContain("work");
    expect(container.textContent).not.toContain("react");
  });

  it("renders the pending kanban stat (live-terminals chip removed with the PTY retirement)", () => {
    renderCard();
    expect(screen.getByText("3")).toBeTruthy();
    // The "N live" terminals chip is gone — no stray count cell.
    expect(screen.queryByText("live")).toBeNull();
  });

  it("calls onOpenWorkspace when card is clicked", () => {
    const onOpen = vi.fn();
    const { container } = render(
      <ProjectCard
        p={BASE_PROJECT}
        stats={null}
        onOpenWorkspace={onOpen}
        onOpenFolder={noop}
        onOpenIde={noop}
        onOpenAi={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );
    fireEvent.click(container.firstChild as HTMLElement);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("calls onEdit when Edit button is clicked", () => {
    const onEdit = vi.fn();
    render(
      <ProjectCard
        p={BASE_PROJECT}
        stats={null}
        onOpenWorkspace={noop}
        onOpenFolder={noop}
        onOpenIde={noop}
        onOpenAi={noop}
        onEdit={onEdit}
        onDelete={noop}
      />,
    );
    fireEvent.click(screen.getByTitle("Edit project metadata"));
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("renders with no tags gracefully", () => {
    const { container } = renderCard({ tags: [] });
    expect(container).toBeTruthy();
  });

  it("renders with null stats gracefully (shows dashes)", () => {
    render(
      <ProjectCard
        p={BASE_PROJECT}
        stats={null}
        onOpenWorkspace={noop}
        onOpenFolder={noop}
        onOpenIde={noop}
        onOpenAi={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );
    // The pending stat cell shows "—" when stats is null
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(1);
  });
});
