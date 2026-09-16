// Analyzer registry (spine step 3): maps file extensions to analyzers and
// gives Workspace a single hook to run every applicable analyzer over a scan.
import { analyzeCSharp } from "./csharp/index.mjs";
import { analyzeTypeScript } from "./typescript/index.mjs";

export const ANALYZERS = Object.freeze([
  {
    name: "csharp",
    extensions: [".cs"],
    analyze: analyzeCSharp,
  },
  {
    name: "typescript",
    extensions: [".ts", ".mts", ".cts", ".tsx"],
    analyze: analyzeTypeScript,
  },
]);

/** The analyzer that handles a file, or null when none applies. */
export function analyzerForFile(file) {
  const lower = String(file).toLowerCase();
  return ANALYZERS.find((a) => a.extensions.some((ext) => lower.endsWith(ext))) ?? null;
}

/**
 * Run every analyzer that applies to the given files.
 *
 * @param {{ files: string[], root: string, rev: string }} opts
 * @returns {Promise<{ nodes: object[], edges: object[] }>}
 */
export async function analyzeFiles({ files, root, rev } = {}) {
  const byAnalyzer = new Map();
  for (const file of files ?? []) {
    const analyzer = analyzerForFile(file);
    if (!analyzer) continue;
    if (!byAnalyzer.has(analyzer)) byAnalyzer.set(analyzer, []);
    byAnalyzer.get(analyzer).push(file);
  }
  const nodes = [];
  const edges = [];
  for (const [analyzer, analyzerFiles] of byAnalyzer) {
    const out = await analyzer.analyze({ files: analyzerFiles, root, rev });
    nodes.push(...out.nodes);
    edges.push(...out.edges);
  }
  return { nodes, edges };
}