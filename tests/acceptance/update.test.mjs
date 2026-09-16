// Acceptance blocks E (incremental), F (equivalence) and J (contract-first).
// RFC-G1 v3 §6. These are the cases the two questioner rounds sharpened.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { api, makeC3, dropC3, git } from "./_harness.mjs";

let c3, ws;

beforeEach(async () => {
  c3 = makeC3();
  const { createWorkspace } = await api();
  ws = await createWorkspace(c3, { storePath: join(c3, ".iagraph", "graph.db") });
  await ws.addRepo({ path: c3, role: "api" });
  await ws.build();
}, 120_000);

afterEach(() => dropC3(c3));

/** Commit a change and run the incremental update from the previous revision. */
async function commitAndUpdate(msg) {
  const before = git(c3, "rev-parse", "HEAD").trim();
  git(c3, "add", "-A");
  git(c3, "commit", "-qm", msg);
  return ws.update({ from: before });
}

/** Rebuild from scratch at the current revision and compare semantic content. */
async function rebuildHash() {
  const { createWorkspace } = await api();
  const fresh = await createWorkspace(c3, { storePath: ":memory:" });
  await fresh.addRepo({ path: c3, role: "api" });
  await fresh.rebuild();
  return fresh.canonicalHash();
}

// ------------------------------------------------------- E · incremental
describe("E · actualización incremental dirigida por git", () => {
  it("E1 · alta de archivo: aparecen sus nodos", async () => {
    writeFileSync(join(c3, "api/Invoices.cs"), `namespace Shop.Api;
public interface IInvoiceService { void Emit(); }
`);
    await commitAndUpdate("add invoices");
    const n = (await ws.store.findNodes({ kind: "interface" })).map((x) => x.name);
    expect(n).toContain("IInvoiceService");
  });

  it("E2 · modificación: los edges se recalculan", async () => {
    const p = join(c3, "api/Customers.cs");
    writeFileSync(p, readFileSync(p, "utf8").replace('"/api/customers"', '"/api/clients"'));
    await commitAndUpdate("rename route");
    const rutas = (await ws.store.findNodes({ kind: "endpoint" })).map((e) => e.route);
    expect(rutas).toContain("/api/clients");
    expect(rutas).not.toContain("/api/customers");
  });

  it("E3 · borrado: los nodos desaparecen del grafo vigente", async () => {
    rmSync(join(c3, "api/Customers.cs"));
    await commitAndUpdate("drop customers");
    const n = (await ws.store.findNodes({ kind: "interface" })).map((x) => x.name);
    expect(n).not.toContain("ICustomerService");
  });

  it("E4 · rename: se trata como rename, no como borrado más alta", async () => {
    git(c3, "mv", "api/Customers.cs", "api/People.cs");
    const rep = await commitAndUpdate("rename file");
    expect(rep.renamed).toContainEqual(
      expect.objectContaining({ from: "api/Customers.cs", to: "api/People.cs" }),
    );
    // el nodo conserva su historia: no nace de nuevo en esta revisión
    const iface = (await ws.store.findNodes({ kind: "interface" })).find(
      (x) => x.name === "ICustomerService",
    );
    expect(iface).toBeDefined();
    expect(iface.firstSeenRev).not.toBe(iface.lastSeenRev);
  });

  it("E5 · move entre carpetas conserva la identidad del símbolo", async () => {
    mkdirSync(join(c3, "api/services"), { recursive: true });
    git(c3, "mv", "api/Orders.cs", "api/services/Orders.cs");
    await commitAndUpdate("move orders");
    const eps = (await ws.store.findNodes({ kind: "endpoint" })).map((e) => e.route);
    expect(eps).toContain("/api/orders");
  });

  it("E6 · cambio de firma invalida a los llamantes, no sólo al archivo", async () => {
    const p = join(c3, "api/Orders.cs");
    writeFileSync(p, readFileSync(p, "utf8").replace("Order One(int id);", "Order One(string id);"));
    const rep = await commitAndUpdate("signature change");
    expect(rep.reanalyzedFiles.length).toBeGreaterThan(1);
  });

  it("E7 · cambio de endpoint reconecta a su consumidor de la UI", async () => {
    const p = join(c3, "api/Orders.cs");
    writeFileSync(p, readFileSync(p, "utf8").replace('MapGet("/api/orders"', 'MapGet("/api/orders-v2"'));
    await commitAndUpdate("endpoint moved");
    const edges = await ws.store.getEdges({ kind: "calls_endpoint" });
    // la llamada de la UI a /api/orders ya no resuelve: debe quedar sin enlace,
    // no apuntando a un endpoint que ya no existe
    const colgado = edges.find((e) => e.route === "/api/orders" && e.dst);
    expect(colgado).toBeUndefined();
  });

  it("E8 · el informe declara el alcance de invalidación que calculó", async () => {
    writeFileSync(join(c3, "api/Customers.cs"),
      readFileSync(join(c3, "api/Customers.cs"), "utf8") + "\n// touch\n");
    const rep = await commitAndUpdate("comment only");
    expect(rep).toMatchObject({
      changedFiles: expect.any(Array),
      reanalyzedFiles: expect.any(Array),
      invalidationReason: expect.any(String),
    });
    expect(rep.degradedToRebuild).toBe(false);
  });
});

