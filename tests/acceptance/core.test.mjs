// Acceptance blocks A (model), B (ingestion) and C (API<->UI). RFC-G1 v3 §6.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { api, makeC3, dropC3, git, CORPUS, haveCorpus, C3_GROUND_TRUTH } from "./_harness.mjs";

let ws, c3;

beforeAll(async () => {
  c3 = makeC3();
  const { createWorkspace } = await api();
  ws = await createWorkspace(c3, { storePath: ":memory:" });
  await ws.addRepo({ path: c3, role: "api" });
  await ws.build();
}, 120_000);

afterAll(() => dropC3(c3));

// ---------------------------------------------------------------- A · modelo
describe("A · modelo canónico", () => {
  it("A1 · todo edge lleva evidencia con archivo y línea", async () => {
    const edges = await ws.store.getEdges({});
    expect(edges.length).toBeGreaterThan(0);
    const sinEvidencia = edges.filter(
      (e) => !e.evidence || !e.evidence.file || !Number.isInteger(e.evidence.lineStart),
    );
    expect(sinEvidencia).toEqual([]);
  });

  it("A2 · la naturaleza del edge es EXTRACTED, INFERRED o AMBIGUOUS", async () => {
    const edges = await ws.store.getEdges({});
    const malas = [...new Set(edges.map((e) => e.nature))].filter(
      (n) => !["EXTRACTED", "INFERRED", "AMBIGUOUS"].includes(n),
    );
    expect(malas).toEqual([]);
  });

  it("A3 · todo edge declara su extractor y versión", async () => {
    const edges = await ws.store.getEdges({});
    expect(edges.every((e) => e.extractor && e.extractorVersion)).toBe(true);
  });

  it("A4 · el grafo es consciente de la revisión", async () => {
    const rev = git(c3, "rev-parse", "HEAD").trim();
    const edges = await ws.store.getEdges({});
    expect(edges.every((e) => e.observedInRev === rev)).toBe(true);
    const nodes = await ws.store.findNodes({});
    expect(nodes.every((n) => n.firstSeenRev && n.lastSeenRev)).toBe(true);
  });

  it("A5 · los ids son estables entre dos construcciones de la misma revisión", async () => {
    const { createWorkspace } = await api();
    const otro = await createWorkspace(c3, { storePath: ":memory:" });
    await otro.addRepo({ path: c3, role: "api" });
    await otro.build();
    const a = (await ws.store.findNodes({})).map((n) => n.id).sort();
    const b = (await otro.store.findNodes({})).map((n) => n.id).sort();
    expect(b).toEqual(a);
  });

  it("A6 · el hash canónico ignora la metadata operacional", async () => {
    const h1 = await ws.canonicalHash();
    await new Promise((r) => setTimeout(r, 1100)); // el reloj avanza
    const { createWorkspace } = await api();
    const otro = await createWorkspace(c3, { storePath: ":memory:" });
    await otro.addRepo({ path: c3, role: "api" });
    await otro.build();
    expect(await otro.canonicalHash()).toBe(h1);
  });
});

