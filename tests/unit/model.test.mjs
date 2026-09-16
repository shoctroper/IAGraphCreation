import { describe, it, expect } from "vitest";
import {
  NATURES,
  NODE_KINDS,
  EDGE_KINDS,
  createNode,
  createEdge,
  createEvidence,
  makeNodeId,
  toPosixPath,
  validateNode,
  validateEdge,
  validateGraph,
  assertValidNode,
  assertValidEdge,
  Graph,
} from "../../src/model/index.mjs";

const REV = "0f84a6a5d5436929353e51899bd41b10f72d8ded";

describe("schema canónico", () => {
  it("conoce los tres niveles de naturaleza", () => {
    expect(NATURES).toEqual(["EXTRACTED", "INFERRED", "AMBIGUOUS"]);
  });

  it("cubre los NodeKind del contrato (docs/API.md)", () => {
    for (const k of [
      "repository", "project", "module", "namespace", "file",
      "type", "class", "interface", "method", "function",
      "endpoint", "route", "client", "component", "page",
      "binding", "binding_rule",
    ]) {
      expect(NODE_KINDS).toContain(k);
    }
  });

  it("cubre los EdgeKind del contrato", () => {
    for (const k of [
      "contains", "imports", "calls", "references",
      "inherits", "implements", "instantiates",
      "declares_endpoint", "calls_endpoint", "consumed_by", "routes_to",
      "binds_implementation", "generated_from",
    ]) {
      expect(EDGE_KINDS).toContain(k);
    }
  });
});

describe("modelo de nodo", () => {
  it("identifica por nombre cualificado, no por archivo (regla 6)", () => {
    const a = createNode({ kind: "class", name: "Registry", rev: REV, file: "api/R1.cs" });
    const b = createNode({ kind: "class", name: "Registry", rev: REV, file: "api/R2.cs" });
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(makeNodeId("class", "Registry"));
  });

  it("una partial class conserva la evidencia de sus fragmentos", () => {
    const node = createNode({
      kind: "class",
      name: "Registry",
      rev: REV,
      evidence: [
        { file: "api/Registry.Part1.cs", lineStart: 1, rev: REV },
        { file: "api/Registry.Part2.cs", lineStart: 1, rev: REV },
      ],
    });
    expect(node.evidence).toHaveLength(2);
  });

  it("un nodo conoce la revisión en la que nació", () => {
    const node = createNode({ kind: "interface", name: "IOrderService", rev: REV });
    expect(node.firstSeenRev).toBe(REV);
    expect(node.lastSeenRev).toBe(REV);
  });

  it("rechaza un nodo sin nombre cualificado o sin revisión", () => {
    expect(() => createNode({ kind: "class" })).toThrow();
    expect(() => createNode({ kind: "class", name: "X" })).toThrow();
    expect(() => createNode({ kind: "nope", name: "X", rev: REV })).toThrow();
  });

  it("normaliza rutas a POSIX", () => {
    const node = createNode({ kind: "file", name: "f", rev: REV, file: "src\\mod\\a.cs" });
    expect(node.file).toBe("src/mod/a.cs");
    expect(toPosixPath("a\\b")).toBe("a/b");
  });

  it("no deja escapar separadores de Windows al modelo", () => {
    const node = createNode({ kind: "file", name: "f", rev: REV, file: "a\\b" });
    expect(validateNode(node)).toEqual([]);
    expect(node.file).not.toContain("\\");
  });
});

