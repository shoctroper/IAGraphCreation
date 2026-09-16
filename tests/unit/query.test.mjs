// Unit tests for the query slice (spine step 7, docs/API.md "Consulta").
//
// search/explain/path/impact answer structural questions over the stored graph
// and every answer is traceable to evidence (docs/API.md reglas 1-2):
//   - D1: search returns nodes that already live in the store, each with its
//     own evidence;
//   - D2: explain reports incoming, outgoing, evidence and the store's current
//     revision — never a revision held in memory (regla 5);
//   - D3: path hops are stored edges or containment read off stored evidence,
//     each citing {file, lineStart};
//   - D4: impact delimits the affected area by file, node, kind or orphans;
//   - D5: no query result ever invents a node that is not in the store.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { search, explain, path, impact } from "../../src/query/index.mjs";
import { buildAdjacency } from "../../src/query/navigation.mjs";
import { createWorkspace } from "../../src/store/index.mjs";

const FIXTURE = new URL("../../tests/fixtures/repo/", import.meta.url).pathname;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let repo, ws, rev;
beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "iagraph-query-"));
  cpSync(FIXTURE, repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "unit@iagraph.local");
  git(repo, "config", "user.name", "unit");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "fixture: base");
  ws = createWorkspace(repo, { storePath: ":memory:" });
  await ws.addRepo({ path: repo, role: "api" });
  const report = await ws.build();
  rev = report.revision;
});
afterAll(() => {
  ws.store.close();
  rmSync(repo, { recursive: true, force: true });
});

describe("D1 · search encuentra dónde vive una funcionalidad", () => {
  it("encuentra nodos del store con su evidencia", async () => {
    const r = await search(ws, "orders");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].node.id).toBe("class:Fixture.Api.Orders");
    expect(r[0].score).toBe(1000);
    expect(r[0].evidence.file).toBe("api/OrdersApi.cs");
  });

  it("el nombre exacto puntúa por encima de una coincidencia parcial", async () => {
    const r = await search(ws, "OrderService");
    expect(r[0].node.id).toBe("class:Fixture.Api.OrderService");
  });

  it("respeta el límite y filtra por kind", async () => {
    expect((await search(ws, "orders", { limit: 1 })).length).toBe(1);
    const only = await search(ws, "order", { kind: "interface" });
    expect(only.map((h) => h.node.id)).toEqual(["interface:Fixture.Api.IOrderService"]);
  });

  it("una consulta vacía o sin aciertos devuelve una lista vacía", async () => {
    expect(await search(ws, "   ")).toEqual([]);
    expect(await search(ws, "zzzz-no-existe")).toEqual([]);
  });

  it("es determinista: la misma consulta devuelve el mismo orden", async () => {
    const a = await search(ws, "order");
    const b = await search(ws, "order");
    expect(b.map((h) => h.node.id)).toEqual(a.map((h) => h.node.id));
  });
});

describe("D2 · explain devuelve entrantes, salientes y evidencia", () => {
  it("reporta node, incoming, outgoing, evidence y la revisión del store", async () => {
    const iface = ws.store.findNodes({ kind: "interface" })[0];
    const r = await explain(ws, iface.id);
    expect(r.node.name).toBe("IOrderService");
    expect(r.incoming.some((e) => e.kind === "implements")).toBe(true);
    expect(r.outgoing.some((e) => e.kind === "binds_implementation")).toBe(true);
    expect(r.evidence.length).toBeGreaterThan(0);
    expect(r.evidence[0].file).toBeTruthy();
    expect(r.revision).toBe(rev);
    expect(r.revision).toBe(ws.store.lastRevision());
  });

  it("devuelve null para un nodo que no está en el store", async () => {
    expect(await explain(ws, "class:NoExiste")).toBeNull();
  });
});

describe("D3 · path conecta dos nodos y cada salto cita su evidencia", () => {
  it("encuentra un camino del endpoint a la interfaz con evidencia en cada salto", async () => {
    const ep = ws.store.findNodes({ kind: "endpoint" })[0];
    const svc = ws.store.findNodes({ kind: "interface" })[0];
    const r = await path(ws, ep.id, svc.id);
    expect(r.found).toBe(true);
    expect(r.hops.length).toBeGreaterThan(0);
    expect(r.hops.every((h) => h.evidence?.file && h.evidence?.lineStart > 0)).toBe(true);
    // los nodos recorridos existen en el store (regla 2: no se fabrican)
    for (const h of r.hops) {
      for (const id of [h.edge.src, h.edge.dst]) {
        expect(ws.store.getNode(id), `nodo inventado ${id}`).toBeTruthy();
      }
    }
  });

  it("el camino une el endpoint y la interfaz por edges reales del store", async () => {
    const ep = ws.store.findNodes({ kind: "endpoint" })[0];
    const svc = ws.store.findNodes({ kind: "interface" })[0];
    const r = await path(ws, ep.id, svc.id);
    // BFS navega las aristas en ambos sentidos: cada salto es un edge del store
    const first = r.hops[0].edge;
    expect([first.src, first.dst]).toContain(ep.id);
    const last = r.hops.at(-1).edge;
    expect([last.src, last.dst]).toContain(svc.id);
    for (const h of r.hops) {
      // cada salto es o bien un edge persistido, o bien una contención derivada
      // de la evidencia del nodo (navegación); en ambos casos los nodos existen
      // y la evidencia es real (regla 1)
      expect([h.edge.src, h.edge.dst].every((id) => ws.store.getNode(id))).toBe(true);
      expect(h.evidence?.file).toBeTruthy();
      expect(h.evidence?.lineStart).toBeGreaterThan(0);
    }
  });

  it("devuelve found=false cuando un extremo no existe y hops vacío cuando es el mismo nodo", async () => {
    const iface = ws.store.findNodes({ kind: "interface" })[0];
    expect(await path(ws, "class:NoExiste", iface.id)).toEqual({ found: false, hops: [] });
    expect(await path(ws, iface.id, iface.id)).toEqual({ found: true, hops: [] });
  });
});

