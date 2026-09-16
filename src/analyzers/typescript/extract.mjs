// TypeScript extractor (spine step 3): tree-sitter query-based extraction of
// the canonical model from a parsed TypeScript source tree.
//
// The three invariants of docs/API.md are the design of this file:
//
//   1. Every edge carries evidence {file, lineStart}: the line of the import
//      statement or of the HTTP call where the fact was observed.
//   2. When a resolution is uncertain there is no edge at all: a `calls_endpoint`
//      edge only exists when the literal URL of a real HTTP call (native fetch
//      or axios) resolves to a route that is actually declared as an endpoint in
//      the ingested corpus. A bare string constant is never a call, and an
//      interpolation that cannot be read literally never becomes a route.
//   3. EXTRACTED only for what is read literally: the URL comes from a string
//      literal or from the literal segments of a template string, with module
//      scope string constants inlined and the remaining interpolations mapped to
//      `{param}` route segments (the exact shape declared by the backend).
//
// The grammar loading (WASM) is owned by ./index.mjs; this module receives a
// loaded `Language` and a `Parser` and returns a pure extraction function.
import { Query } from "web-tree-sitter";
import { createEdge, makeNodeId } from "../../model/index.mjs";

export const EXTRACTOR = "typescript";
export const EXTRACTOR_VERSION = "0.1.0";

const FETCH_FN = "fetch";
const AXIOS_OBJ = "axios";
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const EMPTY_ROUTES = Object.freeze(new Set());

const QUERY = `
  (import_statement) @import.stmt
  (call_expression
    function: (identifier) @call.fn
    arguments: (arguments) @call.args) @call.expr
  (call_expression
    function: (member_expression
      object: (identifier) @call.obj
      property: (property_identifier) @call.member)
    arguments: (arguments) @call.args) @call.expr
  (lexical_declaration
    (variable_declarator
      name: (identifier) @const.name
      value: (string) @const.value))
`;

const slice = (node, src) => src.slice(node.startIndex, node.endIndex);
const lineOf = (node) => node.startPosition.row + 1;

function captures(match) {
  const map = new Map();
  for (const c of match.captures) map.set(c.name, c.node);
  return map;
}

/** The unquoted text of a `string` node, or null when there is no fragment. */
function stringValue(node, src) {
  if (!node || node.type !== "string") return null;
  const frag = node.namedChildren.find((c) => c.type === "string_fragment");
  return frag ? slice(frag, src) : null;
}

/**
 * Resolve a relative import specifier (./x, ../y) against the importing file,
 * producing the repo-relative path the import names. Bare specifiers (packages)
 * are left untouched by the caller.
 */
function resolveRelative(file, specifier) {
  const parts = file.split("/");
  parts.pop();
  for (const seg of specifier.split("/")) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.filter(Boolean).join("/");
}

/**
 * The literal route an HTTP call reaches, derived from its URL argument:
 *   - a `string` literal is read verbatim;
 *   - a `template_string` concatenates its literal `string_fragment` segments,
 *     inlining interpolations that name a module-scope string constant and
 *     mapping every other interpolation to a `{name}` route segment.
 * Returns null when the argument is not a literal the extractor can read
 * (rule 2: uncertain -> no edge).
 */
function routeFromUrl(argNode, src, consts) {
  if (argNode.type === "string") return stringValue(argNode, src);
  if (argNode.type === "template_string") {
    let route = "";
    for (const child of argNode.namedChildren) {
      if (child.type === "string_fragment") {
        route += slice(child, src);
      } else if (child.type === "template_substitution") {
        const ident = child.namedChildren.find((c) => c.type === "identifier");
        const name = ident ? slice(ident, src).trim() : "";
        const value = consts.get(name);
        if (value !== undefined) {
          route += value;
        } else if (name.length > 0) {
          route += `{${name}}`;
        } else {
          return null; // an interpolation that cannot be read -> uncertain
        }
      }
    }
    return route;
  }
  return null;
}

