import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GraphStore,
  Workspace,
  createWorkspace,
  ingestRepo,
} from "../../src/store/index.mjs";
import {
  createNode,
  createEdge,
  createRevision,
  makeNodeId,
  makeEdgeId,
  graphCanonicalHash,
} from "../../src/model/index.mjs";

const FIXTURE = new URL("../../tests/fixtures/repo/", import.meta.url).pathname;

const REV = "0f84a6a5d5436929353e51899bd41b10f72d8ded";
const REV2 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const sha256hex = /^[0-9a-f]{64}$/;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "iagraph-store-"));
  cpSync(FIXTURE, dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "unit@iagraph.local");
  git(dir, "config", "user.name", "unit");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "fixture: base");
  return dir;
}

function sampleNode(kind, name, file, lineStart, rev = REV) {
  return createNode({ kind, name, qualifiedName: name, file, lineStart, rev });
}

function sampleEdge(src, dst, kind, file, lineStart, rev = REV) {
  return createEdge({
    src,
    dst,
    kind,
    nature: "EXTRACTED",
    extractor: "test",
    extractorVersion: "0.1.0",
    evidence: { file, lineStart, rev },
  });
}

let repo;
beforeAll(() => {
  repo = makeFixtureRepo();
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("GraphStore · SQLite sobre node:sqlite", () => {
  it("un store respaldado por archivo corre en modo WAL", () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-wal-"));
    try {
      const store = new GraphStore({ path: join(dir, "graph.db") });
      expect(store._db.prepare("PRAGMA journal_mode").get().journal_mode).toBe("wal");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expone su ruta y admite close() idempotente", () => {
    const store = new GraphStore({ path: ":memory:" });
    expect(store.path).toBe(":memory:");
    expect(() => store.close()).not.toThrow();
    expect(() => store.close()).not.toThrow();
  });
});

describe("A4 · el grafo es consciente de la revisión", () => {
  it("upsertNodes estampa firstSeenRev y lastSeenRev a la revisión", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      store.upsertNodes([sampleNode("class", "A", "a.cs", 1)], REV);
      const n = store.getNode(makeNodeId("class", "A"));
      expect(n.firstSeenRev).toBe(REV);
      expect(n.lastSeenRev).toBe(REV);
    } finally {
      store.close();
    }
  });

  it("upsertEdges estampa observedInRev, firstSeenRev y lastSeenRev", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      const a = makeNodeId("class", "A");
      const b = makeNodeId("class", "B");
      store.upsertEdges([sampleEdge(a, b, "calls", "a.cs", 3)], REV);
      const edges = store.getEdges({});
      expect(edges).toHaveLength(1);
      expect(edges[0].observedInRev).toBe(REV);
      expect(edges[0].firstSeenRev).toBe(REV);
      expect(edges[0].lastSeenRev).toBe(REV);
    } finally {
      store.close();
    }
  });

  it("una re-upsert conserva firstSeenRev y avanza lastSeenRev", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      store.upsertNodes([sampleNode("class", "A", "a.cs", 1)], REV);
      store.upsertNodes([sampleNode("class", "A", "a.cs", 5)], REV2);
      const n = store.getNode(makeNodeId("class", "A"));
      expect(n.firstSeenRev).toBe(REV);
      expect(n.lastSeenRev).toBe(REV2);
    } finally {
      store.close();
    }
  });

  it("una re-upsert de edge conserva firstSeenRev y avanza observedInRev/lastSeenRev", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      const a = makeNodeId("class", "A");
      const b = makeNodeId("class", "B");
      const e = sampleEdge(a, b, "calls", "a.cs", 3);
      store.upsertEdges([e], REV);
      store.upsertEdges([e], REV2);
      const got = store.getEdge(e.id);
      expect(got.observedInRev).toBe(REV2);
      expect(got.firstSeenRev).toBe(REV);
      expect(got.lastSeenRev).toBe(REV2);
    } finally {
      store.close();
    }
  });

  it("un build de Workspace ancla todos los edges a la revisión de HEAD (A4)", async () => {
    const ws = createWorkspace(repo, { storePath: ":memory:" });
    try {
      await ws.addRepo({ path: repo, role: "api" });
      const report = await ws.build();
      expect(report.revision).toBe(git(repo, "rev-parse", "HEAD").trim());
      const edges = await ws.store.getEdges({});
      expect(edges.length).toBeGreaterThan(0);
      expect(edges.every((e) => e.observedInRev === report.revision)).toBe(true);
      const nodes = await ws.store.findNodes({});
      expect(nodes.every((n) => n.firstSeenRev && n.lastSeenRev)).toBe(true);
    } finally {
      ws.store.close();
    }
  });
});

