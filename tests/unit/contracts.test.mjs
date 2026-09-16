// Unit tests for the contracts analyzer slice (spine step 3): contract-first
// endpoint evidence (acceptance J1).
//
// They mirror the acceptance outcome J1 against the analyzer entry, the
// registry hookup and the incremental path: a committed OpenAPI spec yields
// endpoint nodes with method/route fields and evidence citing the spec file.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeContracts } from "../../src/analyzers/contracts/index.mjs";
import { analyzeFiles, analyzerForFile } from "../../src/analyzers/index.mjs";
import { createWorkspace } from "../../src/store/index.mjs";

const REV = "0f84a6a5d5436929353e51899bd41b10f72d8ded";

const SPEC = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Shop", version: "1" },
  paths: {
    "/api/orders": {
      get: { operationId: "listOrders", responses: { 200: { description: "ok" } } },
      post: { operationId: "createOrder", responses: { 200: { description: "ok" } } },
    },
    "/api/customers": {
      get: { operationId: "listCustomers", responses: { 200: { description: "ok" } } },
      parameters: [{ name: "trace", in: "header" }],
    },
  },
}, null, 2);

/** Materialise sources in a temp dir and run the contracts analyzer over them. */
async function analyzeSources(sources, rev = REV) {
  const dir = mkdtempSync(join(tmpdir(), "iagraph-contract-"));
  try {
    for (const [rel, body] of Object.entries(sources)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, "utf8");
    }
    return await analyzeContracts({ files: Object.keys(sources), root: dir, rev });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("analizador de contratos · extracción directa", () => {
  it("una spec OpenAPI produce un endpoint por operación con método y ruta (J1)", async () => {
    const out = await analyzeSources({ "contracts/shop.v1.json": SPEC });
    const eps = out.nodes.filter((n) => n.kind === "endpoint");
    expect(eps.map((e) => `${e.method} ${e.route}`).sort()).toEqual([
      "GET /api/customers",
      "GET /api/orders",
      "POST /api/orders",
    ]);
    const o = eps.find((e) => e.route === "/api/orders" && e.method === "GET");
    expect(o).toBeDefined();
    expect(o.qualifiedName).toBe("GET /api/orders");
    expect(o.id).toBe("endpoint:GET /api/orders");
  });

  it("la evidencia cita el archivo de la spec con línea 1 y la revisión", async () => {
    const out = await analyzeSources({ "contracts/shop.v1.json": SPEC });
    const o = out.nodes.find((n) => n.kind === "endpoint" && n.method === "GET");
    expect(o.file).toBe("contracts/shop.v1.json");
    expect(o.lineStart).toBe(1);
    expect(o.evidence).toEqual([
      { file: "contracts/shop.v1.json", lineStart: 1, rev: REV },
    ]);
  });

  it("una clave de path-item que no es un método HTTP no se inventa como endpoint (regla 3)", async () => {
    const out = await analyzeSources({
      "contracts/shop.v1.json": JSON.stringify({
        openapi: "3.0.0",
        paths: { "/api/orders": { parameters: [{ name: "trace", in: "header" }] } },
      }),
    });
    expect(out.nodes.filter((n) => n.kind === "endpoint")).toEqual([]);
  });

  it("un JSON sin campo openapi no produce ningún nodo", async () => {
    const out = await analyzeSources({
      "contracts/not-a-spec.json": JSON.stringify({ documentGenerator: { fromDocument: { url: "x" } } }),
    });
    expect(out.nodes).toEqual([]);
  });

  it("un JSON malformado se omite sin romper el análisis", async () => {
    const out = await analyzeSources({
      "contracts/broken.json": "{ not valid json",
    });
    expect(out.nodes).toEqual([]);
  });

  it("la identidad de nodo coincide con la del analizador C# (un solo endpoint)", async () => {
    const { analyzeCSharp } = await import("../../src/analyzers/csharp/index.mjs");
    const out = await analyzeSources({ "contracts/shop.v1.json": SPEC });
    const cs = await analyzeCSharp({
      files: ["api/OrdersApi.cs"],
      root: new URL("../../tests/fixtures/repo/", import.meta.url).pathname,
      rev: REV,
    });
    const contractEp = out.nodes.find((n) => n.kind === "endpoint" && n.route === "/api/orders");
    const csEp = cs.nodes.find((n) => n.kind === "endpoint" && n.route === "/api/orders");
    expect(contractEp.id).toBe(csEp.id);
  });
});

describe("registro de analizadores", () => {
  it("asigna .json al analizador de contratos y nada más", () => {
    expect(analyzerForFile("contracts/shop.v1.json").name).toBe("contracts");
    expect(analyzerForFile("contracts/shop.v1.JSON")).not.toBeNull();
    expect(analyzerForFile("ui/api-client.ts").name).toBe("typescript");
    expect(analyzerForFile("api/Orders.cs").name).toBe("csharp");
  });

  it("analyzeFiles corre el analizador de contratos sobre los .json del lote", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-contract-reg-"));
    try {
      mkdirSync(join(dir, "contracts"), { recursive: true });
      writeFileSync(join(dir, "contracts/shop.v1.json"), SPEC, "utf8");
      mkdirSync(join(dir, "ui"), { recursive: true });
      writeFileSync(join(dir, "ui/orders.ts"), "export const BASE = '/api';\n", "utf8");
      const out = await analyzeFiles({
        files: ["contracts/shop.v1.json", "ui/orders.ts"],
        root: dir,
        rev: REV,
      });
      const eps = out.nodes.filter((n) => n.kind === "endpoint");
      expect(eps.map((e) => `${e.method} ${e.route}`)).toContain("GET /api/orders");
      expect(out.nodes.some((n) => n.file?.endsWith(".ts"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Workspace · build y update con contratos (J1)", () => {
  const FILES = {
    "api/Orders.cs": `using Microsoft.AspNetCore.Builder;
namespace Shop.Api;

public static class Orders
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/orders", (IOrderService svc) => svc.All());
    }
}

public interface IOrderService { Order[] All(); }
`,
  };

  function makeRepo() {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-contract-repo-"));
    for (const [rel, body] of Object.entries(FILES)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, "utf8");
    }
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "unit@iagraph.local");
    git(dir, "config", "user.name", "unit");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
    return dir;
  }

  async function commit(dir, msg) {
    const before = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", msg);
    return before;
  }

  let repo;
  beforeAll(() => {
    repo = makeRepo();
  });
  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("un build con una spec commiteada cita la spec como evidencia del endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-contract-build-"));
    try {
      for (const [rel, body] of Object.entries(FILES)) {
        const abs = join(dir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, body, "utf8");
      }
      mkdirSync(join(dir, "contracts"), { recursive: true });
      writeFileSync(join(dir, "contracts/shop.v1.json"), SPEC, "utf8");
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "u@u");
      git(dir, "config", "user.name", "u");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "base");

      const ws = await createWorkspace(dir, { storePath: ":memory:" });
      await ws.addRepo({ path: dir, role: "api" });
      await ws.build();
      const eps = await ws.store.findNodes({ kind: "endpoint" });
      const o = eps.find((e) => e.route === "/api/orders" && e.method === "GET");
      expect(o).toBeDefined();
      expect((o.evidence ?? []).some((e) => e.file.includes("shop.v1.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("un update incremental que añade una spec reanaliza el contrato (J1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-contract-update-"));
    try {
      for (const [rel, body] of Object.entries(FILES)) {
        const abs = join(dir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, body, "utf8");
      }
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "u@u");
      git(dir, "config", "user.name", "u");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "base");

      const ws = await createWorkspace(dir, { storePath: ":memory:" });
      await ws.addRepo({ path: dir, role: "api" });
      await ws.build();

      mkdirSync(join(dir, "contracts"), { recursive: true });
      writeFileSync(join(dir, "contracts/shop.v1.json"), SPEC, "utf8");
      const from = await commit(dir, "add openapi spec");

      const rep = await ws.update({ from });
      const eps = await ws.store.findNodes({ kind: "endpoint" });
      const o = eps.find((e) => e.route === "/api/orders" && e.method === "GET");
      expect(o).toBeDefined();
      const specEv = (o.evidence ?? []).some((e) => e.file.includes("shop.v1.json"));
      expect(specEv).toBe(true);
      expect(rep.reanalyzedFiles).toContain("contracts/shop.v1.json");
      expect(rep.degradedToRebuild).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("un update que cambia la ruta de la spec reemplaza la ruta vieja", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-contract-route-"));
    try {
      for (const [rel, body] of Object.entries(FILES)) {
        const abs = join(dir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, body, "utf8");
      }
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "u@u");
      git(dir, "config", "user.name", "u");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "base");

      const ws = await createWorkspace(dir, { storePath: ":memory:" });
      await ws.addRepo({ path: dir, role: "api" });
      await ws.build();

      mkdirSync(join(dir, "contracts"), { recursive: true });
      const specPath = join(dir, "contracts/shop.v1.json");
      writeFileSync(specPath, SPEC, "utf8");
      let from = await commit(dir, "add spec");

      await ws.update({ from });
      writeFileSync(
        specPath,
        JSON.stringify({
          openapi: "3.0.0",
          paths: { "/api/clients": { get: { responses: { 200: { description: "ok" } } } } },
        }),
      );
      from = await commit(dir, "move route in spec");

      await ws.update({ from });
      const routes = (await ws.store.findNodes({ kind: "endpoint" })).map((e) => e.route);
      expect(routes).toContain("/api/clients");
      expect(routes).not.toContain("/api/orders");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});