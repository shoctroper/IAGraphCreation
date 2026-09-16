// Acceptance blocks D (query), G (viewer), H (Copilot), I (security/IP) and
// K (portability). RFC-G1 v3 §6.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { api, makeC3, dropC3, ROOT } from "./_harness.mjs";

let c3, ws, out;

beforeAll(async () => {
  c3 = makeC3();
  out = mkdtempSync(join(tmpdir(), "iagraph-out-"));
  const { createWorkspace } = await api();
  ws = await createWorkspace(c3, { storePath: ":memory:" });
  await ws.addRepo({ path: c3, role: "api" });
  await ws.build();
}, 120_000);

afterAll(() => dropC3(c3));

// ------------------------------------------------------------- D · consulta
describe("D · consulta con evidencia", () => {
  it("D1 · search encuentra dónde vive una funcionalidad", async () => {
    const { search } = await api();
    const r = await search(ws, "orders");
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].evidence.file).toBeTruthy();
  });

  it("D2 · explain devuelve entrantes, salientes y evidencia", async () => {
    const { explain } = await api();
    const iface = (await ws.store.findNodes({ kind: "interface" })).find((n) => n.name === "IOrderService");
    const r = await explain(ws, iface.id);
    expect(r).toMatchObject({
      node: expect.objectContaining({ name: "IOrderService" }),
      incoming: expect.any(Array),
      outgoing: expect.any(Array),
      revision: expect.any(String),
    });
  });

  it("D3 · path conecta dos nodos y cada salto cita su evidencia", async () => {
    const { path: findPath } = await api();
    const ep = (await ws.store.findNodes({ kind: "endpoint" })).find((e) => e.route === "/api/orders");
    const svc = (await ws.store.findNodes({ kind: "interface" })).find((n) => n.name === "IOrderService");
    const r = await findPath(ws, ep.id, svc.id);
    expect(r.found).toBe(true);
    expect(r.hops.every((h) => h.evidence?.file && h.evidence?.lineStart > 0)).toBe(true);
  });

  it("D4 · impact delimita el área afectada por un cambio", async () => {
    const { impact } = await api();
    const r = await impact(ws, { file: "api/Orders.cs" });
    expect(r.nodes.length).toBeGreaterThan(0);
    expect(r.reason).toBeTruthy();
  });

  it("D5 · la consulta nunca devuelve un nodo que no esté en el store", async () => {
    const { search } = await api();
    const r = await search(ws, "orders");
    for (const hit of r) expect(await ws.store.getNode(hit.node.id)).toBeTruthy();
  });
});

