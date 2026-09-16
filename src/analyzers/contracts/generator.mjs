// Generator-config analyzer (spine step 3): contract-first generated clients.
//
// In a contract-first repository the API client is produced by a generator
// (NSwag, openapi-generator) and is frequently NOT committed to the tree — the
// real shape of CleanArchitecture and lubesoft per their ADR-0004. The evidence
// for the API<->UI chain therefore cannot depend on reading the client: it must
// be recoverable from the generator configuration (nswag.json) and the source
// OpenAPI document (acceptance J2/J3, RFC-G1 v3 §6·J).
//
// A generator config is a JSON file whose root declares a source document and
// one or more outputs:
//
//   {
//     "documentGenerator": { "fromDocument": { "url": "contracts/shop.v1.json" } },
//     "codeGenerators":    { "openApiToTypeScriptClient": { "output": "ui/api-client.ts" } }
//   }
//
// Every `codeGenerators.*.output` is the generated client, and the whole
// document is generated FROM `documentGenerator.fromDocument.url`. Each pair
// yields ONE `generated_from` edge from the generated output to the source
// spec, whose evidence cites the config file at line 1 — the values are read
// literally from the config (rule 3: EXTRACTED), nothing is resolved from
// context, and a config without a source url or without any output produces
// nothing (rule 2).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createEdge, makeNodeId, toPosixPath } from "../../model/index.mjs";

export const EXTRACTOR = "generator-config";
export const EXTRACTOR_VERSION = "0.1.0";

/** Whether a parsed document declares a generator source document. */
function fromDocumentOf(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const from = doc.documentGenerator?.fromDocument;
  if (!from || typeof from.url !== "string" || from.url.length === 0) return null;
  return from;
}

/** The generator outputs declared by a parsed document, as `{ name, output }`. */
function outputsOf(doc) {
  const generators = doc?.codeGenerators;
  if (generators === null || typeof generators !== "object" || Array.isArray(generators)) {
    return [];
  }
  const outputs = [];
  for (const [name, generator] of Object.entries(generators)) {
    if (generator && typeof generator === "object" && typeof generator.output === "string" && generator.output.length > 0) {
      outputs.push({ name, output: generator.output });
    }
  }
  return outputs;
}

/**
 * Analyze the generator configs among the given files: every JSON file whose
 * root declares a `documentGenerator.fromDocument.url` and at least one
 * `codeGenerators.*.output` yields one `generated_from` edge per output, from
 * the generated output file to the source spec, with evidence citing the config
 * file at line 1.
 *
 * @param {{ files: string[], root: string, rev: string }} opts `files` are
 *   repo-relative POSIX paths, `root` is the repository root, `rev` the
 *   revision the analysis is anchored to.
 * @returns {Promise<{ nodes: object[], edges: object[], observations: object[] }>}
 */
export async function analyzeGenerators({ files, root, rev } = {}) {
  if (typeof rev !== "string" || rev.length === 0) {
    throw new TypeError("analyzeGenerators: rev is required");
  }
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("analyzeGenerators: root is required");
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { nodes: [], edges: [], observations: [] };
  }

  const edges = [];
  for (const file of files) {
    let source;
    try {
      source = await readFile(join(root, file), "utf8");
    } catch {
      continue; // file vanished between scan and analysis
    }

    let doc;
    try {
      doc = JSON.parse(source);
    } catch {
      continue; // not valid JSON: not a config this analyzer can read
    }

    const from = fromDocumentOf(doc);
    if (!from) continue;
    const outputs = outputsOf(doc);
    if (outputs.length === 0) continue;

    const spec = toPosixPath(from.url);
    const dst = makeNodeId("file", spec);
    for (const { output } of outputs) {
      const client = toPosixPath(output);
      const src = makeNodeId("client", client);
      edges.push(
        createEdge({
          src,
          dst,
          kind: "generated_from",
          nature: "EXTRACTED",
          extractor: EXTRACTOR,
          extractorVersion: EXTRACTOR_VERSION,
          evidence: { file, lineStart: 1, rev },
          observedInRev: rev,
        }),
      );
    }
  }

  return { nodes: [], edges, observations: [] };
}