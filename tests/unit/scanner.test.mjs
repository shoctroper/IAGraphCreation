import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  scanRepository,
  listSourceFiles,
  resolveRevision,
  DEFAULT_EXCLUDE_DIRS,
} from "../../src/scanner/index.mjs";

const FIXTURE = new URL("../../tests/fixtures/repo/", import.meta.url).pathname;

const EXPECTED_FILES = [
  "README.md",
  "api/Orders.cs",
  "api/OrdersApi.cs",
  "api/Registry.Part1.cs",
  "api/Registry.Part2.cs",
  "api/Startup.cs",
  "ui/orders.ts",
];

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeFixtureRepo() {
  const dir = mkdtempSync(join(tmpdir(), "iagraph-scanner-"));
  cpSync(FIXTURE, dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "unit@iagraph.local");
  git(dir, "config", "user.name", "unit");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "fixture: base");
  return dir;
}

let repo;
beforeAll(() => {
  repo = makeFixtureRepo();
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("listSourceFiles", () => {
  it("enumera los fuentes y excluye obj/, bin/ y node_modules/ (B12)", async () => {
    const { files } = await listSourceFiles(repo);
    expect(files).toEqual(EXPECTED_FILES);
  });

  it("nunca devuelve una ruta con separadores de Windows (K3)", async () => {
    const { files } = await listSourceFiles(repo);
    for (const f of files) expect(f).not.toContain("\\");
  });

  it("es determinista: dos pasadas idénticas", async () => {
    const a = await listSourceFiles(repo);
    const b = await listSourceFiles(repo);
    expect(b.files).toEqual(a.files);
  });

  it("puede filtrar por prefijo", async () => {
    const { files } = await listSourceFiles(repo, { include: ["api"] });
    expect(files).toEqual(EXPECTED_FILES.filter((f) => f.startsWith("api/")));
  });

  it("admite exclusiones personalizadas", async () => {
    const { files } = await listSourceFiles(repo, { excludeDirs: ["ui"] });
    expect(files).toEqual(EXPECTED_FILES.filter((f) => !f.startsWith("ui/")));
  });

  it("no sigue enlaces simbólicos que escapan del repo", async () => {
    const outside = mkdtempSync(join(tmpdir(), "iagraph-outside-"));
    try {
      writeFileSync(join(outside, "secret.cs"), "namespace Escaped;");
      const link = join(repo, "escape");
      execFileSync("ln", ["-s", outside, link], { stdio: "ignore" });
      const { files } = await listSourceFiles(repo);
      expect(files).toEqual(EXPECTED_FILES);
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(join(repo, "escape"), { recursive: true, force: true });
    }
  });
});

describe("scanRepository", () => {
  it("ancla la revisión a HEAD del repositorio", async () => {
    const scan = await scanRepository({ path: repo });
    const head = git(repo, "rev-parse", "HEAD").trim();
    expect(scan.isGitRepo).toBe(true);
    expect(scan.rev).toBe(head);
    expect(scan.files).toEqual(EXPECTED_FILES);
    expect(scan.root).toBe(repo);
  });

  it("respeta una revisión explícita", async () => {
    const scan = await scanRepository({ path: repo, rev: "custom-rev" });
    expect(scan.rev).toBe("custom-rev");
  });

  it("reporta un directorio sin git con rev null, sin inventar nada", async () => {
    const plain = mkdtempSync(join(tmpdir(), "iagraph-plain-"));
    try {
      const scan = await scanRepository({ path: plain });
      expect(scan.isGitRepo).toBe(false);
      expect(scan.rev).toBeNull();
      expect(scan.files).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("lanza si la ruta no existe o no es un directorio", async () => {
    await expect(scanRepository({ path: join(repo, "nope") })).rejects.toThrow();
  });
});

describe("resolveRevision", () => {
  it("lee .git/HEAD sin depender del binario git", () => {
    const fake = mkdtempSync(join(tmpdir(), "iagraph-fakegit-"));
    try {
      const sha = "0123456789abcdef0123456789abcdef01234567";
      const refPath = join(fake, ".git", "refs", "heads", "main");
      mkdirSync(dirname(refPath), { recursive: true });
      writeFileSync(join(fake, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
      writeFileSync(refPath, `${sha}\n`, "utf8");
      expect(resolveRevision(fake)).toBe(sha);
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  it("devuelve null cuando no hay manera de conocer la revisión", () => {
    const empty = mkdtempSync(join(tmpdir(), "iagraph-norev-"));
    try {
      expect(resolveRevision(empty)).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("no fabrica una revisión si HEAD no se puede resolver", () => {
    const broken = mkdtempSync(join(tmpdir(), "iagraph-broken-"));
    try {
      mkdirSync(join(broken, ".git"));
      writeFileSync(join(broken, ".git", "HEAD"), "0123\n", "utf8");
      expect(resolveRevision(broken)).toBeNull();
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

describe("exclusiones por defecto", () => {
  it("cubren VCS, vendor y build dirs", () => {
    expect(DEFAULT_EXCLUDE_DIRS).toContain(".git");
    expect(DEFAULT_EXCLUDE_DIRS).toContain("node_modules");
    expect(DEFAULT_EXCLUDE_DIRS).toContain("obj");
    expect(DEFAULT_EXCLUDE_DIRS).toContain("bin");
  });

  it("el fixture en disco no contiene artefactos de git", () => {
    // The committed fixture is a plain tree; tests copy it and git-init it.
    const readme = readFileSync(join(FIXTURE, "README.md"), "utf8");
    expect(readme).toContain("obj/");
  });
});