// ---------------------------------------------------------------- G · visor
describe("G · visor autocontenido", () => {
  let html, file;

  beforeAll(async () => {
    const { renderViewer } = await api();
    file = await renderViewer(ws, { out: join(out, "map.html") });
    html = readFileSync(file, "utf8");
  }, 120_000);

  it("G1 · produce UN archivo HTML abrible desde file://", () => {
    expect(existsSync(file)).toBe(true);
    expect(html).toMatch(/<html|<!doctype/i);
  });

  it("G2 · no hace ninguna llamada de red en runtime", () => {
    expect(html).not.toMatch(/src=["']https?:\/\//i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:\/\//i);
    expect(html).not.toMatch(/\bfetch\(\s*["']https?:\/\//i);
  });

  it("G3 · implementa las ocho interacciones obligatorias", () => {
    for (const cap of ["search", "filter", "focus", "expand", "collapse", "upstream", "downstream", "details"]) {
      expect(html.toLowerCase(), `falta la capacidad ${cap}`).toContain(cap);
    }
  });

  it("G4 · lleva embebidos los datos del grafo, no una consulta a un servidor", () => {
    expect(html).toMatch(/api\/orders/);
  });

  it("G5 · distingue evidencia explícita de inferida", () => {
    expect(html).toMatch(/EXTRACTED/);
    expect(html).toMatch(/INFERRED/);
  });

  it("G6 · el detalle de un nodo puede citar archivo y línea", () => {
    expect(html).toMatch(/lineStart|line_start|"line"/);
  });
});

// -------------------------------------------------------------- H · Copilot
describe("H · integración con Copilot", () => {
  it("H1 · genera instrucciones de repositorio y por ruta", async () => {
    const { generateCopilotContext } = await api();
    const written = await generateCopilotContext(ws, { out: c3 });
    expect(written.some((p) => p.endsWith(".github/copilot-instructions.md"))).toBe(true);
    expect(written.some((p) => /\.github\/instructions\/.+\.instructions\.md$/.test(p))).toBe(true);
  });

  it("H2 · las instrucciones por ruta declaran su applyTo", async () => {
    const { generateCopilotContext } = await api();
    const written = await generateCopilotContext(ws, { out: c3 });
    const porRuta = written.filter((p) => /instructions\/.+\.instructions\.md$/.test(p));
    for (const p of porRuta) expect(readFileSync(p, "utf8")).toMatch(/applyTo:/);
  });

  it("H3 · el servidor MCP responde a una consulta del grafo", async () => {
    const { startMcpServer } = await api();
    const srv = await startMcpServer(ws, { transport: "inmemory" });
    try {
      const tools = await srv.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["search", "explain", "path", "impact"]),
      );
      const r = await srv.call("search", { query: "orders" });
      expect(r.results.length).toBeGreaterThan(0);
      expect(r.results[0].evidence.file).toBeTruthy();
    } finally {
      await srv.close();
    }
  });
});

// ------------------------------------------------------- I · seguridad e IP
describe("I · seguridad y propiedad intelectual", () => {
  it("I1 · el repo público no contiene rutas de repositorios privados", () => {
    const grep = (pat) => {
      try {
        return execFileSync("git", ["grep", "-lI", "--", pat], { cwd: ROOT, encoding: "utf8" }).trim();
      } catch { return ""; }
    };
    // el corpus se configura, nunca se codifica dentro del producto
    const enFuente = execFileSync("git", ["grep", "-lI", "-e", "lubesoft", "--", "src/"], {
      cwd: ROOT, encoding: "utf8",
    }).toString().trim();
    expect(enFuente).toBe("");
    expect(grep("ints/lubesoft")).toBe("");
  });

  it("I2 · no hay secretos en el árbol", () => {
    const patrones = [/sk-[A-Za-z0-9_-]{16,}/, /ghp_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
    const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    for (const f of files) {
      if (f.endsWith(".wasm")) continue;
      const p = join(ROOT, f);
      if (!existsSync(p) || statSync(p).size > 2_000_000) continue;
      const body = readFileSync(p, "utf8");
      for (const re of patrones) expect(re.test(body), `secreto en ${f}`).toBe(false);
    }
  });

  it("I3 · los artefactos de grafos quedan fuera del repositorio", () => {
    const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
    for (const entry of ["graphs/", ".iagraph/", "*.db"]) expect(ignore).toContain(entry);
    const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
    expect(tracked).not.toMatch(/\.db$/m);
  });

  it("I4 · toda dependencia vendorizada declara su licencia", () => {
    const notice = readFileSync(join(ROOT, "vendor/wasm/NOTICE.md"), "utf8");
    for (const w of readdirSync(join(ROOT, "vendor/wasm")).filter((f) => f.endsWith(".wasm"))) {
      expect(notice, `${w} sin licencia declarada`).toContain(w);
    }
  });
});

// ----------------------------------------------------------- K · portabilidad
describe("K · portabilidad", () => {
  it("K1 · el runtime no depende de ningún paquete con build nativo", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const prohibidas = ["tree-sitter", "tree-sitter-c-sharp", "tree-sitter-typescript", "better-sqlite3", "node-gyp"];
    for (const d of Object.keys(pkg.dependencies ?? {})) {
      expect(prohibidas, `${d} arrastra compilación nativa`).not.toContain(d);
    }
  });

  it("K2 · las gramáticas se cargan desde vendor/, no desde node_modules", () => {
    for (const w of ["tree-sitter-c_sharp.wasm", "tree-sitter-typescript.wasm", "web-tree-sitter.wasm"]) {
      expect(existsSync(join(ROOT, "vendor/wasm", w))).toBe(true);
    }
  });

  it("K3 · las rutas del modelo son POSIX, para que Windows no las rompa", async () => {
    const nodes = await ws.store.findNodes({});
    const conBackslash = nodes.filter((n) => (n.file ?? "").includes("\\"));
    expect(conBackslash).toEqual([]);
  });

  it("K4 · instala y construye en un contenedor node:22-alpine estéril", () => {
    // Esta máquina tiene las Command Line Tools, así que si algo intentara
    // compilar con node-gyp lo lograría en silencio y creeríamos que el
    // producto es portable. La portabilidad no se verifica en la máquina que
    // la desmiente: se verifica donde no hay python, make ni g++.
    let docker = true;
    try { execFileSync("docker", ["info"], { stdio: "ignore" }); } catch { docker = false; }
    if (!docker) return; // sin docker: saltar, no fingir

    const salida = execFileSync("docker", [
      "run", "--rm", "-v", `${ROOT}:/app:ro`, "-w", "/tmp/build", "node:22-alpine",
      "sh", "-c",
      "cp -r /app/package.json /app/src /app/vendor /tmp/build/ 2>/dev/null; " +
      "! command -v gcc && ! command -v make && echo NO_TOOLCHAIN; " +
      "npm install --omit=dev --ignore-scripts --silent && node -e \"import('./src/index.mjs').then(()=>console.log('IMPORT_OK'))\"",
    ], { encoding: "utf8", timeout: 600_000 });

    expect(salida).toContain("NO_TOOLCHAIN");
    expect(salida).toContain("IMPORT_OK");
  }, 900_000);
});
