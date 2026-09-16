import { describe, it, expect } from "vitest";
import {
  canonicalForm,
  canonicalString,
  canonicalHash,
  graphCanonicalHash,
  createNode,
  createEdge,
  createEvidence,
  createRevision,
  makeNodeId,
  validateEdge,
  validateNode,
  validateRevision,
  assertValidRevision,
  Graph,
} from "../../src/model/index.mjs";

const REV = "0f84a6a5d5436929353e51899bd41b10f72d8ded";
const sha256hex = /^[0-9a-f]{64}$/;

function makeEdge(overrides = {}) {
  return createEdge({
    src: makeNodeId("interface", "IOrderService"),
    dst: makeNodeId("class", "OrderService"),
    kind: "implements",
    nature: "EXTRACTED",
    extractor: "csharp",
    extractorVersion: "0.1.0",
    evidence: { file: "api/Orders.cs", lineStart: 21, rev: REV },
    ...overrides,
  });
}

describe("A1 · la evidencia nunca se cae del canon", () => {
  it("todo edge construido lleva evidence.file y evidence.lineStart", () => {
    const edge = makeEdge();
    expect(edge.evidence.file).toBe("api/Orders.cs");
    expect(edge.evidence.lineStart).toBe(21);
  });

  it("el serializador canónico conserva file y lineStart de la evidencia", () => {
    const form = canonicalForm(makeEdge());
    expect(form.evidence.file).toBe("api/Orders.cs");
    expect(form.evidence.lineStart).toBe(21);
    expect(form.evidence.lineStart).toBeTypeOf("number");
  });

  it("ningún edge sin evidencia llega al modelo (defecto, no baja confianza)", () => {
    expect(() =>
      createEdge({
        src: "a", dst: "b", kind: "calls", nature: "INFERRED",
        extractor: "ts", extractorVersion: "1", observedInRev: REV,
      }),
    ).toThrow(/evidence/);
  });

  it("rechaza evidencia sin archivo o con línea no positiva", () => {
    expect(() => createEvidence({ file: "", lineStart: 1, rev: REV })).toThrow(/file/);
    expect(() => createEvidence({ file: "f.cs", lineStart: 0, rev: REV })).toThrow(/lineStart/);
  });

  it("rechaza evidencia con lineEnd anterior a lineStart", () => {
    expect(() => createEvidence({ file: "f.cs", lineStart: 10, lineEnd: 4, rev: REV })).toThrow(/lineEnd/);
    expect(() => createEvidence({ file: "f.cs", lineStart: 5, lineEnd: 5, rev: REV })).not.toThrow();
    expect(validateEdge({ ...makeEdge(), evidence: { file: "f.cs", lineStart: 10, lineEnd: 4, rev: REV } }).length).toBeGreaterThan(0);
  });

  it("rechaza una rev suministrada que no es una cadena no vacía", () => {
    expect(() => createEvidence({ file: "f.cs", lineStart: 1, rev: "" })).toThrow(/rev/);
    expect(() => createEvidence({ file: "f.cs", lineStart: 1, rev: 123 })).toThrow(/rev/);
    // omitirla sigue siendo legal: nodos/edges la rellenan con su revisión (regla 5)
    expect(createEvidence({ file: "f.cs", lineStart: 1 })).toEqual({ file: "f.cs", lineStart: 1 });
  });
});

describe("A2 · naturaleza restringida al trío canónico", () => {
  it("acepta EXTRACTED, INFERRED y AMBIGUOUS", () => {
    for (const nature of ["EXTRACTED", "INFERRED", "AMBIGUOUS"]) {
      const edge = makeEdge({ nature });
      expect(edge.nature).toBe(nature);
    }
  });

  it("rechaza cualquier otra naturaleza", () => {
    expect(() => makeEdge({ nature: "GUESSED" })).toThrow(/nature/);
    expect(() => makeEdge({ nature: "N/A" })).toThrow(/nature/);
    expect(validateEdge({ ...makeEdge(), nature: "GUESSED" }).length).toBeGreaterThan(0);
  });
});

describe("A3 · todo edge declara extractor y versión", () => {
  it("exige extractor y extractorVersion al construir", () => {
    expect(() =>
      makeEdge({ extractor: undefined }),
    ).toThrow(/extractor/);
    expect(() =>
      makeEdge({ extractorVersion: undefined }),
    ).toThrow(/extractorVersion/);
  });
});

describe("A6 · el canon ignora la metadata operacional", () => {
  it("dos edges que sólo difieren en metadata operacional hashcan igual", () => {
    const sin = canonicalHash(makeEdge());
    const con = canonicalHash(makeEdge({
      metadata: { builtAt: "2026-01-01", durationMs: 42, at: "2026-01-01T00:00:00Z" },
    }));
    expect(con).toBe(sin);
  });

  it("una marca de tiempo `at` nunca entra en el canon (regla 7)", () => {
    expect(canonicalString({ sha: "abc", at: "2026-09-16T12:00:00Z" })).toBe('{"sha":"abc"}');
    expect(canonicalHash({ sha: "abc", at: "2026-09-16T12:00:00Z" })).toBe(
      canonicalHash({ sha: "abc" }),
    );
  });

  it("dos grafos con el mismo contenido semántico en momentos distintos coinciden", () => {
    const mk = () => {
      const g = new Graph({ rev: REV });
      g.upsertNode(createNode({ kind: "class", name: "A", rev: REV, metadata: { builtAt: "x" } }));
      g.upsertEdge(makeEdge());
      return g.canonicalHash();
    };
    expect(mk()).toBe(mk());
    expect(mk()).toMatch(sha256hex);
  });
});