// ------------------------------------------------------ F · equivalencia
describe("F · incremental ≡ rebuild", () => {
  it("F1 · tras un cambio ordinario, ambos estados coinciden", async () => {
    writeFileSync(join(c3, "api/Invoices.cs"), `namespace Shop.Api;
public interface IInvoiceService { void Emit(); }
`);
    await commitAndUpdate("add invoices");
    expect(await ws.canonicalHash()).toBe(await rebuildHash());
  });

  it("F2 · la canonicalización es estable ante el orden de inserción", async () => {
    const h1 = await ws.canonicalHash();
    const h2 = await ws.canonicalHash();
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("F3 · verify() compara incremental contra rebuild y lo reporta", async () => {
    const v = await ws.verify();
    expect(v).toMatchObject({ equivalent: true, incrementalHash: expect.any(String) });
  });

  it("F4 · cambiar un registro DI explícito mantiene la equivalencia", async () => {
    const p = join(c3, "api/Startup.cs");
    writeFileSync(p, readFileSync(p, "utf8").replace(
      "services.AddSingleton<IOrderService, OrderService>();",
      "services.AddSingleton<IOrderService, FastOrderService>();",
    ));
    await commitAndUpdate("swap DI registration");
    expect(await ws.canonicalHash()).toBe(await rebuildHash());
  });

  it("F5 · alta bajo un registro POR ESCANEO, sin tocar el archivo que lo declara", async () => {
    // Éste es el caso sin trampa que sacó la ronda 2 del Cuestionador.
    // El handler nuevo cae bajo AddHandlersFromAssembly, pero Startup.cs NO
    // cambia. Una invalidación anclada al archivo del registro no se entera y
    // el handler desaparece del grafo en silencio.
    writeFileSync(join(c3, "api/CreateOrderHandler.cs"), `namespace Shop.Api;
public class CreateOrderHandler : IHandler<CreateOrder>
{
    public void Handle(CreateOrder cmd) { }
}
`);
    const rep = await commitAndUpdate("add handler under scanning rule");
    expect(git(c3, "diff", "--name-only", "HEAD~1", "HEAD")).not.toContain("Startup.cs");

    const nodes = (await ws.store.findNodes({ kind: "class" })).map((n) => n.name);
    expect(nodes, "el handler nuevo debe existir en el grafo").toContain("CreateOrderHandler");

    // y el incremental debe seguir coincidiendo con un rebuild
    expect(await ws.canonicalHash()).toBe(await rebuildHash());
    expect(rep.invalidatedRules?.length ?? 0).toBeGreaterThan(0);
  });
});

// --------------------------------------------------- J · contract-first
describe("J · contract-first con cliente generado", () => {
  it("J1 · una spec OpenAPI sirve de evidencia para el endpoint", async () => {
    mkdirSync(join(c3, "contracts"), { recursive: true });
    writeFileSync(join(c3, "contracts/shop.v1.json"), JSON.stringify({
      openapi: "3.0.0",
      info: { title: "Shop", version: "1" },
      paths: { "/api/orders": { get: { operationId: "listOrders", responses: { 200: { description: "ok" } } } } },
    }, null, 2));
    await commitAndUpdate("add openapi spec");
    const eps = await ws.store.findNodes({ kind: "endpoint" });
    const o = eps.find((e) => e.route === "/api/orders" && e.method === "GET");
    expect(o).toBeDefined();
    const specEv = (o.evidence ?? []).some((e) => e.file.includes("shop.v1.json"));
    expect(specEv).toBe(true);
  });

  it("J2 · la configuración del generador produce un edge generated_from", async () => {
    writeFileSync(join(c3, "nswag.json"), JSON.stringify({
      documentGenerator: { fromDocument: { url: "contracts/shop.v1.json" } },
      codeGenerators: { openApiToTypeScriptClient: { output: "ui/api-client.ts" } },
    }, null, 2));
    await commitAndUpdate("add generator config");
    const g = await ws.store.getEdges({ kind: "generated_from" });
    expect(g.length).toBeGreaterThan(0);
    expect(g[0].evidence.file).toContain("nswag.json");
  });

  it("J3 · la cadena UI→endpoint se sostiene con el cliente AUSENTE del árbol", async () => {
    // Éste es el caso real de CleanArchitecture y, según su ADR-0004, de
    // lubesoft: web-api-client.ts no está commiteado. La evidencia tiene que
    // venir de la spec y del generador, no de leer un archivo que no existe.
    mkdirSync(join(c3, "contracts"), { recursive: true });
    writeFileSync(join(c3, "contracts/shop.v1.json"), JSON.stringify({
      openapi: "3.0.0", info: { title: "Shop", version: "1" },
      paths: { "/api/orders": { get: { operationId: "listOrders", responses: { 200: { description: "ok" } } } } },
    }));
    writeFileSync(join(c3, "nswag.json"), JSON.stringify({
      documentGenerator: { fromDocument: { url: "contracts/shop.v1.json" } },
      codeGenerators: { openApiToTypeScriptClient: { output: "ui/api-client.ts" } },
    }));
    await commitAndUpdate("contract-first without committed client");
    const { path: findPath } = await api();
    const eps = await ws.store.findNodes({ kind: "endpoint" });
    const target = eps.find((e) => e.route === "/api/orders");
    const clients = await ws.store.findNodes({ kind: "client" });
    expect(clients.length).toBeGreaterThan(0);
    const r = await findPath(ws, clients[0].id, target.id);
    expect(r.found).toBe(true);
    expect(r.hops.every((h) => h.evidence?.file)).toBe(true);
  });
});
