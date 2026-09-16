// Shared harness for the pinned acceptance suite (RFC-G1 v3 §6).
//
// These cases were written by the architect BEFORE any implementation existed
// and must fail for the right reason on an empty tree. They are the outcome the
// governed Goal is evaluated against; changing them changes the acceptance.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

export const ROOT = new URL("../../", import.meta.url).pathname;

// Real corpora. Absent ones make their cases skip rather than lie.
export const CORPUS = {
  athenaApi: "/Volumes/Medios/Repos/AthenaFramework",
  athenaUi: "/Volumes/Medios/Repos/AthenaSignal",
  eshop: "/Volumes/Medios/Repos/run-aspnetcore-microservices",
};

export function haveCorpus(...keys) {
  return keys.every((k) => existsSync(CORPUS[k]));
}

export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * C3, the synthetic corpus.
 *
 * Its ground truth is frozen HERE, in this file, before a single line of the
 * TypeScript extractor exists — that is the whole point. A synthetic corpus
 * written after the extractor would be shaped to fit it, which is the classic
 * way to fool yourself.
 *
 * It deliberately uses TWO http libraries (native fetch and axios) and TWO url
 * conventions (template interpolation and URLSearchParams) so that an extractor
 * that is really a regex in disguise cannot pass.
 */
export const C3_GROUND_TRUTH = {
  endpoints: [
    { method: "GET", route: "/api/orders", file: "api/Orders.cs" },
    { method: "GET", route: "/api/orders/{id}", file: "api/Orders.cs" },
    { method: "POST", route: "/api/orders", file: "api/Orders.cs" },
    { method: "GET", route: "/api/customers", file: "api/Customers.cs" },
  ],
  // UI call -> endpoint it reaches. These must ALL be found.
  calls: [
    { from: "ui/orders.ts", route: "/api/orders", method: "GET", lib: "fetch" },
    { from: "ui/orders.ts", route: "/api/orders/{id}", method: "GET", lib: "fetch" },
    { from: "ui/orders.ts", route: "/api/orders", method: "POST", lib: "fetch" },
    { from: "ui/customers.ts", route: "/api/customers", method: "GET", lib: "axios" },
  ],
  // Endpoints with no consumer at all. The tool must say so, not invent one.
  orphanEndpoints: [],
  // Traps: names that LOOK related but are not. No edge may be created here.
  mustNotLink: [
    { from: "ui/orders.ts", route: "/api/invoices" },
    { from: "ui/legacy.ts", route: "/api/orders" },
  ],
};

const C3_FILES = {
  "api/Orders.cs": `using Microsoft.AspNetCore.Builder;
namespace Shop.Api;

public static class Orders
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/orders", (IOrderService svc) => svc.All());
        app.MapGet("/api/orders/{id}", (int id, IOrderService svc) => svc.One(id));
        app.MapPost("/api/orders", (OrderDto dto, IOrderService svc) => svc.Create(dto));
    }
}

public interface IOrderService
{
    Order[] All();
    Order One(int id);
    Order Create(OrderDto dto);
}

public class OrderService : IOrderService
{
    public Order[] All() => new Order[0];
    public Order One(int id) => new Order();
    public Order Create(OrderDto dto) => new Order();
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
  // partial class split across two files: must produce ONE node, not two
  "api/Registry.Part1.cs": `namespace Shop.Api;
public partial class Registry
{
    public void RegisterOrders() { }
}
`,
  "api/Registry.Part2.cs": `namespace Shop.Api;
public partial class Registry
{
    public void RegisterCustomers() { }
}
`,
  "api/Startup.cs": `using Microsoft.Extensions.DependencyInjection;
namespace Shop.Api;

public static class Startup
{
    public static void Configure(IServiceCollection services)
    {
        services.AddSingleton<IOrderService, OrderService>();
        // opaque factory: the real implementation is decided inside the lambda.
        // No binds_implementation edge may be invented from this line.
        services.AddSingleton<ICustomerService>(sp => CustomerServiceFactory.Create(sp));
        // scanning rule: its invalidation domain is the whole project
        services.AddHandlersFromAssembly(typeof(Startup).Assembly);
    }
}
`,
  // UI, library 1: native fetch, template interpolation
  "ui/orders.ts": `const BASE = "/api";

export async function listOrders() {
  const res = await fetch(\`\${BASE}/orders\`);
  return res.json();
}

export async function getOrder(id: number) {
  const res = await fetch(\`\${BASE}/orders/\${id}\`);
  return res.json();
}

export async function createOrder(dto: unknown) {
  const res = await fetch(\`\${BASE}/orders\`, {
    method: "POST",
    body: JSON.stringify(dto),
  });
  return res.json();
}
`,
  // UI, library 2: axios, URLSearchParams
  "ui/customers.ts": `import axios from "axios";

export async function listCustomers(active: boolean) {
  const params = new URLSearchParams({ active: String(active) });
  const res = await axios.get("/api/customers", { params });
  return res.data;
}
`,
  // trap: mentions a route that does not exist as an endpoint
  "ui/legacy.ts": `export const DEAD_ROUTE = "/api/orders";
// This is a string constant, not a call. No calls_endpoint edge may come from it.
`,
};

/** Materialise C3 as a real git repository and return its path. */
export function makeC3() {
  const dir = mkdtempSync(join(tmpdir(), "iagraph-c3-"));
  for (const [rel, body] of Object.entries(C3_FILES)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "acceptance@iagraph.local");
  git(dir, "config", "user.name", "acceptance");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "c3: base revision");
  return dir;
}

export function dropC3(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Load the public API. Missing modules surface as a clear, honest failure. */
export async function api() {
  return import(join(ROOT, "src/index.mjs"));
}
