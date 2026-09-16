// Unit tests for the generator-config analyzer slice (spine step 3):
// contract-first generated-client evidence (acceptance J2).
//
// A committed generator config (nswag.json) declares the source spec and the
// generated client outputs; each `codeGenerators.*.output` is generated FROM
// `documentGenerator.fromDocument.url`, so each pair yields ONE `generated_from`
// edge whose evidence cites the config file at line 1, read literally.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeGenerators, EXTRACTOR, EXTRACTOR_VERSION } from "../../src/analyzers/contracts/generator.mjs";
import { analyzeContracts } from "../../src/analyzers/contracts/index.mjs";
import { analyzeFiles, analyzerForFile } from "../../src/analyzers/index.mjs";
import { createWorkspace } from "../../src/store/index.mjs";

const REV = "3f3b92a6f2d9c4a7b6a5f0e1d2c3b4a5f6e7d8c9";

const CONFIG = JSON.stringify({
  documentGenerator: { fromDocument: { url: "contracts/shop.v1.json" } },
  codeGenerators: { openApiToTypeScriptClient: { output: "ui/api-client.ts" } },
}, null, 2);

/** Materialise sources in a temp dir and run a contracts-slice analyzer over them. */
async function analyzeSources(sources, analyzer, rev = REV) {
  const dir = mkdtempSync(join(tmpdir(), "iagraph-generator-"));
  try {
    for (const [rel, body] of Object.entries(sources)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, "utf8");
    }
    return await analyzer({ files: Object.keys(sources), root: dir, rev });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("analizador de configuración del generador · extracción directa", () => {
  it("un nswag.json produce UN edge generated_from del output a la spec", async () => {
    const out = await analyzeSources({ "nswag.json": CONFIG }, analyzeGenerators);
    expect(out.nodes).toEqual([]);
    const g = out.edges.filter((e) => e.kind === "generated_from");
    expect(g).toHaveLength(1);
    expect(g[0].src).toBe("client:ui/api-client.ts");
    expect(g[0].dst).toBe("file:contracts/shop.v1.json");
  });

  it("la evidencia cita nswag.json en la línea 1 y la revisión (J2)", async () => {
    const out = await analyzeSources({ "nswag.json": CONFIG }, analyzeGenerators);
    const g = out.edges.find((e) => e.kind === "generated_from");
    expect(g.evidence).toEqual({ file: "nswag.json", lineStart: 1, rev: REV });
    expect(g.nature).toBe("EXTRACTED");
    expect(g.extractor).toBe(EXTRACTOR);
    expect(g.extractorVersion).toBe(EXTRACTOR_VERSION);
    expect(g.observedInRev).toBe(REV);
  });

  it("cada codeGenerators.*.output produce su propio edge", async () => {
    const out = await analyzeSources({
      "nswag.json": JSON.stringify({
        documentGenerator: { fromDocument: { url: "contracts/shop.v1.json" } },
        codeGenerators: {
          openApiToTypeScriptClient: { output: "ui/api-client.ts" },
          openApiToCSharpController: { output: "api/GeneratedController.cs" },
        },
      }),
    }, analyzeGenerators);
    const g = out.edges.filter((e) => e.kind === "generated_from");
    expect(g.map((e) => e.src).sort()).toEqual([
      "client:api/GeneratedController.cs",
      "client:ui/api-client.ts",
    ]);
    expect(g.every((e) => e.dst === "file:contracts/shop.v1.json")).toBe(true);
    expect(g.every((e) => e.evidence.file === "nswag.json")).toBe(true);
  });

  it("un generador sin output no inventa un edge (regla 2)", async () => {
    const out = await analyzeSources({
      "nswag.json": JSON.stringify({
        documentGenerator: { fromDocument: { url: "contracts/shop.v1.json" } },
        codeGenerators: { openApiToTypeScriptClient: { className: "ApiClient" } },
      }),
    }, analyzeGenerators);
    expect(out.edges).toEqual([]);
  });

  it("una config sin codeGenerators no produce ningún edge", async () => {
    const out = await analyzeSources({
      "nswag.json": JSON.stringify({
        documentGenerator: { fromDocument: { url: "contracts/shop.v1.json" } },
      }),
    }, analyzeGenerators);
    expect(out.edges).toEqual([]);
  });

  it("una config sin documentGenerator.fromDocument.url no produce ningún edge", async () => {
    const out = await analyzeSources({
      "nswag.json": JSON.stringify({
        codeGenerators: { openApiToTypeScriptClient: { output: "ui/api-client.ts" } },
      }),
    }, analyzeGenerators);
    expect(out.edges).toEqual([]);
  });

  it("una spec OpenAPI (documento sin generador) no produce edges generados", async () => {
    const out = await analyzeSources({
      "contracts/shop.v1.json": JSON.stringify({
        openapi: "3.0.0",
        paths: { "/api/orders": { get: { responses: { 200: { description: "ok" } } } } },
      }),
    }, analyzeGenerators);
    expect(out.edges).toEqual([]);
  });

  it("un JSON malformado se omite sin romper el análisis", async () => {
    const out = await analyzeSources({ "nswag.json": "{ not valid json" }, analyzeGenerators);
    expect(out.edges).toEqual([]);
  });

  it("una url con separadores Windows se normaliza a POSIX (K3)", async () => {
    const out = await analyzeSources({
      "nswag.json": JSON.stringify({
        documentGenerator: { fromDocument: { url: "contracts\\shop.v1.json" } },
        codeGenerators: { openApiToTypeScriptClient: { output: "ui\\api-client.ts" } },
      }),
    }, analyzeGenerators);
    const g = out.edges.find((e) => e.kind === "generated_from");
    expect(g.src).toBe("client:ui/api-client.ts");
    expect(g.dst).toBe("file:contracts/shop.v1.json");
  });
});

describe("contratos · integración del generador en la slice", () => {
  it("analyzeContracts incluye los edges del generador junto a los endpoints", async () => {
    const out = await analyzeSources({
      "nswag.json": CONFIG,
      "contracts/shop.v1.json": JSON.stringify({
        openapi: "3.0.0",
        paths: { "/api/orders": { get: { responses: { 200: { description: "ok" } } } } },
      }),
    }, analyzeContracts);
    const eps = out.nodes.filter((n) => n.kind === "endpoint");
    expect(eps.map((e) => `${e.method} ${e.route}`)).toEqual(["GET /api/orders"]);
    const g = out.edges.filter((e) => e.kind === "generated_from");
    expect(g).toHaveLength(1);
    expect(g[0].evidence.file).toBe("nswag.json");
  });

  it("una config sin output deja analyzeContracts en silencio", async () => {
    const out = await analyzeSources({
      "contracts/not-a-spec.json": JSON.stringify({
        documentGenerator: { fromDocument: { url: "x" } },
      }),
    }, analyzeContracts);
    expect(out.nodes).toEqual([]);
    expect(out.edges).toEqual([]);
  });
});

describe("registro de analizadores · generador", () => {
  it("asigna .json al analizador de contratos (que incluye el generador)", () => {
    expect(analyzerForFile("nswag.json").name).toBe("contracts");
    expect(analyzerForFile("nswag.JSON")).not.toBeNull();
  });

  it("analyzeFiles corre la slice de contratos sobre el lote y produce el edge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-generator-reg-"));
    try {
      mkdirSync(join(dir, "ui"), { recursive: true });
      writeFileSync(join(dir, "nswag.json"), CONFIG, "utf8");
      writeFileSync(join(dir, "ui/orders.ts"), "export const BASE = '/api';\n", "utf8");
      const out = await analyzeFiles({
        files: ["nswag.json", "ui/orders.ts"],
        root: dir,
        rev: REV,
      });
      const g = out.edges.filter((e) => e.kind === "generated_from");
      expect(g).toHaveLength(1);
      expect(g[0].evidence.file).toBe("nswag.json");
      expect(out.nodes.some((n) => n.file?.endsWith(".ts"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Workspace · build con configuración de generador (J2)", () => {
  it("un build que ingiere nswag.json produce el edge generated_from", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-generator-build-"));
    try {
      mkdirSync(join(dir, "ui"), { recursive: true });
      writeFileSync(join(dir, "nswag.json"), CONFIG, "utf8");
      const { execFileSync } = await import("node:child_process");
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
      execFileSync("git", ["config", "user.email", "u@u"], { cwd: dir });
      execFileSync("git", ["config", "user.name", "u"], { cwd: dir });
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-qm", "base"], { cwd: dir });

      const ws = await createWorkspace(dir, { storePath: ":memory:" });
      await ws.addRepo({ path: dir, role: "api" });
      await ws.build();
      const g = await ws.store.getEdges({ kind: "generated_from" });
      expect(g.length).toBeGreaterThan(0);
      expect(g[0].evidence.file).toContain("nswag.json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});