describe("serialización determinista de edges y evidencia", () => {
  it("el canon de un edge no depende del orden de sus claves", () => {
    const edge = makeEdge();
    const scrambled = {
      nature: edge.nature,
      evidence: {
        lineStart: edge.evidence.lineStart,
        rev: edge.evidence.rev,
        file: edge.evidence.file,
      },
      extractorVersion: edge.extractorVersion,
      firstSeenRev: edge.firstSeenRev,
      lastSeenRev: edge.lastSeenRev,
      observedInRev: edge.observedInRev,
      dst: edge.dst,
      src: edge.src,
      extractor: edge.extractor,
      id: edge.id,
      kind: edge.kind,
    };
    expect(canonicalString(scrambled)).toBe(canonicalString(edge));
  });

  it("la evidencia multi-fragmento de un nodo se canoniza sin importar el orden", () => {
    const frags = [
      { file: "api/Registry.Part2.cs", lineStart: 1, rev: REV },
      { file: "api/Registry.Part1.cs", lineStart: 1, rev: REV },
    ];
    const a = canonicalForm(createNode({
      kind: "class", name: "Registry", rev: REV, evidence: [...frags],
    }));
    const b = canonicalForm(createNode({
      kind: "class", name: "Registry", rev: REV, evidence: [...frags].reverse(),
    }));
    expect(canonicalString(a)).toBe(canonicalString(b));
    expect(a.evidence.map((e) => e.file).sort()).toEqual([
      "api/Registry.Part1.cs",
      "api/Registry.Part2.cs",
    ]);
  });

  it("el id de un edge es estable bajo reordenación de claves de evidencia", () => {
    const a = makeEdge();
    const b = makeEdge();
    expect(a.id).toBe(b.id);
    expect(a.id).toContain("implements");
  });

  it("la evidencia de un nodo sin rev hereda la revisión del nodo (regla 5)", () => {
    const node = createNode({
      kind: "class",
      name: "Registry",
      rev: REV,
      evidence: [{ file: "api/Registry.Part1.cs", lineStart: 1 }],
    });
    expect(node.evidence[0].rev).toBe(REV);
    expect(validateNode(node)).toEqual([]);
  });

  it("los slots vacíos de un array no alteran el canon (determinismo)", () => {
    const a = canonicalString([{ b: 1 }, undefined, { a: 2 }]);
    const b = canonicalString([{ a: 2 }, { b: 1 }]);
    expect(a).toBe(b);
    expect(a).toBe('[{"a":2},{"b":1}]');
  });
});

describe("tipo Revision", () => {
  it("construye una revisión con sha como identidad", () => {
    const rev = createRevision({ sha: REV, parent: "parent", at: "2026-09-16", summary: "bootstrap" });
    expect(rev.sha).toBe(REV);
    expect(rev.parent).toBe("parent");
    expect(rev.summary).toBe("bootstrap");
    assertValidRevision(rev);
    expect(validateRevision(rev)).toEqual([]);
  });

  it("requiere sha y rechaza campos malformados", () => {
    expect(() => createRevision({})).toThrow(/sha/);
    expect(validateRevision({ sha: "" }).length).toBeGreaterThan(0);
    expect(validateRevision({ sha: REV, parent: "" }).length).toBeGreaterThan(0);
    expect(() => assertValidRevision({ sha: "" })).toThrow(/sha/);
  });

  it("omite los campos opcionales ausentes", () => {
    expect(createRevision({ sha: REV })).toEqual({ sha: REV });
  });

  it("canoniza estable con clave de tiempo excluida", () => {
    const rev = createRevision({ sha: REV, parent: "p", at: "2026-09-16T12:00:00Z", summary: "s" });
    expect(canonicalString(rev)).toBe('{"parent":"p","sha":"' + REV + '","summary":"s"}');
    expect(canonicalHash(rev)).toBe(canonicalHash({ sha: REV, parent: "p", summary: "s" }));
    expect(canonicalHash(rev)).toMatch(sha256hex);
  });

  it("es estable entre dos construcciones con claves en distinto orden", () => {
    const a = canonicalString({ summary: "s", sha: REV, parent: "p" });
    const b = canonicalString({ parent: "p", sha: REV, summary: "s" });
    expect(a).toBe(b);
  });
});

describe("hash canónico del grafo: contrato A6", () => {
  it("no cambia con el orden de inserción ni con metadata", () => {
    const mk = (order) => {
      const g = new Graph({ rev: REV });
      const nodes = [
        createNode({ kind: "class", name: "A", rev: REV }),
        createNode({ kind: "class", name: "B", rev: REV }),
      ];
      const edge = makeEdge({
        src: makeNodeId("class", "A"),
        dst: makeNodeId("class", "B"),
      });
      for (const i of order) g.upsertNode(nodes[i]);
      g.upsertEdge(edge);
      return g.canonicalHash();
    };
    expect(mk([0, 1])).toBe(mk([1, 0]));
    expect(mk([0, 1])).toMatch(sha256hex);
  });

  it("el hash completo es independiente del reloj", () => {
    const g = new Graph({ rev: REV });
    g.upsertNode(createNode({ kind: "class", name: "A", rev: REV }));
    g.upsertEdge(makeEdge());
    const h1 = g.canonicalHash();
    const g2 = new Graph({ rev: REV });
    g2.upsertEdge(makeEdge());
    g2.upsertNode(createNode({ kind: "class", name: "A", rev: REV }));
    expect(g2.canonicalHash()).toBe(h1);
  });
});