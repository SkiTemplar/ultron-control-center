// Barrera de error de React: un fallo al pintar se queda en la pieza que lo provoca
// (un texto, un mensaje, un panel) y lo cuenta ahí. Sin ella, React desmonta toda la
// ventana y queda en blanco; si el mensaje malo sigue en el transcript, también al reabrir.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Qué se ha quedado sin pintar, para el aviso: «este mensaje», «este panel»… */
  scope: string;
  /** Al cambiar, se reintenta: otro fotograma del streaming, otra sesión, otra pestaña. */
  resetKey?: unknown;
  /** Se pinta tras el aviso: el texto en crudo, una acción. */
  detail?: ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(e: unknown): State {
    return { error: toError(e) };
  }

  componentDidCatch(e: unknown, info: ErrorInfo): void {
    // Queda en el registro con su pila de componentes; al usuario se lo dice `render`.
    console.error(`Sin pintar ${this.props.scope}:`, e, info.componentStack);
  }

  componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="render-err" role="alert" data-testid="render-error">
        <p>
          No se pudo pintar {this.props.scope}: {error.message}{" "}
          <button className="btn sm" onClick={() => this.setState({ error: null })}>Reintentar</button>
        </p>
        {this.props.detail}
      </div>
    );
  }
}
