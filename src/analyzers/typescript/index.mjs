// TypeScript analyzer entry (spine step 3).
//
// Owns the WASM runtime: it loads `web-tree-sitter.wasm` and
// `tree-sitter-typescript.wasm` from vendor/wasm (read-only; the vendor tree is
// never written by this product) and walks the .ts files of a scan, producing
// the canonical edges of the model (`imports` and `calls_endpoint`).
//
// The extraction itself lives in ./extract.mjs; here we wire the grammar
// loading and the corpus-wide endpoint index. A UI call is only linked to an
// endpoint that is actually DECLARED somewhere in the ingested corpus (rule 2):
// declared routes are recovered by parsing the repository's C# sources with the
// same vendorized grammar the C# analyzer uses, so the URL literal of a fetch/
// axios call never invents a link to a route the backend does not expose.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import { createTypeScriptExtractor, EXTRACTOR, EXTRACTOR_VERSION } from "./extract.mjs";
import { createCSharpExtractor, EMPTY_TYPE_INDEX } from "../csharp/extract.mjs";
import { listSourceFiles } from "../../scanner/index.mjs";

const VENDOR_WASM = fileURLToPath(new URL("../../../vendor/wasm", import.meta.url));

export { EXTRACTOR, EXTRACTOR_VERSION };

let runtimePromise = null;

/** Load the WASM runtime and both grammars exactly once per process. */
function loadRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      await Parser.init({
        locateFile: () => join(VENDOR_WASM, "web-tree-sitter.wasm"),
      });
      const tsLanguage = await Language.load(join(VENDOR_WASM, "tree-sitter-typescript.wasm"));
      const tsParser = new Parser();
      tsParser.setLanguage(tsLanguage);
      const csLanguage = await Language.load(join(VENDOR_WASM, "tree-sitter-c_sharp.wasm"));
      const csParser = new Parser();
      csParser.setLanguage(csLanguage);
      return {
        extractTs: createTypeScriptExtractor(tsLanguage, tsParser).extract,
        extractCs: createCSharpExtractor(csLanguage, csParser).extract,
      };
    })();
  }
  return runtimePromise;
}

/**
 * The declared endpoint routes of the corpus, as `METHOD route` strings
 * (e.g. "GET /api/orders"), recovered from its C# Map* declarations. When no
 * C# source exists the set is empty, so no call can be linked (honest gap).
 */
async function collectDeclaredRoutes(runtime, root, rev) {
  const routes = new Set();
  const { files } = await listSourceFiles(root, {
    filter: (p) => p.toLowerCase().endsWith(".cs"),
  });
  for (const cs of files) {
    const source = await readFile(join(root, cs), "utf8");
    const out = runtime.extractCs({ source, file: cs, rev, index: EMPTY_TYPE_INDEX });
    for (const node of out.nodes) {
      if (node.kind === "endpoint" && typeof node.route === "string") {
        routes.add(`${node.method} ${node.route}`);
      }
    }
  }
  return routes;
}

/**
 * Analyze a set of .ts files.
 *
 * @param {{ files: string[], root: string, rev: string }} opts `files` are
 *   repo-relative POSIX paths, `root` is the repository root, `rev` the
 *   revision the analysis is anchored to.
 * @returns {Promise<{ nodes: object[], edges: object[] }>}
 */
export async function analyzeTypeScript({ files, root, rev } = {}) {
  if (typeof rev !== "string" || rev.length === 0) {
    throw new TypeError("analyzeTypeScript: rev is required");
  }
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("analyzeTypeScript: root is required");
  }
  if (!Array.isArray(files) || files.length === 0) return { nodes: [], edges: [] };

  const runtime = await loadRuntime();
  const routes = await collectDeclaredRoutes(runtime, root, rev);

  const edges = [];
  for (const file of files) {
    const source = await readFile(join(root, file), "utf8");
    const out = runtime.extractTs({ source, file, rev, routes });
    edges.push(...out.edges);
  }

  return { nodes: [], edges };
}

/**
 * Lower-level handle on the loaded grammars, for callers that want to drive the
 * extraction themselves (tests, incremental). Idempotent: the WASM runtime is
 * loaded at most once.
 */
export async function createTypeScriptAnalyzer() {
  const runtime = await loadRuntime();
  return {
    collectDeclaredRoutes: (root, rev = "?") => collectDeclaredRoutes(runtime, root, rev),
    extract: (opts) => runtime.extractTs(opts),
  };
}