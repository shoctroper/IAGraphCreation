// Repository scanner: the ingestion front door.
//
// It resolves the revision the graph is anchored to, enumerates the source
// files that analyzers will read, and applies the exclusion rules that are
// invariants of the product:
//
//   - `obj/` and `bin/` are always excluded (acceptance B12);
//   - VCS internals (`.git`) and vendored toolchains (`node_modules`) never
//     enter the graph;
//   - paths are normalized to POSIX form (acceptance K3) and the file list is
//     deterministic (sorted), so two scans of the same revision agree.
//
// No parsing happens here: analyzers consume the returned entries.

import { readFileSync } from "node:fs";
import { opendir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { relative, join, resolve, isAbsolute } from "node:path";

const VCS_DIRS = new Set([".git", ".hg", ".svn"]);
const VENDOR_DIRS = new Set(["node_modules"]);
// B12: (^|/)(obj|bin)/ never analyzed. Matches any path segment.
const BUILD_DIRS = new Set(["obj", "bin"]);
const IGNORED_FILES = new Set([".DS_Store"]);

export const DEFAULT_EXCLUDE_DIRS = Object.freeze([
  ...VCS_DIRS,
  ...VENDOR_DIRS,
  ...BUILD_DIRS,
]);

const toPosixPath = (value) => value.replaceAll("\\", "/");

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve the revision a scan is anchored to.
 *
 * Order of preference:
 *   1. an explicit `rev` (caller already knows the revision, e.g. incremental);
 *   2. `git rev-parse HEAD` (the source of truth when the CLI is present);
 *   3. a pure-Node fallback that reads `.git/HEAD`; a layout that cannot be
 *      dereferenced returns `null` rather than a fabricated revision.
 */
export function resolveRevision(repoPath, { rev } = {}) {
  if (typeof rev === "string" && rev.length > 0) return rev;

  try {
    const out = execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = out.trim();
    if (/^[0-9a-f]{40}$/i.test(parsed)) return parsed;
  } catch {
    // fall through to the .git/HEAD reader
  }

  return readRevisionFromDotGit(repoPath);
}

function readRevisionFromDotGit(repoPath) {
  try {
    const head = readFileSync(join(repoPath, ".git", "HEAD"), "utf8");
    const match = head.match(/^ref:\s*(.+?)\s*$/m);
    if (!match) return null; // detached HEAD: needs dereferencing, skip
    const sha = readFileSync(join(repoPath, ".git", match[1].trim()), "utf8").trim();
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * List the source files of a repository.
 *
 * @param {string} repoPath
 * @param {object} [opts]
 * @param {string[]} [opts.excludeDirs] extra directory basenames to prune. The
 *   invariant exclusions (VCS, node_modules, obj, bin) are always applied and
 *   can never be disabled.
 * @param {string[]} [opts.include]     keep only files whose relative path is
 *   under at least one of these prefixes; empty means "everything"
 * @param {(p: string) => boolean} [opts.filter]
 * @returns {Promise<{ root: string, files: string[] }>}
 */
export async function listSourceFiles(repoPath, opts = {}) {
  const root = resolve(repoPath);
  const exclude = new Set([...DEFAULT_EXCLUDE_DIRS, ...(opts.excludeDirs ?? [])]);
  const include = opts.include ?? [];
  const filter = opts.filter ?? (() => true);

  const files = [];
  await walk(root, root, exclude, (rel) => {
    const posix = toPosixPath(rel);
    if (include.length > 0) {
      const prefixes = include.map((p) => p.replace(/\/+$/, "")).filter(Boolean);
      if (!prefixes.some((p) => posix === p || posix.startsWith(`${p}/`))) return;
    }
    if (!filter(posix)) return;
    files.push(posix);
  });

  files.sort();
  return { root, files };
}

async function walk(root, dir, exclude, onFile) {
  let dirHandle;
  try {
    dirHandle = await opendir(dir);
  } catch {
    return;
  }

  for await (const entry of dirHandle) {
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // Do not recurse through symlinks: they can escape the repo or cycle.
      continue;
    }
    if (entry.isDirectory()) {
      if (exclude.has(entry.name)) continue;
      if (!isWithin(root, abs)) continue;
      await walk(root, abs, exclude, onFile);
    } else if (entry.isFile()) {
      if (IGNORED_FILES.has(entry.name)) continue;
      if (!isWithin(root, abs)) continue;
      onFile(relative(root, abs));
    }
  }
}

/**
 * Scan a repository: revision + deterministic source file list.
 *
 * @returns {Promise<{ root: string, rev: string|null, isGitRepo: boolean,
 *   files: string[] }>}
 */
export async function scanRepository({ path, rev, excludeDirs, include, filter } = {}) {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("scanRepository: path is required");
  }
  const root = resolve(path);
  const meta = await stat(root).catch(() => null);
  if (!meta || !meta.isDirectory()) {
    throw new Error(`scanRepository: not a directory: ${path}`);
  }

  const isGitRepo = await isGitRepository(root);
  const resolvedRev = resolveRevision(root, { rev });

  const { files } = await listSourceFiles(root, { excludeDirs, include, filter });

  return { root, rev: resolvedRev, isGitRepo, files };
}

async function isGitRepository(root) {
  try {
    const meta = await stat(join(root, ".git"));
    return meta.isDirectory();
  } catch {
    return false;
  }
}