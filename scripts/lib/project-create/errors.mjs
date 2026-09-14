// errors.mjs — error tipado del CLI de project-create.
//
// El campo `code` es parte del contrato con el comando Tauri
// `project_create_cli` y con control-center/src/lib/project-create-cli.ts:
// los codigos existentes (ROOTS_NOT_CONFIGURED, ALREADY_EXISTS,
// PATH_OUTSIDE_ROOT, INVALID_NAME, STEP_FAILED, TEMPLATE_NOT_FOUND,
// BAD_ARGS, ...) no se renombran ni se quitan.

export class CliError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}