describe("A5 · ids estables entre construcciones de la misma revisión", () => {
  it("dos stores con los mismos nodos y edges producen los mismos ids", () => {
    const mk = () => {
      const store = new GraphStore({ path: ":memory:" });
      const a = sampleNode("class", "A", "a.cs", 1);
      const b = sampleNode("class", "B", "b.cs", 1);
      store.upsertNodes([b, a], REV);
      store.upsertEdges([sampleEdge(a.id, b.id, "calls", "a.cs", 3)], REV);
      return store;
    };
    const s1 = mk();
    const s2 = mk();
    try {
      expect(s1.findNodes({}).map((n) => n.id).sort()).toEqual(
        s2.findNodes({}).map((n) => n.id).sort(),
      );
      expect(s1.getEdges({}).map((e) => e.id).sort()).toEqual(
        s2.getEdges({}).map((e) => e.id).sort(),
      );
      expect(s1.canonicalHash()).toBe(s2.canonicalHash());
    } finally {
      s1.close();
      s2.close();
    }
  });

  it("el id derivado del modelo es estable bajo reordenación de evidencia", () => {
    const a = makeNodeId("class", "A");
    const b = makeNodeId("class", "B");
    const e1 = sampleEdge(a, b, "calls", "a.cs", 3);
    expect(e1.id).toBe(
      makeEdgeId({ src: a, dst: b, kind: "calls", evidence: { file: "a.cs", lineStart: 3 } }),
    );
  });

  it("dos builds de Workspace sobre el mismo repo coinciden en ids y hash", async () => {
    const build = async () => {
      const ws = createWorkspace(repo, { storePath: ":memory:" });
      await ws.addRepo({ path: repo, role: "api" });
      await ws.build();
      return ws;
    };
    const w1 = await build();
    const w2 = await build();
    try {
      const ids1 = (await w1.store.findNodes({})).map((n) => n.id).sort();
      const ids2 = (await w2.store.findNodes({})).map((n) => n.id).sort();
      expect(ids2).toEqual(ids1);
      const e1 = (await w1.store.getEdges({})).map((e) => e.id).sort();
      const e2 = (await w2.store.getEdges({})).map((e) => e.id).sort();
      expect(e2).toEqual(e1);
      expect(await w2.canonicalHash()).toBe(await w1.canonicalHash());
    } finally {
      w1.store.close();
      w2.store.close();
    }
  });
});

describe("regla 1 · todo edge lleva evidencia con archivo y línea", () => {
  it("upsertEdges rechaza un edge sin evidencia", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      expect(() =>
        store.upsertEdges(
          [{ src: "a", dst: "b", kind: "calls", nature: "EXTRACTED", extractor: "x", extractorVersion: "1" }],
          REV,
        ),
      ).toThrow(/evidence/);
    } finally {
      store.close();
    }
  });

  it("todo edge leído de vuelta conserva file y lineStart enteros", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      const a = makeNodeId("class", "A");
      const b = makeNodeId("class", "B");
      store.upsertEdges([sampleEdge(a, b, "implements", "api/Orders.cs", 21)], REV);
      const edges = store.getEdges({});
      for (const e of edges) {
        expect(e.evidence.file).toBe("api/Orders.cs");
        expect(Number.isInteger(e.evidence.lineStart)).toBe(true);
        expect(e.evidence.lineStart).toBeGreaterThan(0);
      }
    } finally {
      store.close();
    }
  });

  it("la evidencia sin rev la hereda de observedInRev al persistir (regla 5)", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      const a = makeNodeId("class", "A");
      const b = makeNodeId("class", "B");
      const edge = createEdge({
        src: a,
        dst: b,
        kind: "calls",
        nature: "EXTRACTED",
        extractor: "test",
        extractorVersion: "0.1.0",
        evidence: { file: "a.cs", lineStart: 3 },
        observedInRev: REV,
      });
      store.upsertEdges([edge], REV);
      expect(store.getEvidence(edge.id).rev).toBe(REV);
    } finally {
      store.close();
    }
  });
});