describe("modelo de edge", () => {
  it("todo edge lleva evidencia con archivo y línea (regla 1)", () => {
    const edge = createEdge({
      src: makeNodeId("interface", "IOrderService"),
      dst: makeNodeId("class", "OrderService"),
      kind: "implements",
      nature: "EXTRACTED",
      extractor: "csharp",
      extractorVersion: "0.1.0",
      evidence: { file: "api/Orders.cs", lineStart: 21, rev: REV },
    });
    expect(edge.evidence.file).toBe("api/Orders.cs");
    expect(edge.evidence.lineStart).toBe(21);
    assertValidEdge(edge);
  });

  it("un edge sin evidencia es un defecto, no un edge de baja confianza", () => {
    expect(() =>
      createEdge({
        src: "a", dst: "b", kind: "calls", nature: "INFERRED",
        extractor: "ts", extractorVersion: "0.1.0", observedInRev: REV,
      }),
    ).toThrow(/evidence/);
  });

  it("un edge con ruleId debe ser INFERRED (B10)", () => {
    expect(() =>
      createEdge({
        src: "a", dst: "b", kind: "references", nature: "EXTRACTED",
        extractor: "csharp", extractorVersion: "0.1.0", ruleId: "r1",
        evidence: { file: "api/Startup.cs", lineStart: 4, rev: REV },
      }),
    ).toThrow(/INFERRED/);
  });

  it("declara extractor, versión y revisiones", () => {
    const edge = createEdge({
      src: "a", dst: "b", kind: "calls", nature: "EXTRACTED",
      extractor: "typescript", extractorVersion: "1.2.3",
      evidence: { file: "ui/a.ts", lineStart: 2, rev: REV },
    });
    expect(edge.extractor).toBe("typescript");
    expect(edge.extractorVersion).toBe("1.2.3");
    expect(edge.observedInRev).toBe(REV);
    expect(edge.firstSeenRev).toBe(REV);
    expect(edge.lastSeenRev).toBe(REV);
  });

  it("copia la revisión desde la evidencia cuando no se pasa observedInRev", () => {
    const edge = createEdge({
      src: "a", dst: "b", kind: "imports", nature: "EXTRACTED",
      extractor: "typescript", extractorVersion: "0.1.0",
      evidence: { file: "ui/a.ts", lineStart: 1, rev: REV },
    });
    expect(edge.observedInRev).toBe(REV);
  });
});

describe("validación invariante", () => {
  it("rechaza un edge sin archivo o línea en la evidencia", () => {
    const base = {
      src: "a", dst: "b", kind: "calls", nature: "EXTRACTED",
      extractor: "x", extractorVersion: "1", observedInRev: REV,
      evidence: { file: "", lineStart: 0, rev: REV },
    };
    expect(validateEdge(base).length).toBeGreaterThan(0);
  });

  it("valida el grafo completo y reporta duplicados", () => {
    const n1 = createNode({ kind: "class", name: "A", rev: REV });
    const { ok, errors } = validateGraph({
      nodes: [n1, { ...n1 }],
      edges: [{ ...createEdge({
        src: "a", dst: "b", kind: "calls", nature: "INFERRED",
        extractor: "x", extractorVersion: "1",
        evidence: { file: "f.cs", lineStart: 1, rev: REV },
      }), evidence: undefined }],
    });
    expect(ok).toBe(false);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("assertValidNode no lanza para un nodo correcto", () => {
    const node = createNode({ kind: "method", name: "All", rev: REV });
    expect(assertValidNode(node).id).toBe(node.id);
  });
});

describe("Graph revision-aware", () => {
  it("avanza lastSeenRev y conserva firstSeenRev al actualizar", () => {
    const g = new Graph({ rev: REV });
    g.upsertNode(createNode({ kind: "interface", name: "IOrderService", rev: REV }));
    g.upsertNode(createNode({ kind: "interface", name: "IOrderService", rev: "bbbb" }));
    const n = g.node(makeNodeId("interface", "IOrderService"));
    expect(n.firstSeenRev).toBe(REV);
    expect(n.lastSeenRev).toBe("bbbb");
  });

  it("al borrar un nodo se van sus edges", () => {
    const g = new Graph({ rev: REV });
    g.upsertNode(createNode({ kind: "class", name: "A", rev: REV }));
    g.upsertNode(createNode({ kind: "class", name: "B", rev: REV }));
    const a = makeNodeId("class", "A");
    const b = makeNodeId("class", "B");
    g.upsertEdge(createEdge({
      src: a, dst: b, kind: "references", nature: "EXTRACTED",
      extractor: "x", extractorVersion: "1",
      evidence: { file: "a.cs", lineStart: 1, rev: REV },
    }));
    expect(g.edgeCount).toBe(1);
    g.removeNode(a);
    expect(g.edgeCount).toBe(0);
  });

  it("no admite mutaciones que rompan los invariantes", () => {
    const g = new Graph({ rev: REV });
    expect(() => g.upsertEdge({
      src: "a", dst: "b", kind: "calls", nature: "EXTRACTED",
      extractor: "x", extractorVersion: "1",
      evidence: { file: "a.cs", lineStart: 1, rev: REV },
    })).toThrow();
  });
});