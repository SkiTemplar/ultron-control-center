// Caja de error reutilizada por todos los pasos del asistente.

export interface ErrorBoxProps {
  message: string;
}

export function ErrorBox({ message }: ErrorBoxProps) {
  return (
    <div
      className="rounded px-3 py-2 text-[11.5px]"
      style={{ background: "rgba(248, 81, 73, 0.10)", color: "var(--color-danger)", border: "1px solid rgba(248, 81, 73, 0.32)" }}
    >
      {message}
    </div>
  );
}
