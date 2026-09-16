// Unit tests for the resolve slice (spine step 4): assembly-scanning DI
// registrations become ONE binding_rule node each, carrying a truthy scope
// (the scanned assembly/project domain) and evidence citing the literal scan
// call. Mirrors acceptance B9.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeCSharp } from "../../src/analyzers/csharp/index.mjs";
import { resolveBindingRules } from "../../src/resolve/index.mjs";
import { createWorkspace } from "../../src/store/index.mjs";

const REV = "0f84a6a5d5436929353e51899bd41b10f72d8ded";

const SCAN_SOURCES = {
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
  "api/Orders.cs": `namespace Shop.Api;
public interface IOrderService { }
public class OrderService : IOrderService { }
`,
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Materialise sources in a temp dir and run the C# analyzer over them. */
async function analyzeSources(sources) {
  const dir = mkdtempSync(join(tmpdir(), "iagraph-resolve-cs-"));
  try {
    for (const [rel, body] of Object.entries(sources)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body, "utf8");
    }
    return await analyzeCSharp({ files: Object.keys(sources), root: dir, rev: REV });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A real git repo with the scan corpus, for a full Workspace build (B9). */
function makeScanRepo() {
  const dir = mkdtempSync(join(tmpdir(), "iagraph-resolve-repo-"));
  for (const [rel, body] of Object.entries(SCAN_SOURCES)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf8");
  }
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "unit@iagraph.local");
  git(dir, "config", "user.name", "unit");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "resolve: base");
  return dir;
}

describe("resolver · registros por escaneo de ensamblado", () => {
  it("el extractor C# expone la observación con la llamada y el ensamblado resuelto", async () => {
    const out = await analyzeSources(SCAN_SOURCES);
    const obs = out.observations.filter((o) => o.kind === "scan_registration");
    expect(obs).toHaveLength(1);
    const [o] = obs;
    expect(o.method).toBe("AddHandlersFromAssembly");
    expect(o.call).toBe("services.AddHandlersFromAssembly(typeof(Startup).Assembly)");
    expect(o.assembly).toBe("Shop.Api");
    expect(o.file).toMatch(/Startup\.cs$/);
    expect(o.lineStart).toBeGreaterThan(0);
    expect(o.rev).toBe(REV);
  });

  it("la forma genérica AddXContaining<T>() también resuelve su scope", async () => {
    const out = await analyzeSources({
      ...SCAN_SOURCES,
      "api/Startup.cs": `using Microsoft.Extensions.DependencyInjection;
namespace Shop.Api;

public static class Startup
{
    public static void Configure(IServiceCollection services)
    {
        services.AddHandlersFromAssemblyContaining<Startup>();
    }
}
`,
    });
    const obs = out.observations.filter((o) => o.kind === "scan_registration");
    expect(obs).toHaveLength(1);
    expect(obs[0].method).toBe("AddHandlersFromAssemblyContaining");
    expect(obs[0].assembly).toBe("Shop.Api");
  });

  it("un escaneo opaco sin tipo resoluble NO produce observación (regla 2)", async () => {
    const out = await analyzeSources({
      ...SCAN_SOURCES,
      "api/Startup.cs": `using Microsoft.Extensions.DependencyInjection;
namespace Shop.Api;

public static class Startup
{
    public static void Configure(IServiceCollection services)
    {
        services.AddHandlersFromAssembly(Assembly.GetCallingAssembly());
    }
}
`,
    });
    expect(out.observations.filter((o) => o.kind === "scan_registration")).toEqual([]);
  });

  it("resolveBindingRules emite UN binding_rule por registro, con scope y evidencia", () => {
    const { nodes, edges } = resolveBindingRules({
      observations: [
        {
          kind: "scan_registration",
          method: "AddHandlersFromAssembly",
          call: "services.AddHandlersFromAssembly(typeof(Startup).Assembly)",
          assembly: "Shop.Api",
          file: "api/Startup.cs",
          lineStart: 10,
          rev: REV,
        },
      ],
      rev: REV,
    });
    expect(nodes).toHaveLength(1);
    expect(edges).toEqual([]);
    const [rule] = nodes;
    expect(rule.kind).toBe("binding_rule");
    expect(rule.name).toBe("AddHandlersFromAssembly");
    expect(rule.scope).toBe("Shop.Api");
    expect(rule.evidence).toEqual([{ file: "api/Startup.cs", lineStart: 10, rev: REV }]);
  });

  it("un binding_rule sin scope resoluble no se inventa (regla 2)", () => {
    const { nodes } = resolveBindingRules({
      observations: [
        { kind: "scan_registration", method: "AddHandlersFromAssembly", assembly: "", file: "api/Startup.cs", lineStart: 10, rev: REV },
        { kind: "other" },
      ],
      rev: REV,
    });
    expect(nodes).toEqual([]);
  });
});

describe("Workspace.build integra el resolver (B9)", () => {
  let repo;
  let ws;

  beforeAll(async () => {
    repo = makeScanRepo();
    ws = createWorkspace(repo, { storePath: ":memory:" });
    await ws.addRepo({ path: repo, role: "api" });
    await ws.build();
  }, 120_000);

  afterAll(() => {
    ws.store.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("persiste una binding_rule con scope y evidencia en Startup.cs", async () => {
    const rules = await ws.store.findNodes({ kind: "binding_rule" });
    expect(rules.length).toBeGreaterThan(0);
    const rule = rules[0];
    expect(rule.scope).toBeTruthy();
    expect(rule.name).toBe("AddHandlersFromAssembly");
    expect((rule.evidence ?? []).some((ev) => String(ev.file).endsWith("Startup.cs"))).toBe(true);
    expect(rule.firstSeenRev).toBeTruthy();
    expect(rule.lastSeenRev).toBeTruthy();
  });

  it("no inventa edges derivados del escaneo en esta iteración", async () => {
    const derived = (await ws.store.getEdges({})).filter((e) => e.ruleId);
    expect(derived).toEqual([]);
  });
});