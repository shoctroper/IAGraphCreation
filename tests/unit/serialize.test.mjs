import { describe, it, expect } from "vitest";
import {
  canonicalForm,
  canonicalString,
  canonicalHash,
  graphCanonicalForm,
  graphCanonicalString,
  graphCanonicalHash,
  sortNodes,
  sortEdges,
  createNode,
  createEdge,
  makeNodeId,
  Graph,
} from "../../src/model/index.mjs";

const REV = "0f84a6a5d5436929353e51899bd41b10f72d8ded";
const sha256hex = /^[0-9a-f]{64}$/;

function makeEdge(src, dst, file = "f.cs", line = 1) {
  return createEdge({
    src, dst, kind: "calls", nature: "EXTRACTED",
    extractor: "ts", extractorVersion: "1",
    evidence: { file, lineStart: line, rev: REV },
  });
}

describe("serialización canónica", () => {
  it("ordena las claves de un objeto", () => {
    const s = canonicalString({ z: 1, a: 2, m: 3 });
    expect(s).toBe('{"a":2,"m":3,"z":1}');
  });

  it("es independiente del orden de inserción de los arrays", () => {
    const a = canonicalForm([{ b: 1, a: 2 }, { c: 3 }]);
    const b = canonicalForm([{ c: 3 }, { a: 2, b: 1 }]);
    expect(canonicalString(a)).toBe(canonicalString(b));
  });

  it("ignora la metadata operacional (regla 7)", () => {
    const withMeta = { name: "n", createdAt: "2026-01-01", durationMs: 12, metadata: { x: 1 } };
    const plain = { name: "n" };
    expect(canonicalHash(withMeta)).toBe(canonicalHash(plain));
    expect(canonicalString(withMeta)).toBe('{"name":"n"}');
  });

  it("produce un SHA256 hexadecimal de 64 caracteres", () => {
    expect(canonicalHash({ a: 1 })).toMatch(sha256hex);
  });

  it("distingue contenido distinto", () => {
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });
});

describe("hash canónico del grafo", () => {
  it("no cambia con el orden de inserción de nodos y edges", () => {
    const g1 = new Graph({ rev: REV });
    g1.upsertNode(createNode({ kind: "class", name: "A", rev: REV }));
    g1.upsertNode(createNode({ kind: "class", name: "B", rev: REV }));
    g1.upsertEdge(makeEdge(makeNodeId("class", "A"), makeNodeId("class", "B")));

    const g2 = new Graph({ rev: REV });
    g2.upsertNode(createNode({ kind: "class", name: "B", rev: REV }));
    g2.upsertEdge(makeEdge(makeNodeId("class", "A"), makeNodeId("class", "B")));
    g2.upsertNode(createNode({ kind: "class", name: "A", rev: REV }));

    expect(g1.canonicalHash()).toBe(g2.canonicalHash());
    expect(g1.canonicalHash()).toMatch(sha256hex);
  });

  it("es estable entre dos llamadas sobre el mismo grafo", () => {
    const g = new Graph({ rev: REV });
    g.upsertNode(createNode({ kind: "class", name: "A", rev: REV }));
    expect(g.canonicalHash()).toBe(g.canonicalHash());
  });

  it("dos grafos con el mismo contenido semántico pero distinta metadata coinciden", () => {
    const mk = (meta) => {
      const g = new Graph({ rev: REV });
      g.upsertNode(createNode({ kind: "class", name: "A", rev: REV, metadata: meta }));
      return g.canonicalHash();
    };
    expect(mk({ builtAt: "x", durationMs: 9 })).toBe(mk({}));
  });

  it("los helpers de orden son estables por id", () => {
    const nodes = [
      createNode({ kind: "class", name: "B", rev: REV }),
      createNode({ kind: "class", name: "A", rev: REV }),
    ];
    const edges = [
      makeEdge(makeNodeId("class", "A"), makeNodeId("class", "B")),
      makeEdge(makeNodeId("class", "B"), makeNodeId("class", "A")),
    ];
    const n1 = sortNodes(nodes);
    const n2 = sortNodes([...nodes].reverse());
    expect(n1.map((n) => n.id)).toEqual(n2.map((n) => n.id));
    expect(sortEdges(edges).map((e) => e.id)).toEqual(sortEdges([...edges].reverse()).map((e) => e.id));
  });
});

describe("orden de nodos y edges en el canon (contrato A5/A6)", () => {
  const ids = ["class:A", "class:B", "class:C"].map((k) => makeNodeId("class", k.split(":")[1]));
  const makeGraph = (order) => {
    const g = new Graph({ rev: REV });
    for (const k of order) g.upsertNode(createNode({ kind: "class", name: k, rev: REV }));
    g.upsertEdge(makeEdge(ids[0], ids[1], "a.cs", 1));
    g.upsertEdge(makeEdge(ids[2], ids[0], "b.cs", 2));
    return g;
  };
  const asForm = (g) => ({ nodes: g.nodes(), edges: g.edges() });

  it("emite los nodos ordenados por id, no por inserción", () => {
    const form = graphCanonicalForm(asForm(makeGraph(["C", "A", "B"])));
    const emitted = form.nodes.map((n) => n.id);
    expect(emitted).toEqual([...emitted].sort());
    expect(emitted).toEqual([ids[0], ids[1], ids[2]].sort());
  });

  it("emite los edges ordenados por id, no por inserción", () => {
    const form = graphCanonicalForm(asForm(makeGraph(["A"])));
    const emitted = form.edges.map((e) => e.id);
    expect(emitted).toEqual([...emitted].sort());
    // ids de edge derivados del contenido, estables e independientes del orden
    expect(form.edges[0].evidence.file).toBe("a.cs");
  });

  it("el JSON canónico del grafo es byte-idéntico bajo distinto orden de inserción", () => {
    expect(graphCanonicalString(asForm(makeGraph(["C", "A", "B"])))).toBe(
      graphCanonicalString(asForm(makeGraph(["B", "C", "A"]))),
    );
  });

  it("el JSON canónico es estable entre dos construcciones del mismo contenido", () => {
    const a = graphCanonicalString(asForm(makeGraph(["A", "B", "C"])));
    const b = graphCanonicalString(asForm(makeGraph(["A", "B", "C"])));
    expect(a).toBe(b);
    expect(graphCanonicalHash(asForm(makeGraph(["A", "B", "C"])))).toBe(
      canonicalHash(JSON.parse(a)),
    );
  });

  it("un cambio semántico altera el JSON canónico", () => {
    const base = makeGraph(["A", "B", "C"]);
    base.upsertNode(createNode({ kind: "class", name: "D", rev: REV }));
    expect(graphCanonicalString(asForm(base))).not.toBe(
      graphCanonicalString(asForm(makeGraph(["A", "B", "C"]))),
    );
  });
});
