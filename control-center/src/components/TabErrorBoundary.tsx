// TabErrorBoundary — error boundary genérico por-pestaña.
//
// Evita que un throw en render de una pestaña deje la app en pantalla en blanco.
// Muestra un mensaje de error + botón "Reintentar" que hace reset del estado.
//
// Patrón copiado de AIRouterErrorBoundary.tsx.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Nombre de la pestaña para el mensaje de error. */
  tab: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string;
}

export class TabErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error: unknown): State {
    const msg = error instanceof Error ? error.message : String(error);
    return { hasError: true, errorMessage: msg };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[TabErrorBoundary:${this.props.tab}] Render error:`, error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, errorMessage: "" });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
          <div
            className="w-full max-w-lg rounded-lg p-5 space-y-3"
            style={{
              background: "rgba(248,81,73,0.06)",
              border: "1px solid var(--color-danger)",
            }}
          >
            <p
              className="text-[13px] font-semibold"
              style={{ color: "var(--color-danger)" }}
            >
              Error en la pestaña &ldquo;{this.props.tab}&rdquo;
            </p>
            <p
              className="break-all font-mono text-[11.5px]"
              style={{ color: "var(--color-text-secondary)" }}
            >
              {this.state.errorMessage}
            </p>
            <p
              className="text-[11px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              El error ha sido registrado en consola. Intenta recargar la pestaña.
            </p>
          </div>
          <button
            type="button"
            onClick={this.handleReset}
            className="rounded px-5 py-2 text-[13px] font-medium transition-colors"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Reintentar
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
