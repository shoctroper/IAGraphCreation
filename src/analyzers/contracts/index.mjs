// Contracts analyzer (spine step 3): contract-first endpoint evidence.
//
// A committed OpenAPI spec (e.g. contracts/shop.v1.json) is a literal source of
// endpoints: each `paths[path].<method>` operation declares an endpoint exactly
// like a Map* call in C# (acceptance J1). This analyzer parses any JSON file
// whose root carries an `openapi` field and turns every operation into an
// endpoint node whose evidence {file, lineStart, rev} cites the spec file.
//
// The three invariants of docs/API.md hold:
//   1. every node carries evidence {file, lineStart} citing the spec;
//   2. nothing is resolved from context: an operation is read literally;
//   3. only real HTTP operation keys become endpoints — "parameters", "servers"
//      or any other path-item key is never invented as an endpoint, and a JSON
//      file without an `openapi` root field produces nothing (rule 3).
//
// The endpoint node identity is `METHOD route`, the same qualified name the C#
// analyzer uses, so a route declared in both the code and the spec is ONE node.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createNode } from "../../model/index.mjs";

export const EXTRACTOR = "contracts";
export const EXTRACTOR_VERSION = "0.1.0";

// The HTTP operation keys OpenAPI allows at the path-item level. Anything else
// is structural (parameters, servers, $ref) and must not be treated as an
// endpoint (rule 3).
const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

/** Whether a parsed document is an OpenAPI spec: an object with an `openapi` field. */
function isOpenApiSpec(doc) {
  return (
    doc !== null &&
    typeof doc === "object" &&
    !Array.isArray(doc) &&
    typeof doc.openapi === "string" &&
    doc.openapi.length > 0
  );
}

/**
 * Analyze the OpenAPI contracts among the given files: every JSON file whose
 * root has an `openapi` field yields one endpoint node per `paths` operation.
 *
 * @param {{ files: string[], root: string, rev: string }} opts `files` are
 *   repo-relative POSIX paths, `root` is the repository root, `rev` the
 *   revision the analysis is anchored to.
 * @returns {Promise<{ nodes: object[], edges: object[], observations: object[] }>}
 */
export async function analyzeContracts({ files, root, rev } = {}) {
  if (typeof rev !== "string" || rev.length === 0) {
    throw new TypeError("analyzeContracts: rev is required");
  }
  if (typeof root !== "string" || root.length === 0) {
    throw new TypeError("analyzeContracts: root is required");
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { nodes: [], edges: [], observations: [] };
  }

  const nodes = [];
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
      continue; // not valid JSON: not a spec this analyzer can read
    }
    if (!isOpenApiSpec(doc) || doc.paths === null || typeof doc.paths !== "object") continue;

    for (const [route, item] of Object.entries(doc.paths)) {
      if (item === null || typeof item !== "object") continue;
      for (const [key, operation] of Object.entries(item)) {
        if (!HTTP_METHODS.has(key.toLowerCase())) continue;
        if (operation === null || typeof operation !== "object") continue;
        const method = key.toUpperCase();
        const qname = `${method} ${route}`;
        nodes.push(
          createNode({
            kind: "endpoint",
            name: qname,
            qualifiedName: qname,
            method,
            route,
            file,
            lineStart: 1,
            rev,
          }),
        );
      }
    }
  }

  return { nodes, edges: [], observations: [] };
}