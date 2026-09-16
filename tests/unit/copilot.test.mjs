// Unit tests for the Copilot slice (spine step 9, docs/API.md "Copilot").
//
// generateCopilotContext must render the revision-aware graph into a compact,
// evidence-bearing context (H1):
//   - write a global `.github/copilot-instructions.md` plus one file per route,
//     each route file declaring its `applyTo` (H2);
//   - derive EVERYTHING from the same SQLite store the viewer uses (rule 4),
//     never inventing nodes or edges (rule 2), citing {file, lineStart} on every
//     edge (rule 1) and distinguishing EXTRACTED from INFERRED (rule 3).
//
// startMcpServer must answer a graph query over the same store (H3) and return
// an object with `close()` per the frozen API contract.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCopilotContext, renderGraphContext } from "../../src/copilot/index.mjs";
import { startMcpServer } from "../../src/copilot/index.mjs";
import { createWorkspace } from "../../src/store/index.mjs";
import { createEdge, createNode, makeNodeId } from "../../src/model/index.mjs";

const FIXTURE = new URL("../../tests/fixtures/repo/", import.meta.url).pathname;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let repo, ws, outDir, rev;
beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "iagraph-copilot-"));
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
  outDir = mkdtempSync(join(tmpdir(), "iagraph-copilot-out-"));
});
afterAll(() => {
  ws.store.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

describe("generateCopilotContext · instrucciones por ruta (H1, H2)", () => {
  it("H1 · escribe archivos y devuelve sus rutas, incluida la global", async () => {
    const written = await generateCopilotContext(ws, { out: outDir });
    expect(Array.isArray(written)).toBe(true);
    expect(written.length).toBeGreaterThan(0);
    expect(written.some((p) => p.endsWith(".github/copilot-instructions.md"))).toBe(true);
    for (const p of written) {
      expect(existsSync(p), `falta el archivo ${p}`).toBe(true);
    }
  });

  it("H2 · cada instrucción por ruta declara su applyTo", async () => {
    await generateCopilotContext(ws, { out: outDir });
    const routes = ws.store
      .findNodes({})
      .filter((n) => typeof n.route === "string" && n.route.length > 0)
      .map((n) => n.route);
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      const files = readdirSync(join(outDir, ".github", "instructions", "routes"));
      const hit = files.find((f) => {
        const body = readFileSync(join(outDir, ".github", "instructions", "routes", f), "utf8");
        return body.includes("applyTo") && body.includes(JSON.stringify(route));
      });
      expect(hit, `falta applyTo para ${route}`).toBeTruthy();
    }
  });

  it("escribe un archivo por ruta", async () => {
    await generateCopilotContext(ws, { out: outDir });
    const routeCount = ws.store
      .findNodes({})
      .filter((n) => typeof n.route === "string" && n.route.length > 0).length;
    const files = readdirSync(join(outDir, ".github", "instructions", "routes")).filter((f) =>
      f.endsWith(".instructions.md"),
    );
    expect(files.length).toBe(routeCount);
  });

  it("el contexto global cita la revisión vigente (regla 5)", async () => {
    const global = join(outDir, ".github", "copilot-instructions.md");
    await generateCopilotContext(ws, { out: outDir });
    const doc = readFileSync(global, "utf8");
    expect(doc).toContain(`revision: ${rev}`);
    expect(doc).toContain(`nodes: ${ws.store.findNodes({}).length}`);
    expect(doc).toContain(`edges: ${ws.store.getEdges({}).length}`);
  });

  it("se deriva del store y no inventa nada (reglas 1, 2 y 4)", async () => {
    await generateCopilotContext(ws, { out: outDir });
    const doc = readFileSync(join(outDir, ".github", "copilot-instructions.md"), "utf8");
    for (const node of ws.store.findNodes({})) {
      expect(doc, `falta el nodo ${node.id}`).toContain(node.id);
    }
    for (const edge of ws.store.getEdges({})) {
      const ev = edge.evidence ?? {};
      // cada edge aparece con su naturaleza, src -> dst y su evidencia file:lineStart
      expect(doc, `falta el edge ${edge.id}`).toContain(`${edge.src} --[${edge.kind} ${edge.nature}]--> ${edge.dst}`);
      expect(doc, `falta la evidencia de ${edge.id}`).toContain(`@ ${ev.file}:${ev.lineStart}`);
    }
  });

  it("distingue EXTRACTED de INFERRED (regla 3)", async () => {
    const extra = createEdge({
      src: makeNodeId("interface", "Fixture.Api.IOrderService"),
      dst: makeNodeId("class", "Fixture.Api.Orders"),
      kind: "binds_implementation",
      nature: "INFERRED",
      extractor: "resolve",
      extractorVersion: "0.1.0",
      evidence: { file: "api/Startup.cs", lineStart: 8, rev },
      observedInRev: rev,
      ruleId: "rule:RegisterOrders",
    });
    ws.store.upsertEdges([extra], rev);
    const doc = renderGraphContext(ws.store);
    expect(doc).toContain("EXTRACTED");
    expect(doc).toContain("INFERRED");
    expect(doc).toContain("rule:RegisterOrders");
    expect(doc).toContain(`${extra.src} --[${extra.kind} ${extra.nature}]--> ${extra.dst}`);
    ws.store.removeEdge(extra.id);
  });

  it("la instrucción por ruta describe consumidores con evidencia", async () => {
    await generateCopilotContext(ws, { out: outDir });
    const route = ws.store
      .findNodes({ kind: "endpoint" })
      .map((n) => n.route)
      .find((r) => typeof r === "string");
    const doc = readFileSync(
      join(outDir, ".github", "instructions", "routes", "api-orders.instructions.md"),
      "utf8",
    );
    expect(doc).toContain("## consumers");
    // el consumidor ui/orders.ts llega con su evidencia file:lineStart
    const consumer = ws.store.getEdges({ kind: "calls_endpoint" })[0];
    expect(doc).toContain(consumer.evidence.file);
    expect(String(consumer.evidence.lineStart)).toBeTruthy();
    expect(route).toBeTruthy();
  });

  it("sin out escribe en <dir>/.github/copilot-instructions.md", async () => {
    const written = await generateCopilotContext(ws, {});
    expect(written.some((p) => p.endsWith(join(".github", "copilot-instructions.md")))).toBe(true);
    const global = join(repo, ".github", "copilot-instructions.md");
    expect(existsSync(global)).toBe(true);
    expect(readFileSync(global, "utf8")).toContain("# IAGraph context");
  });

  it("rechaza un workspace sin store", async () => {
    await expect(generateCopilotContext({}, { out: outDir })).rejects.toThrow(/store/);
  });
});

describe("startMcpServer · servidor MCP (H3)", () => {
  it("H3 · responde a una consulta del grafo por inmemory", async () => {
    const srv = await startMcpServer(ws, { transport: "inmemory" });
    try {
      const res = await srv.request("tools/call", {
        name: "search",
        arguments: { query: "orders" },
      });
      expect(res.content[0].type).toBe("text");
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed.some((h) => h.node.id === "endpoint:GET /api/orders")).toBe(true);
      expect(parsed.some((h) => h.node.id.includes("OrderService"))).toBe(true);
    } finally {
      srv.close();
    }
  });

  it("expone las herramientas del grafo y el contexto compacto", async () => {
    const srv = await startMcpServer(ws, { transport: "inmemory" });
    try {
      const tools = await srv.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["explain", "graph_context", "impact", "path", "search"]);

      const ctx = await srv.request("tools/call", {
        name: "graph_context",
        arguments: {},
      });
      expect(ctx.content[0].text).toContain(`revision: ${rev}`);
      expect(ctx.content[0].text).toContain("/api/orders");
    } finally {
      srv.close();
    }
  });

  it("listTools + call responden a una consulta del grafo", async () => {
    const srv = await startMcpServer(ws, { transport: "inmemory" });
    try {
      const tools = await srv.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["search", "explain", "path", "impact"]),
      );
      const r = await srv.call("search", { query: "orders" });
      expect(r.results.length).toBeGreaterThan(0);
      expect(r.results[0].evidence.file).toBeTruthy();
      expect(r.results.some((h) => h.node.id === "endpoint:GET /api/orders")).toBe(true);
    } finally {
      srv.close();
    }
  });

  it("explica un nodo con su evidencia y sus edges", async () => {
    const srv = await startMcpServer(ws, { transport: "inmemory" });
    try {
      const res = await srv.request("tools/call", {
        name: "explain",
        arguments: { nodeId: "endpoint:GET /api/orders" },
      });
      const parsed = JSON.parse(res.content[0].text);
      expect(parsed.node.id).toBe("endpoint:GET /api/orders");
      expect(parsed.incoming.some((e) => e.kind === "calls_endpoint")).toBe(true);
      expect(parsed.evidence[0].file).toBe("api/OrdersApi.cs");
      expect(parsed.evidence[0].lineStart).toBeTypeOf("number");
    } finally {
      srv.close();
    }
  });

  it("maneja JSON-RPC completo y falla con herramientas desconocidas", async () => {
    const srv = await startMcpServer(ws, { transport: "inmemory" });
    try {
      const init = await srv.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
      expect(init.result.serverInfo.name).toBe("iagraph");
      expect(init.result.capabilities.tools).toBeDefined();

      await expect(
        srv.request("tools/call", { name: "no_such_tool", arguments: {} }),
      ).rejects.toThrow(/unknown tool/);
    } finally {
      srv.close();
    }
  });

  it("tras close() deja de responder (contrato { close() })", async () => {
    const srv = await startMcpServer(ws, { transport: "inmemory" });
    expect(typeof srv.close).toBe("function");
    srv.close();
    await expect(srv.request("tools/list", {})).rejects.toThrow(/closed/);
  });

  it("rechaza un workspace sin store y un transporte desconocido", async () => {
    await expect(startMcpServer({}, { transport: "inmemory" })).rejects.toThrow(/store/);
    await expect(startMcpServer(ws, { transport: "carrier-pigeon" })).rejects.toThrow(
      /transport/,
    );
  });

  it("soporta el transporte stdio devolviendo un close()", async () => {
    const srv = await startMcpServer(ws, { transport: "stdio" });
    expect(typeof srv.close).toBe("function");
    srv.close();
    expect(srv.closed).toBe(true);
  });
});