// ------------------------------------------------------------ B · ingestión
describe("B · ingestión C# y TypeScript", () => {
  it("B1 · extrae tipos, clases e interfaces de C#", async () => {
    const nombres = (await ws.store.findNodes({ kind: "interface" })).map((n) => n.name);
    expect(nombres).toContain("IOrderService");
    expect(nombres).toContain("ICustomerService");
  });

  it("B2 · extrae métodos con su rango de líneas", async () => {
    const m = (await ws.store.findNodes({ kind: "method" })).find((n) => n.name === "All");
    expect(m).toBeDefined();
    expect(m.lineStart).toBeGreaterThan(0);
  });

  it("B3 · detecta implementación de interfaz", async () => {
    const edges = await ws.store.getEdges({ kind: "implements" });
    const par = edges.map((e) => `${e.src}->${e.dst}`);
    expect(par.some((p) => p.includes("OrderService") && p.includes("IOrderService"))).toBe(true);
  });

  it("B4 · extrae los endpoints declarados con su ruta y método", async () => {
    const eps = await ws.store.findNodes({ kind: "endpoint" });
    const vistos = eps.map((e) => `${e.method} ${e.route}`).sort();
    const esperados = C3_GROUND_TRUTH.endpoints.map((e) => `${e.method} ${e.route}`).sort();
    expect(vistos).toEqual(esperados);
  });

  it("B5 · extrae imports de TypeScript", async () => {
    const edges = await ws.store.getEdges({ kind: "imports" });
    expect(edges.some((e) => e.evidence.file.endsWith("ui/customers.ts"))).toBe(true);
  });

  it("B6 · una partial class produce UN nodo, no uno por archivo", async () => {
    const reg = (await ws.store.findNodes({ kind: "class" })).filter((n) => n.name === "Registry");
    expect(reg).toHaveLength(1);
    // y conserva la evidencia de los dos fragmentos
    const files = new Set((reg[0].evidence ?? []).map((e) => e.file));
    expect(files.size).toBe(2);
  });

  it("B7 · un registro DI explícito produce binds_implementation con evidencia", async () => {
    const b = (await ws.store.getEdges({ kind: "binds_implementation" })).find((e) =>
      e.src.includes("IOrderService"),
    );
    expect(b).toBeDefined();
    expect(b.dst).toContain("OrderService");
    expect(b.nature).toBe("EXTRACTED");
    expect(b.evidence.file).toContain("Startup.cs");
  });

  it("B8 · una factory opaca NO inventa una implementación", async () => {
    // Esta es la regla que mi propia sonda violó en AthenaFramework:
    // AddSingleton<ICustomerService>(sp => Factory.Create(sp)) no dice cuál es
    // la implementación. Registrar un binding sin resolver es correcto;
    // inventar un destino es un defecto.
    const b = (await ws.store.getEdges({ kind: "binds_implementation" })).filter((e) =>
      e.src.includes("ICustomerService"),
    );
    expect(b).toEqual([]);
  });

  it("B9 · un registro por escaneo produce una binding_rule con su scope", async () => {
    const reglas = await ws.store.findNodes({ kind: "binding_rule" });
    expect(reglas.length).toBeGreaterThan(0);
    expect(reglas[0].scope).toBeTruthy();
  });

  it("B10 · los edges derivados de una regla son INFERRED y citan la regla", async () => {
    const derivados = (await ws.store.getEdges({})).filter((e) => e.ruleId);
    for (const e of derivados) expect(e.nature).toBe("INFERRED");
  });

  it("B11 · nunca se marca EXTRACTED lo que no se lee literalmente", async () => {
    const edges = await ws.store.getEdges({ nature: "EXTRACTED" });
    // todo EXTRACTED debe poder citar el texto exacto de su evidencia
    for (const e of edges) {
      const ev = await ws.store.getEvidence(e.id);
      expect(ev.file).toBeTruthy();
      expect(ev.lineStart).toBeGreaterThan(0);
    }
  });

  it("B12 · obj/ y bin/ se excluyen siempre del análisis", async () => {
    const nodes = await ws.store.findNodes({});
    const sucios = nodes.filter((n) => /(^|\/)(obj|bin)\//.test(n.file ?? ""));
    expect(sucios).toEqual([]);
  });
});

// ------------------------------------------------------------- C · API <-> UI
describe("C · relaciones API ↔ UI", () => {
  it("C1 · encuentra TODAS las llamadas UI→endpoint del ground truth", async () => {
    const edges = await ws.store.getEdges({ kind: "calls_endpoint" });
    for (const esperado of C3_GROUND_TRUTH.calls) {
      const hit = edges.find(
        (e) => e.evidence.file.endsWith(esperado.from) && e.route === esperado.route,
      );
      expect(hit, `falta ${esperado.method} ${esperado.route} desde ${esperado.from}`).toBeDefined();
    }
  });

  it("C2 · cruza la barrera de lenguaje con dos librerías HTTP distintas", async () => {
    const edges = await ws.store.getEdges({ kind: "calls_endpoint" });
    const files = new Set(edges.map((e) => e.evidence.file));
    // fetch nativo y axios: si sólo encuentra una, el extractor es un regex
    expect([...files].some((f) => f.endsWith("ui/orders.ts"))).toBe(true);
    expect([...files].some((f) => f.endsWith("ui/customers.ts"))).toBe(true);
  });

  it("C3 · NO inventa enlaces por nombres parecidos", async () => {
    const edges = await ws.store.getEdges({ kind: "calls_endpoint" });
    for (const trampa of C3_GROUND_TRUTH.mustNotLink) {
      const falso = edges.find(
        (e) => e.evidence.file.endsWith(trampa.from) && e.route === trampa.route,
      );
      expect(falso, `enlace inventado: ${trampa.from} -> ${trampa.route}`).toBeUndefined();
    }
  });

  it("C4 · una constante de texto no es una llamada", async () => {
    const edges = await ws.store.getEdges({ kind: "calls_endpoint" });
    expect(edges.some((e) => e.evidence.file.endsWith("ui/legacy.ts"))).toBe(false);
  });

  it("C5 · sabe decir qué endpoints no tienen consumidor", async () => {
    const { impact } = await api();
    const huerfanos = await impact(ws, { kind: "endpoint", withoutConsumers: true });
    expect(Array.isArray(huerfanos.nodes)).toBe(true);
    expect(huerfanos.nodes.map((n) => n.route).sort()).toEqual(
      C3_GROUND_TRUTH.orphanEndpoints.sort(),
    );
  });

  it("C6 · sobre corpus real: ingiere AthenaFramework y encuentra sus endpoints", async () => {
    if (!haveCorpus("athenaApi")) return; // corpus ausente: no mentir, saltar
    const { createWorkspace } = await api();
    const real = await createWorkspace(CORPUS.athenaApi, { storePath: ":memory:" });
    await real.addRepo({ path: CORPUS.athenaApi, role: "api" });
    await real.build();
    const eps = await real.store.findNodes({ kind: "endpoint" });
    // la sonda del arquitecto midió 28 en Athena.Operator/Program.cs
    expect(eps.length).toBeGreaterThanOrEqual(25);
    expect(eps.map((e) => e.route)).toContain("/health");
  }, 600_000);
});