describe("D4 · impact delimita el área afectada por un cambio", () => {
  it("por archivo: los nodos declarados en el archivo y sus edges internos", async () => {
    const r = await impact(ws, { file: "api/Orders.cs" });
    expect(r.nodes.length).toBeGreaterThan(0);
    expect(r.reason).toBeTruthy();
    for (const n of r.nodes) expect(ws.store.getNode(n.id)).toBeTruthy();
    expect(r.edges.every((e) => e.evidence?.file && e.evidence?.lineStart > 0)).toBe(true);
  });

  it("por nodeId y por string: un nodo y sus edges incidentes", async () => {
    const iface = ws.store.findNodes({ kind: "interface" })[0];
    const r = await impact(ws, iface.id);
    expect(r.nodes.map((n) => n.id)).toEqual([iface.id]);
    expect(r.edges.length).toBe(2);
    const r2 = await impact(ws, { nodeId: iface.id });
    expect(r2.nodes.map((n) => n.id)).toEqual([iface.id]);
  });

  it("por kind: todos los nodos de ese kind", async () => {
    const r = await impact(ws, { kind: "class" });
    const classes = ws.store.findNodes({ kind: "class" });
    expect(r.nodes.map((n) => n.id).sort()).toEqual(classes.map((n) => n.id).sort());
    expect(r.reason).toContain("class");
  });

  it("withoutConsumers: endpoints sin consumidor, sin inventar ninguno", async () => {
    const r = await impact(ws, { kind: "endpoint", withoutConsumers: true });
    const consumers = new Set(ws.store.getEdges({ kind: "calls_endpoint" }).map((e) => e.dst));
    expect(r.nodes.every((n) => !consumers.has(n.id))).toBe(true);
  });

  it("objetivos desconocidos devuelven una respuesta vacía honesta", async () => {
    expect(await impact(ws, { nodeId: "class:NoExiste" })).toMatchObject({ nodes: [] });
    expect(await impact(ws, "class:NoExiste")).toMatchObject({ nodes: [] });
    expect(await impact(ws, {})).toMatchObject({ nodes: [], edges: [] });
  });
});

describe("D5 · la consulta nunca devuelve un nodo que no esté en el store", () => {
  it("search: todo acierto es un nodo del store", async () => {
    for (const hit of await search(ws, "order")) {
      expect(ws.store.getNode(hit.node.id)).toBeTruthy();
    }
  });

  it("impact y explain también responden sólo con nodos del store", async () => {
    const imp = await impact(ws, { file: "api/Orders.cs" });
    for (const n of imp.nodes) expect(ws.store.getNode(n.id)).toBeTruthy();
    const ex = await explain(ws, ws.store.findNodes({ kind: "interface" })[0].id);
    expect(ws.store.getNode(ex.node.id)).toBeTruthy();
  });
});

describe("buildAdjacency · el grafo de navegación no fabrica nodos", () => {
  it("los vecinos derivados de la contención existen como file en el store", async () => {
    const adj = buildAdjacency(ws.store);
    const fileIds = new Set(ws.store.findNodes({ kind: "file" }).map((n) => n.id));
    for (const [from, neighbours] of adj) {
      for (const n of neighbours) {
        expect(ws.store.getNode(n.node), `vecino inventado ${n.node}`).toBeTruthy();
      }
    }
    // cada salto de contención derivado apunta a un file real del store
    const iface = ws.store.findNodes({ kind: "interface" })[0];
    const fromIface = adj.get(iface.id) ?? [];
    for (const n of fromIface) {
      if (n.edge.kind === "contains" && n.edge.nature === "INFERRED") {
        expect(fileIds.has(n.node)).toBe(true);
        expect(n.evidence.file).toBeTruthy();
        expect(n.evidence.lineStart).toBeGreaterThan(0);
      }
    }
  });

  it("toda arista lleva evidencia con archivo y línea (regla 1)", async () => {
    const adj = buildAdjacency(ws.store);
    for (const neighbours of adj.values()) {
      for (const n of neighbours) {
        expect(n.evidence.file, `sin archivo en ${n.edge.id}`).toBeTruthy();
        expect(Number.isInteger(n.evidence.lineStart)).toBe(true);
        expect(n.evidence.lineStart).toBeGreaterThan(0);
      }
    }
  });
});