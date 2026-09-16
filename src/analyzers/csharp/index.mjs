// C# analyzer entry (spine step 3).
//
// Owns the WASM runtime: it loads `web-tree-sitter.wasm` and
// `tree-sitter-c_sharp.wasm` from vendor/wasm (read-only; the vendor tree is
// never written by this product) and walks the .cs files of a scan, producing
// the canonical nodes and edges of the model.
//
// The extraction itself lives in ./extract.mjs; here we only wire the grammar
// loading, the corpus-wide type index (needed so implements and
// binds_implementation edges resolve cross-file references with certainty) and
// the merging of partial-class fragments into a single node.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
import {
  createCSharpExtractor,
  mergeNodes,
  EXTRACTOR,
  EXTRACTOR_VERSION,
} from "./extract.mjs";

const VENDOR_WASM = fileURLToPath(new URL("../../../vendor/wasm", import.meta.url));

export { EXTRACTOR, EXTRACTOR_VERSION };

let extractorPromise = null;

/** Load the tree-sitter WASM runtime exactly once per process. */
function loadExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      await Parser.init({
        locateFile: () => join(VENDOR_WASM, "web-tree-sitter.wasm"),
      });
      const language = await Language.load(join(VENDOR_WASM, "tree-sitter-c_sharp.wasm"));
      const parser = new Parser();
      parser.setLanguage(language);
      return createCSharpExtractor(language, parser);
    })();
  }
  return extractorPromise;
}

function mergeTypeIndex(target, types) {
  for (const key of ["interfaces", "classes"]) {
    for (const [name, ids] of types[key]) {
      let set = target[key].get(name);
      if (!set) {
        set = new Set();
        target[key].set(name, set);
      }
      for (const id of ids) set.add(id);
    }
  }
}

/**
 * Analyze a set of .cs files.
 *
 * @param {{ files: string[], root: string, rev: string }} opts `files` are
 *   repo-relative POSIX paths, `root` is the repository root, `rev` the
 *   revision the analysis is anchored to.
 * @returns {Promise<{ nodes: object[], edges: object[] }>}
 */
export async function analyzeCSharp({ files, root, rev } = {}) {
  if (typeof rev !== "string" || rev.length === 0) {
    throw new TypeError("analyzeCSharp: rev is required");
  }
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("analyzeCSharp: root is required");
  }
  if (!Array.isArray(files) || files.length === 0) return { nodes: [], edges: [] };

  const extractor = await loadExtractor();

  const sources = [];
  for (const file of files) {
    sources.push([file, await readFile(join(root, file), "utf8")]);
  }

  // Pass 1: the corpus-wide type index, so a binding in one file can resolve a
  // type declared in another with certainty (rule 2).
  const index = { interfaces: new Map(), classes: new Map() };
  for (const [, source] of sources) {
    mergeTypeIndex(index, extractor.collectTypes({ source }));
  }

  // Pass 2: per-file extraction against the full index.
  const nodes = [];
  const edges = [];
  for (const [file, source] of sources) {
    const out = extractor.extract({ source, file, rev, index });
    nodes.push(...out.nodes);
    edges.push(...out.edges);
  }

  return { nodes: mergeNodes(nodes), edges };
}

/**
 * Lower-level handle on the loaded grammar, for callers that want to drive the
 * two passes themselves (tests, incremental). Idempotent: the WASM runtime is
 * loaded at most once.
 */
export async function createCSharpAnalyzer() {
  const extractor = await loadExtractor();
  return {
    collectTypes: (opts) => extractor.collectTypes(opts),
    extract: (opts) => extractor.extract(opts),
  };
}