describe("accesores de consulta", () => {
  it("getNode y getEdge devuelven null cuando no existen", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      expect(store.getNode("class:Nope")).toBeNull();
      expect(store.getEdge("x->y@f:1")).toBeNull();
      expect(store.getEvidence("nope")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("findNodes filtra por kind y por archivo, y ordena por id", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      store.upsertNodes(
        [
          sampleNode("class", "B", "b.cs", 1),
          sampleNode("class", "A", "a.cs", 1),
          sampleNode("interface", "I", "a.cs", 1),
        ],
        REV,
      );
      const classes = store.findNodes({ kind: "class" });
      expect(classes.map((n) => n.name).sort()).toEqual(["A", "B"]);
      const inA = store.findNodes({ file: "a.cs" });
      expect(inA.map((n) => n.name).sort()).toEqual(["A", "I"]);
      expect(store.findNodes({}).length).toBe(3);
      const ids = store.findNodes({}).map((n) => n.id);
      expect(ids).toEqual([...ids].sort());
    } finally {
      store.close();
    }
  });

  it("getEdges filtra por src, dst, kind y naturaleza, y combina filtros", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      const a = makeNodeId("class", "A");
      const b = makeNodeId("class", "B");
      store.upsertNodes([sampleNode("class", "A", "a.cs", 1), sampleNode("class", "B", "b.cs", 1)], REV);
      store.upsertEdges(
        [
          sampleEdge(a, b, "calls", "a.cs", 3),
          sampleEdge(a, b, "references", "b.cs", 4),
        ],
        REV,
      );
      expect(store.getEdges({ kind: "calls" })).toHaveLength(1);
      expect(store.getEdges({ src: a, dst: b })).toHaveLength(2);
      expect(store.getEdges({ kind: "calls", nature: "EXTRACTED" })).toHaveLength(1);
      expect(store.getEdges({ kind: "calls", nature: "INFERRED" })).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("getEvidence devuelve la evidencia del edge", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      const a = makeNodeId("class", "A");
      const b = makeNodeId("class", "B");
      const e = sampleEdge(a, b, "calls", "a.cs", 3);
      store.upsertEdges([e], REV);
      expect(store.getEvidence(e.id)).toEqual({ file: "a.cs", lineStart: 3, rev: REV });
    } finally {
      store.close();
    }
  });
});

describe("serialización canónica integrada", () => {
  it("canonicalHash es estable sin importar el orden de inserción", () => {
    const mk = (order) => {
      const store = new GraphStore({ path: ":memory:" });
      const a = sampleNode("class", "A", "a.cs", 1);
      const b = sampleNode("class", "B", "b.cs", 1);
      const e = sampleEdge(a.id, b.id, "calls", "a.cs", 3);
      for (const i of order) store.upsertNodes([order === order ? [a, b][i] : a], REV);
      store.upsertEdges([e], REV);
      return store;
    };
    const s1 = mk([0, 1]);
    const s2 = mk([1, 0]);
    try {
      expect(s1.canonicalHash()).toBe(s2.canonicalHash());
      expect(s1.canonicalHash()).toMatch(sha256hex);
    } finally {
      s1.close();
      s2.close();
    }
  });

  it("el hash del store coincide con graphCanonicalHash de lo leído", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      const a = sampleNode("class", "A", "a.cs", 1);
      const b = sampleNode("class", "B", "b.cs", 1);
      store.upsertNodes([a, b], REV);
      store.upsertEdges([sampleEdge(a.id, b.id, "calls", "a.cs", 3)], REV);
      expect(store.canonicalHash()).toBe(
        graphCanonicalHash({ nodes: store.findNodes({}), edges: store.getEdges({}) }),
      );
    } finally {
      store.close();
    }
  });

  it("la metadata operacional no altera el hash (regla 7)", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      const base = sampleNode("class", "A", "a.cs", 1);
      store.upsertNodes([{ ...base, metadata: { builtAt: "2026-09-16", durationMs: 42 } }], REV);
      const h1 = store.canonicalHash();
      store.upsertNodes([base], REV);
      expect(store.canonicalHash()).toBe(h1);
    } finally {
      store.close();
    }
  });
});