/** The HTTP verb of a fetch call: the `method` option when present, else GET. */
function fetchMethod(argsNode, src) {
  const children = argsNode.namedChildren;
  if (children.length < 2 || children[1].type !== "object") return null;
  for (const pair of children[1].namedChildren) {
    if (pair.type !== "pair") continue;
    const key = pair.childForFieldName("key");
    const value = pair.childForFieldName("value");
    if (key && slice(key, src) === "method") {
      return stringValue(value, src) ?? null;
    }
  }
  return null;
}

/**
 * Create an extractor bound to a loaded TypeScript grammar.
 *
 * @returns {{ extract: ({source, file, rev, routes}) => {nodes, edges} }}
 *   `routes` is the set of declared `METHOD route` strings (e.g. "GET /api/orders")
 *   collected from the corpus; only calls that resolve to a declared route
 *   produce a `calls_endpoint` edge (rule 2).
 */
export function createTypeScriptExtractor(language, parser) {
  const query = new Query(language, QUERY);

  function parse(source) {
    return parser.parse(source);
  }

  /** Module-scope string constants, name -> literal value. */
  function collectConstStrings(tree, src) {
    const consts = new Map();
    for (const m of query.matches(tree.rootNode)) {
      const cap = captures(m);
      const nameNode = cap.get("const.name");
      const valueNode = cap.get("const.value");
      if (nameNode && valueNode) {
        const value = stringValue(valueNode, src);
        if (value !== null) consts.set(slice(nameNode, src), value);
      }
    }
    return consts;
  }

  function extract({ source, file, rev, routes = EMPTY_ROUTES }) {
    const tree = parse(source);
    const consts = collectConstStrings(tree, source);
    const edges = [];
    const srcId = makeNodeId("file", file);

    for (const m of query.matches(tree.rootNode)) {
      const cap = captures(m);

      const stmt = cap.get("import.stmt");
      if (stmt) {
        const specNode = stmt.namedChildren.find((c) => c.type === "string");
        const spec = stringValue(specNode, source);
        if (spec !== null) {
          const dstId = spec.startsWith(".")
            ? makeNodeId("file", resolveRelative(file, spec))
            : makeNodeId("module", spec);
          edges.push(
            createEdge({
              src: srcId,
              dst: dstId,
              kind: "imports",
              nature: "EXTRACTED",
              extractor: EXTRACTOR,
              extractorVersion: EXTRACTOR_VERSION,
              evidence: { file, lineStart: lineOf(stmt), rev },
            }),
          );
        }
        continue;
      }

      const fn = cap.get("call.fn");
      const obj = cap.get("call.obj");
      if (!fn && !obj) continue;
      const args = cap.get("call.args");
      const urlArg = args ? args.namedChildren[0] : null;
      if (!urlArg) continue;

      let method = null;
      if (fn && slice(fn, source) === FETCH_FN) {
        method = fetchMethod(args, source) ?? "GET";
      } else if (obj && slice(obj, source) === AXIOS_OBJ) {
        const member = cap.get("call.member");
        const verb = member ? slice(member, source) : "";
        if (!HTTP_VERBS.has(verb)) continue;
        method = verb.toUpperCase();
      } else {
        continue;
      }

      const route = routeFromUrl(urlArg, source, consts);
      if (route === null) continue;
      if (!routes.has(`${method} ${route}`)) continue;

      edges.push(
        createEdge({
          src: srcId,
          dst: makeNodeId("endpoint", `${method} ${route}`),
          kind: "calls_endpoint",
          nature: "EXTRACTED",
          extractor: EXTRACTOR,
          extractorVersion: EXTRACTOR_VERSION,
          evidence: { file, lineStart: lineOf(cap.get("call.expr")), rev },
          metadata: { route, method },
        }),
      );
    }

    return { nodes: [], edges };
  }

  return { extract };
}