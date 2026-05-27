// ULTRON Control Center — AI Router: Error Boundary
//
// Catches any unhandled React render error inside the AI Router sub-tree
// (e.g. an unexpected shape from the backend) and renders a friendly
// fallback instead of crashing the whole app.
//
// Usage: wrap the AIRouter component in index.tsx with this boundary.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class AIRouterErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error: unknown): State {
    const msg = error instanceof Error ? error.message : String(error);
    return { hasError: true, errorMessage: msg };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log to console for development diagnostics. Not surfaced to the user.
    console.error("[AIRouter] Render error caught by ErrorBoundary:", error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, errorMessage: "" });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="p-6 space-y-4">
          <div
            className="rounded-lg p-4 space-y-2"
            style={{
              background: "var(--color-danger-bg, #3a1a1a)",
              border: "1px solid var(--color-danger)",
            }}
          >
            <p
              className="text-[13px] font-semibold"
              style={{ color: "var(--color-danger)" }}
            >
              AI Router encountered a render error
            </p>
            <p
              className="text-[12px] font-mono break-all"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {this.state.errorMessage}
            </p>
            <p
              className="text-[11px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              This is usually caused by unexpected data from the backend
              (e.g. an empty or malformed metrics.json). The error has been
              logged to the browser console.
            </p>
          </div>
          <button
            type="button"
            onClick={this.handleReset}
            className="rounded px-4 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border)",
            }}
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
