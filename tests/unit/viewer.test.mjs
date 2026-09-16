// Unit tests for the viewer slice (spine step 8, docs/API.md "Visor").
//
// renderViewer must compile the graph into ONE standalone HTML file that:
//   - is openable from file:// with no network references at runtime (G1, G2);
//   - implements the eight mandatory interactions (G3);
//   - embeds the graph data as JSON read from the SAME store the AI context
//     derives from (rule 4, G4) — never a server query;
//   - distinguishes EXTRACTED from INFERRED evidence (G5);
//   - can cite file and lineStart in a node's detail (G6).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderViewer } from "../../src/viewer/index.mjs";
import { createWorkspace } from "../../src/store/index.mjs";

const FIXTURE = new URL("../../tests/fixtures/repo/", import.meta.url).pathname;

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

let repo, ws, outDir;
beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "iagraph-viewer-"));
  cpSync(FIXTURE, repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "unit@iagraph.local");
  git(repo, "config", "user.name", "unit");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "fixture: base");
  ws = createWorkspace(repo, { storePath: ":memory:" });
  await ws.addRepo({ path: repo, role: "api" });
  await ws.build();
  outDir = mkdtempSync(join(tmpdir(), "iagraph-viewer-out-"));
});
afterAll(() => {
  ws.store.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

function render(opts = {}) {
  return renderViewer(ws, { out: join(outDir, "map.html"), ...opts });
}

describe("renderViewer · visor autocontenido (G1-G6)", () => {
  it("G1 · produce UN archivo HTML abrible desde file://", async () => {
    const file = await render();
    expect(existsSync(file)).toBe(true);
    const html = readFileSync(file, "utf8");
    expect(html).toMatch(/<!doctype html/i);
    expect(html).toMatch(/<html/i);
    expect(html).toContain("</html>");
    // un solo archivo: no hay src externo que cargar (sin js/css/images externos)
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
  });

  it("G2 · no hace ninguna llamada de red en runtime", async () => {
    const html = readFileSync(await render(), "utf8");
    expect(html).not.toMatch(/src=["']https?:\/\//i);
    expect(html).not.toMatch(/<link[^>]+href=["']https?:\/\//i);
    expect(html).not.toMatch(/\bfetch\(\s*["']https?:\/\//i);
    expect(html).not.toMatch(/https?:\/\/[\w.-]+\.[a-z]{2,}/i);
  });

  it("G3 · implementa las ocho interacciones obligatorias", async () => {
    const html = readFileSync(await render(), "utf8").toLowerCase();
    for (const cap of ["search", "filter", "focus", "expand", "collapse", "upstream", "downstream", "details"]) {
      expect(html, `falta la capacidad ${cap}`).toContain(cap);
    }
  });

  it("G4 · embebe los datos del grafo desde el store (regla 4)", async () => {
    const html = readFileSync(await render(), "utf8");
    const match = html.match(/var GRAPH = (\{.*\});\r?\n/);
    expect(match, "GRAPH JSON embebido").toBeTruthy();
    const graph = JSON.parse(match[1]);
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
    // lo que el HTML trae ES lo que vive en el store: misma fuente de verdad
    const storeNodes = ws.store.findNodes({}).map((n) => n.id).sort();
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(storeNodes);
    const storeEdges = ws.store.getEdges({}).map((e) => e.id).sort();
    expect(graph.edges.map((e) => e.id).sort()).toEqual(storeEdges);
    // datos reales del corpus embebidos, no una consulta a un servidor
    expect(html).toMatch(/\/api\/orders/);
  });

  it("G5 · distingue evidencia explícita de inferida", async () => {
    const html = readFileSync(await render(), "utf8");
    expect(html).toMatch(/EXTRACTED/);
    expect(html).toMatch(/INFERRED/);
    expect(html).toMatch(/AMBIGUOUS/);
    const match = html.match(/var GRAPH = (\{.*\});\r?\n/);
    const graph = JSON.parse(match[1]);
    // la distinción vive en los datos embebidos (naturaleza de cada edge)
    expect(graph.edges.some((e) => e.nature === "EXTRACTED")).toBe(true);
  });

  it("G6 · el detalle de un nodo cita archivo y línea", async () => {
    const html = readFileSync(await render(), "utf8");
    expect(html).toMatch(/lineStart|line_start|"line"/);
    const match = html.match(/var GRAPH = (\{.*\});\r?\n/);
    const graph = JSON.parse(match[1]);
    const evs = graph.edges
      .map((e) => e.evidence)
      .filter((ev) => ev && ev.file && Number.isInteger(ev.lineStart));
    expect(evs.length).toBeGreaterThan(0);
    // la UI pinta file y lineStart en el panel de detalles
    expect(html).toContain("file:");
    expect(html).toContain("lineStart:");
  });

  it("devuelve la ruta del archivo escrito y respeta out", async () => {
    const out = join(outDir, "custom-name.html");
    const file = await renderViewer(ws, { out });
    expect(file).toBe(out);
    expect(existsSync(out)).toBe(true);
  });

  it("un focus inicial se embebe en el HTML", async () => {
    const node = ws.store.findNodes({ kind: "endpoint" })[0];
    const out = join(outDir, "focused.html");
    await renderViewer(ws, { out, focus: node.id });
    const html = readFileSync(out, "utf8");
    const graph = JSON.parse(html.match(/var GRAPH = (\{.*\});\r?\n/)[1]);
    expect(graph.focus).toBe(node.id);
  });

  it("sin out escribe en <dir>/.iagraph/viewer.html", async () => {
    const file = await renderViewer(ws, {});
    expect(file).toBe(join(repo, ".iagraph", "viewer.html"));
    expect(existsSync(file)).toBe(true);
  });

  it("rechaza un workspace sin store", async () => {
    await expect(renderViewer({}, { out: join(outDir, "x.html") })).rejects.toThrow(/store/);
  });
});