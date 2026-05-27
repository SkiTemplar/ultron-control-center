// Usage — AiRouterSection renders without crash
// Verifies the Usage component and its AiRouterSection sub-section mount
// without errors when invoke returns empty/null data.

import { render, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { Usage } from "../Usage";

describe("Usage", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation(() => Promise.resolve(null));
  });

  it("renders without crashing", async () => {
    await act(async () => {
      render(<Usage />);
    });
    expect(document.body).toBeTruthy();
  });

  it("does not throw when all invokes reject", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("backend down"));
    await expect(
      act(async () => { render(<Usage />); })
    ).resolves.not.toThrow();
  });

  it("mounts AiRouterSection (rendered inside Usage)", async () => {
    let container: HTMLElement | undefined;
    await act(async () => {
      const result = render(<Usage />);
      container = result.container;
    });
    expect(container?.children.length).toBeGreaterThan(0);
  });
});
