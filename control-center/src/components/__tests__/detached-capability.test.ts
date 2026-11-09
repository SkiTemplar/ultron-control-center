// La ventana desacoplada de proyecto tiene los mismos botones que la pestaña:
// sin los permisos de opener, «Carpeta» y los ejecutables fallaban solo allí.

import { describe, expect, it } from "vitest";
import detached from "../../../src-tauri/capabilities/detached-project.json";
import main from "../../../src-tauri/capabilities/default.json";

type Permission = string | { identifier: string; allow?: unknown[] };

const openerPermissions = (permissions: Permission[]) =>
  permissions.filter((p) =>
    (typeof p === "string" ? p : p.identifier).startsWith("opener:"),
  );

describe("capability de la ventana desacoplada", () => {
  it("concede los mismos permisos de opener que la ventana principal", () => {
    const expected = openerPermissions(main.permissions as Permission[]);
    expect(expected.length).toBeGreaterThan(0);
    expect(openerPermissions(detached.permissions as Permission[])).toEqual(expected);
  });
});
