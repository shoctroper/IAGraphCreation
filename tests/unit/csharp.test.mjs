// Unit tests for the C# analyzer slice (spine step 3).
//
// They mirror the acceptance outcomes B1, B2, B3, B4, B6, B7 and B8 against
// the fixtures under tests/fixtures/repo/api, plus the invariants they encode
// (rules 1, 2 and 3 of docs/API.md).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createWorkspace } from "../../src/store/index.mjs";
import { analyzeCSharp, createCSharpAnalyzer } from "../../src/analyzers/csharp/index.mjs";
import { analyzeFiles, analyzerForFile } from "../../src/analyzers/index.mjs";

const FIXTURE = new URL("../../tests/fixtures/repo/", import.meta.url).pathname;
const REV = "0f84a6a5d5436929353e51899bd41b10f72d8ded";

const CS_FILES = [
  "api/Orders.cs",
  "api/OrdersApi.cs",
  "api/Registry.Part1.cs",
  "api/Registry.Part2.cs",
  "api/Startup.cs",
];

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "iagraph-csharp-"));
  cpSync(FIXTURE, dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "unit@iagraph.local");
  git(dir, "config", "user.name", "unit");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "fixture: base");
  return dir;
}

/** Materialise sources in a temp dir and run the analyzer over them. */
async function analyzeSources(sources, rev = REV) {
  const dir = mkdtempSync(join(tmpdir(), "iagraph-csrc-"));
  try {
    for (const [rel, body] of Object.entries(sources)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, "utf8");
    }
    return await analyzeCSharp({ files: Object.keys(sources), root: dir, rev });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("analizador C# · extracción directa", () => {
  it("carga la gramática vendorizada y extrae interfaces y clases (B1)", async () => {
    const out = await analyzeCSharp({ files: CS_FILES, root: FIXTURE, rev: REV });
    const interfaces = out.nodes.filter((n) => n.kind === "interface").map((n) => n.name);
    const classes = out.nodes.filter((n) => n.kind === "class").map((n) => n.name);
    expect(interfaces).toContain("IOrderService");
    expect(classes).toContain("OrderService");
    // identity is the namespace-qualified name, never the file (rule 6)
    const iface = out.nodes.find((n) => n.kind === "interface" && n.name === "IOrderService");
    expect(iface.qualifiedName).toBe("Fixture.Api.IOrderService");
    expect(iface.id).toBe("interface:Fixture.Api.IOrderService");
  });

  it("extrae métodos con su rango de líneas (B2)", async () => {
    const out = await analyzeCSharp({ files: CS_FILES, root: FIXTURE, rev: REV });
    const all = out.nodes.filter((n) => n.kind === "method" && n.name === "All");
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) expect(m.lineStart).toBeGreaterThan(0);
    const map = out.nodes.find((n) => n.kind === "method" && n.name === "Map");
    expect(map.qualifiedName).toBe("Fixture.Api.Orders.Map");
  });

  it("detecta la implementación de interfaz desde la base_list (B3)", async () => {
    const out = await analyzeCSharp({ files: CS_FILES, root: FIXTURE, rev: REV });
    const imp = out.edges.filter((e) => e.kind === "implements");
    const pair = imp.map((e) => `${e.src}->${e.dst}`);
    expect(pair.some((p) => p.includes("OrderService") && p.includes("IOrderService"))).toBe(true);
    for (const e of imp) {
      expect(e.nature).toBe("EXTRACTED");
      expect(e.evidence.file).toBeTruthy();
      expect(e.evidence.lineStart).toBeGreaterThan(0);
    }
  });

  it("extrae los endpoints Map* con su ruta literal y método (B4)", async () => {
    const out = await analyzeCSharp({ files: CS_FILES, root: FIXTURE, rev: REV });
    const eps = out.nodes.filter((n) => n.kind === "endpoint");
    expect(eps).toHaveLength(1);
    const e = eps[0];
    expect(e.method).toBe("GET");
    expect(e.route).toBe("/api/orders");
    expect(e.file).toBe("api/OrdersApi.cs");
    expect(e.lineStart).toBeGreaterThan(0);
  });

  it("un registro DI explícito produce binds_implementation EXTRACTED (B7)", async () => {
    const out = await analyzeCSharp({ files: CS_FILES, root: FIXTURE, rev: REV });
    const b = out.edges.find(
      (e) => e.kind === "binds_implementation" && e.src.includes("IOrderService"),
    );
    expect(b).toBeDefined();
    expect(b.dst).toContain("OrderService");
    expect(b.nature).toBe("EXTRACTED");
    expect(b.evidence.file).toContain("Startup.cs");
    expect(b.evidence.lineStart).toBe(8);
  });

  it("una factory opaca NO inventa una implementación (B8)", async () => {
    const out = await analyzeCSharp({ files: CS_FILES, root: FIXTURE, rev: REV });
    const b = out.edges.filter(
      (e) => e.kind === "binds_implementation" && e.src.includes("ICustomerService"),
    );
    expect(b).toEqual([]);
  });

  it("una partial class es UN nodo con la evidencia de ambos fragmentos (B6)", async () => {
    const out = await analyzeCSharp({ files: CS_FILES, root: FIXTURE, rev: REV });
    const reg = out.nodes.filter((n) => n.kind === "class" && n.name === "Registry");
    expect(reg).toHaveLength(1);
    const files = new Set((reg[0].evidence ?? []).map((e) => e.file));
    expect(files).toEqual(
      new Set(["api/Registry.Part1.cs", "api/Registry.Part2.cs"]),
    );
  });

  it("todo nodo y edge lleva evidencia con archivo y línea (regla 1)", async () => {
    const out = await analyzeCSharp({ files: CS_FILES, root: FIXTURE, rev: REV });
    for (const n of out.nodes) {
      expect(n.evidence.length).toBeGreaterThan(0);
      for (const ev of n.evidence) {
        expect(ev.file).toBeTruthy();
        expect(Number.isInteger(ev.lineStart)).toBe(true);
      }
    }
    for (const e of out.edges) {
      expect(e.evidence.file).toBeTruthy();
      expect(Number.isInteger(e.evidence.lineStart)).toBe(true);
    }
  });

  it("una ruta en una constante no es un endpoint (regla 3)", async () => {
    const out = await analyzeSources({
      "api/Const.cs": `namespace N;
public static class C
{
    public static void M(WebApplication app)
    {
        app.MapGet(Constants.Route, () => "hi");
    }
}
`,
    });
    expect(out.nodes.filter((n) => n.kind === "endpoint")).toEqual([]);
  });

  it("una factory opaca aislada tampoco produce binding (regla 2)", async () => {
    const out = await analyzeSources({
      "api/I.cs": `namespace N;
public interface IThing { }
`,
      "api/Startup.cs": `using Microsoft.Extensions.DependencyInjection;
namespace N;
public static class Startup
{
    public static void C(IServiceCollection s)
    {
        s.AddSingleton<IThing>(sp => Factory.Create(sp));
    }
}
`,
    });
    expect(out.edges.filter((e) => e.kind === "binds_implementation")).toEqual([]);
  });

  it("createCSharpAnalyzer expone collectTypes/extract con un solo runtime", async () => {
    const analyzer = await createCSharpAnalyzer();
    const { interfaces } = analyzer.collectTypes({
      source: "namespace A.B; public interface IFoo {}",
    });
    expect(interfaces.get("IFoo")).toEqual(new Set(["interface:A.B.IFoo"]));
  });
});