describe("revisiones", () => {
  it("recordRevision guarda y re-expone la revisión, omitiendo los opcionales", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      store.recordRevision(createRevision({ sha: REV }));
      store.recordRevision(createRevision({ sha: REV2, parent: REV, summary: "next" }));
      const revs = store.revisions();
      expect(revs).toHaveLength(2);
      expect(revs[0]).toEqual({ sha: REV });
      expect(revs[1]).toEqual({ sha: REV2, parent: REV, summary: "next" });
      expect(store.lastRevision()).toBe(REV2);
    } finally {
      store.close();
    }
  });

  it("rechaza revisiones sin sha", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      expect(store.recordRevision({ sha: "" })).toBeNull();
      expect(store.recordRevision({})).toBeNull();
      expect(store.revisions()).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("borrado", () => {
  it("removeNode elimina el nodo y los edges que lo referencian", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      const a = sampleNode("class", "A", "a.cs", 1);
      const b = sampleNode("class", "B", "b.cs", 1);
      store.upsertNodes([a, b], REV);
      store.upsertEdges(
        [sampleEdge(a.id, b.id, "calls", "a.cs", 3), sampleEdge(b.id, a.id, "references", "b.cs", 2)],
        REV,
      );
      expect(store.getEdges({})).toHaveLength(2);
      const removed = store.removeNode(a.id);
      expect(removed).not.toBeNull();
      expect(store.getNode(a.id)).toBeNull();
      expect(store.getEdges({})).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("removeEdge elimina un solo edge", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      const a = makeNodeId("class", "A");
      const b = makeNodeId("class", "B");
      const e = sampleEdge(a, b, "calls", "a.cs", 3);
      store.upsertEdges([e], REV);
      expect(store.removeEdge(e.id)).not.toBeNull();
      expect(store.getEdges({})).toHaveLength(0);
      expect(store.removeEdge(e.id)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("clear() deja el store vacío", () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      store.upsertNodes([sampleNode("class", "A", "a.cs", 1)], REV);
      store.upsertEdges([sampleEdge(makeNodeId("class", "A"), makeNodeId("class", "B"), "calls", "a.cs", 3)], REV);
      store.recordRevision(createRevision({ sha: REV }));
      store.clear();
      expect(store.findNodes({})).toEqual([]);
      expect(store.getEdges({})).toEqual([]);
      expect(store.revisions()).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("Workspace", () => {
  it("createWorkspace produce un Workspace con su store y dir", async () => {
    const ws = createWorkspace(repo, { storePath: ":memory:" });
    try {
      expect(ws).toBeInstanceOf(Workspace);
      expect(ws.store).toBeInstanceOf(GraphStore);
      expect(ws.dir).toBe(repo);
    } finally {
      ws.store.close();
    }
  });

  it("build() ingiere repository + file + el analizador C#, todo con evidencia", async () => {
    const ws = createWorkspace(repo, { storePath: ":memory:" });
    try {
      await ws.addRepo({ path: repo, role: "api" });
      const report = await ws.build();
      expect(report.nodeCount).toBeGreaterThan(0);
      expect(report.edgeCount).toBeGreaterThan(0);
      const contains = await ws.store.getEdges({ kind: "contains" });
      expect(contains.length).toBeGreaterThan(0);
      expect(contains.length).toBeLessThanOrEqual(report.edgeCount);
      for (const e of contains) {
        expect(e.evidence.file).toBeTruthy();
        expect(Number.isInteger(e.evidence.lineStart)).toBe(true);
      }
      const files = await ws.store.findNodes({ kind: "file" });
      expect(files.length).toBeGreaterThan(0);
      // the C# analyzer runs during build: classes, implements edges, evidence
      const classes = await ws.store.findNodes({ kind: "class" });
      expect(classes.map((n) => n.name)).toContain("OrderService");
      const implements_ = await ws.store.getEdges({ kind: "implements" });
      expect(implements_.length).toBeGreaterThan(0);
    } finally {
      ws.store.close();
    }
  });

  it("ingestRepo devuelve la revisión y los conteos", async () => {
    const store = new GraphStore({ path: ":memory:" });
    try {
      const result = await ingestRepo(store, { path: repo, role: "lib" }, {});
      expect(result.rev).toBe(git(repo, "rev-parse", "HEAD").trim());
      expect(result.repoId).toBe(makeNodeId("repository", repo.replace(/\/+$/, "")));
      expect(result.files).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });
});