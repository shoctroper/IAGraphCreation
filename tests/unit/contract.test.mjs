import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;

describe("contrato del paquete", () => {
  it("no declara dependencias de runtime con compilación nativa", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const nativas = ["tree-sitter", "tree-sitter-c-sharp", "tree-sitter-typescript", "better-sqlite3"];
    for (const d of Object.keys(pkg.dependencies ?? {})) expect(nativas).not.toContain(d);
  });

  it("las gramáticas están vendorizadas", () => {
    for (const w of ["tree-sitter-c_sharp.wasm", "tree-sitter-typescript.wasm", "web-tree-sitter.wasm"]) {
      expect(existsSync(join(ROOT, "vendor/wasm", w)), w).toBe(true);
    }
  });
});
