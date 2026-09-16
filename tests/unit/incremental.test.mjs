// Unit coverage for spine step 6 (src/incremental): the git-diff-driven
// engine that turns a commit into a precise mutation of the graph.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace } from "../../src/store/index.mjs";
import {
  gitDiff,
  updateRepository,
  computeRegion,
  buildTypeIndexFromStore,
} from "../../src/incremental/index.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

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

public interface IOrderService
{
    Order[] All();
    Order One(int id);
}

public class OrderService : IOrderService
{
    public Order[] All() => new Order[0];
    public Order One(int id) => new Order();
}
`,
  "api/Customers.cs": `using Microsoft.AspNetCore.Builder;
namespace Shop.Api;

public static class Customers
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/customers", (ICustomerService svc) => svc.All());
    }
}

public interface ICustomerService { Customer[] All(); }
`,
  "api/Startup.cs": `using Microsoft.Extensions.DependencyInjection;
namespace Shop.Api;

public static class Startup
{
    public static void Configure(IServiceCollection services)
    {
        services.AddSingleton<IOrderService, OrderService>();
        services.AddHandlersFromAssembly(typeof(Startup).Assembly);
    }
}
`,
  "ui/orders.ts": `const BASE = "/api";

export async function listOrders() {
  const res = await fetch(\`\${BASE}/orders\`);
  return res.json();
}
`,
};

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "iagraph-inc-"));
  for (const [rel, body] of Object.entries(FILES)) {
    const abs = join(dir, rel);
    mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
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

async function rebuildHash(dir) {
  const fresh = await createWorkspace(dir, { storePath: ":memory:" });
  await fresh.addRepo({ path: dir, role: "api" });
  await fresh.rebuild();
  return fresh.canonicalHash();
}

let repo;
beforeAll(() => {
  repo = makeRepo();
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("incremental · gitDiff", () => {
  it("parsa adiciones, modificaciones y borrados", () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-diff-"));
    try {
      writeFileSync(join(dir, "a.cs"), "x");
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "u@u");
      git(dir, "config", "user.name", "u");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "base");
      const from = git(dir, "rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "a.cs"), "y");
      writeFileSync(join(dir, "b.cs"), "z");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "change");
      const to = git(dir, "rev-parse", "HEAD").trim();
      const { entries, renames } = gitDiff(dir, from, to);
      expect(entries.map((e) => e.status)).toEqual(["M", "A"]);
      expect(renames).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detecta un rename como R con from y to", () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-diff-"));
    try {
      writeFileSync(join(dir, "a.cs"), "namespace N; public class A { }");
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "u@u");
      git(dir, "config", "user.name", "u");
      git(dir, "add", "-A");
      git(dir, "commit", "-qm", "base");
      const from = git(dir, "rev-parse", "HEAD").trim();
      git(dir, "mv", "a.cs", "b.cs");
      git(dir, "commit", "-qm", "rename");
      const to = git(dir, "rev-parse", "HEAD").trim();
      const { renames } = gitDiff(dir, from, to);
      expect(renames).toEqual([{ from: "a.cs", to: "b.cs" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("incremental · update()", () => {
  it("una modificación de ruta recalculalos edges: la ruta vieja desaparece (E2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-e2-"));
    try {
      for (const [rel, body] of Object.entries(FILES)) {
        const abs = join(dir, rel);
        mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
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

      const p = join(dir, "api/Customers.cs");
      const { readFileSync } = await import("node:fs");
      writeFileSync(p, readFileSync(p, "utf8").replace("/api/customers", "/api/clients"));
      const from = await commit(dir, "route");

      const rep = await ws.update({ from });
      const routes = (await ws.store.findNodes({ kind: "endpoint" })).map((e) => e.route);
      expect(routes).toContain("/api/clients");
      expect(routes).not.toContain("/api/customers");
      expect(rep.degradedToRebuild).toBe(false);
      expect(rep.invalidationReason).toBeTruthy();
      expect(await ws.canonicalHash()).toBe(await rebuildHash(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("un cambio ordinario deja el grafo idéntico a un rebuild (F1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-f1-"));
    try {
      for (const [rel, body] of Object.entries(FILES)) {
        const abs = join(dir, rel);
        mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
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

      writeFileSync(join(dir, "api/Invoices.cs"), `namespace Shop.Api;
public interface IInvoiceService { void Emit(); }
`);
      const from = await commit(dir, "add invoices");

      await ws.update({ from });
      expect(await ws.canonicalHash()).toBe(await rebuildHash(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("un registro por escaneo se invalida al añadir un archivo de su scope (F5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-f5-"));
    try {
      for (const [rel, body] of Object.entries(FILES)) {
        const abs = join(dir, rel);
        mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
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

      writeFileSync(join(dir, "api/CreateOrderHandler.cs"), `namespace Shop.Api;
public class CreateOrderHandler : IHandler<CreateOrder>
{
    public void Handle(CreateOrder cmd) { }
}
`);
      const from = await commit(dir, "add handler");

      const rep = await ws.update({ from });
      const names = (await ws.store.findNodes({ kind: "class" })).map((n) => n.name);
      expect(names).toContain("CreateOrderHandler");
      expect(rep.invalidatedRules.length).toBeGreaterThan(0);
      expect(rep.invalidatedRules[0].scope).toBe("Shop.Api");
      expect(await ws.canonicalHash()).toBe(await rebuildHash(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("un cambio de firma reanaliza también a los llamantes (E6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-e6-"));
    try {
      for (const [rel, body] of Object.entries(FILES)) {
        const abs = join(dir, rel);
        mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
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

      const p = join(dir, "api/Orders.cs");
      const { readFileSync } = await import("node:fs");
      writeFileSync(p, readFileSync(p, "utf8").replace("Order One(int id);", "Order One(string id);"));
      const from = await commit(dir, "signature");

      const rep = await ws.update({ from });
      expect(rep.reanalyzedFiles.length).toBeGreaterThan(1);
      expect(rep.reanalyzedFiles).toContain("api/Orders.cs");
      expect(await ws.canonicalHash()).toBe(await rebuildHash(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("un rename conserva la identidad del símbolo y su historia (E4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-e4-"));
    try {
      for (const [rel, body] of Object.entries(FILES)) {
        const abs = join(dir, rel);
        mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
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

      git(dir, "mv", "api/Customers.cs", "api/People.cs");
      const from = await commit(dir, "rename");

      const rep = await ws.update({ from });
      expect(rep.renamed).toContainEqual(
        expect.objectContaining({ from: "api/Customers.cs", to: "api/People.cs" }),
      );
      const iface = (await ws.store.findNodes({ kind: "interface" })).find(
        (n) => n.name === "ICustomerService",
      );
      expect(iface).toBeDefined();
      expect(iface.firstSeenRev).not.toBe(iface.lastSeenRev);
      expect(await ws.canonicalHash()).toBe(await rebuildHash(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("un borrado elimina los nodos del archivo desaparecido (E3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-e3-"));
    try {
      for (const [rel, body] of Object.entries(FILES)) {
        const abs = join(dir, rel);
        mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
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

      rmSync(join(dir, "api/Customers.cs"));
      const from = await commit(dir, "drop customers");

      await ws.update({ from });
      const names = (await ws.store.findNodes({ kind: "interface" })).map((n) => n.name);
      expect(names).not.toContain("ICustomerService");
      expect(await ws.canonicalHash()).toBe(await rebuildHash(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("incremental · funciones puras", () => {
  it("buildTypeIndexFromStore recupera el índice de tipos del store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-idx-"));
    try {
      for (const [rel, body] of Object.entries(FILES)) {
        const abs = join(dir, rel);
        mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
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

      const index = buildTypeIndexFromStore(ws.store);
      expect(index.interfaces.get("IOrderService")).toEqual(
        new Set([`interface:Shop.Api.IOrderService`]),
      );
      expect(index.classes.get("OrderService")).toEqual(
        new Set([`class:Shop.Api.OrderService`]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("computeRegion propaga el cambio a los llamantes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "iagraph-region-"));
    try {
      for (const [rel, body] of Object.entries(FILES)) {
        const abs = join(dir, rel);
        mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
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

      const namespaces = new Map();
      for (const n of await ws.store.findNodes({})) {
        if (n.kind !== "class" && n.kind !== "interface") continue;
        const ns = String(n.qualifiedName).split(".").slice(0, -1).join(".");
        for (const ev of n.evidence ?? []) {
          if (!namespaces.has(ev.file)) namespaces.set(ev.file, new Set());
          namespaces.get(ev.file).add(ns);
        }
      }

      const { region, invalidatedRules } = computeRegion(ws.store, dir, {
        allChanged: new Set(["api/Orders.cs"]),
        namespacesByFile: namespaces,
      });

      // El cambio en Orders.cs invalida a su consumidor de la UI y a quien lo
      // registra en DI, además de re-evaluar la regla de escaneo de su scope.
      expect(region.has("ui/orders.ts")).toBe(true);
      expect(region.has("api/Startup.cs")).toBe(true);
      expect(invalidatedRules.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});