describe("registro de analizadores", () => {
  it("asigna .cs al analizador C# y nada más", () => {
    expect(analyzerForFile("api/Orders.cs").name).toBe("csharp");
    expect(analyzerForFile("ui/orders.ts")).toBeNull();
    expect(analyzerForFile("api/Orders.CS")).not.toBeNull();
  });

  it("analyzeFiles corre el analizador aplicable y omite el resto", async () => {
    const out = await analyzeFiles({
      files: [...CS_FILES, "ui/orders.ts"],
      root: FIXTURE,
      rev: REV,
    });
    expect(out.nodes.some((n) => n.kind === "class")).toBe(true);
    expect(out.nodes.filter((n) => n.file?.endsWith(".ts"))).toEqual([]);
  });
});

describe("Workspace.build corre los analizadores (spine step 3)", () => {
  let repo;
  let ws;
  let headRev;

  beforeAll(async () => {
    repo = makeFixtureRepo();
    headRev = git(repo, "rev-parse", "HEAD").trim();
    ws = createWorkspace(repo, { storePath: ":memory:" });
    await ws.addRepo({ path: repo, role: "api" });
    await ws.build();
  }, 120_000);

  afterAll(() => {
    ws.store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("ingesta tipos, métodos y endpoints (B1/B2/B4)", async () => {
    const interfaces = await ws.store.findNodes({ kind: "interface" });
    expect(interfaces.map((n) => n.name)).toContain("IOrderService");
    const methods = await ws.store.findNodes({ kind: "method" });
    const all = methods.find((n) => n.name === "All");
    expect(all).toBeDefined();
    expect(all.lineStart).toBeGreaterThan(0);
    const eps = await ws.store.findNodes({ kind: "endpoint" });
    expect(eps.map((e) => `${e.method} ${e.route}`)).toContain("GET /api/orders");
  });

  it("persiste implements y binds_implementation con evidencia (B3/B7)", async () => {
    const imp = await ws.store.getEdges({ kind: "implements" });
    expect(imp.some((e) => e.src.includes("OrderService") && e.dst.includes("IOrderService"))).toBe(
      true,
    );
    const b = (await ws.store.getEdges({ kind: "binds_implementation" })).find((e) =>
      e.src.includes("IOrderService"),
    );
    expect(b).toBeDefined();
    expect(b.dst).toContain("OrderService");
    expect(b.nature).toBe("EXTRACTED");
    expect(b.evidence.file).toContain("Startup.cs");
  });

  it("no persiste ningún binding para la factory opaca (B8)", async () => {
    const b = (await ws.store.getEdges({ kind: "binds_implementation" })).filter((e) =>
      e.src.includes("ICustomerService"),
    );
    expect(b).toEqual([]);
  });

  it("todo edge del store lleva evidencia y la revisión del build (A1/A4)", async () => {
    const edges = await ws.store.getEdges({});
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(e.evidence.file).toBeTruthy();
      expect(Number.isInteger(e.evidence.lineStart)).toBe(true);
      expect(e.observedInRev).toBe(headRev);
    }
  });
});