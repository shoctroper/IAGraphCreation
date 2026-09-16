// C# extractor (spine step 3): tree-sitter query-based extraction of the
// canonical model from a parsed C# source tree.
//
// The three invariants of docs/API.md are the design of this file:
//
//   1. Every node and edge carries evidence {file, lineStart}: the line of the
//      declaration or invocation where the fact was observed.
//   2. When a resolution is uncertain there is no edge at all: an opaque DI
//      factory (`AddSingleton<IFace>(sp => ...)`) never produces a
//      binds_implementation edge, and an implements/binds edge is only created
//      when the referenced type is actually declared in the ingested corpus.
//   3. EXTRACTED only for what is read literally: routes come from the string
//      literal argument of MapGet/MapPost, DI types come from the explicit
//      two-type-argument form, implements from the explicit base list.
//
// The grammar loading (WASM) is owned by ./index.mjs; this module receives a
// loaded `Language` and a `Parser` and returns a pure extraction function.
import { Query } from "web-tree-sitter";
import {
  createNode,
  createEdge,
  makeNodeId,
  normalizeId,
} from "../../model/index.mjs";

export const EXTRACTOR = "csharp";
export const EXTRACTOR_VERSION = "0.1.0";

export const EMPTY_TYPE_INDEX = Object.freeze({
  interfaces: new Map(),
  classes: new Map(),
});

const MAP_METHODS = new Set(["MapGet", "MapPost", "MapPut", "MapDelete", "MapPatch"]);
const DI_METHODS = new Set(["AddSingleton", "AddScoped", "AddTransient"]);
// Assembly-scanning DI registrations (docs/API.md "binding_rule"): a call that
// declares a rule over a whole assembly/project rather than a single pair of
// types. The scanned assembly is resolved from the literal type reference
// (typeof(X).Assembly or X<T>), never guessed.
const SCAN_METHODS = new Set([
  "AddHandlersFromAssembly",
  "AddHandlersFromAssemblyContaining",
  "RegisterServicesFromAssembly",
  "RegisterServicesFromAssemblyContaining",
  "AddValidatorsFromAssembly",
  "AddValidatorsFromAssemblyContaining",
  "AddMaps",
]);

const QUERY = `
  (class_declaration
    name: (identifier) @type.name) @type.decl
  (interface_declaration
    name: (identifier) @type.name) @type.decl
  (method_declaration
    name: (identifier) @method.name) @method.decl
  (invocation_expression
    function: (member_access_expression
      name: (identifier) @endpoint.name)
    arguments: (argument_list) @endpoint.args) @endpoint.call
  (invocation_expression
    function: (member_access_expression
      name: (generic_name (identifier) @di.name (type_argument_list) @di.targs))
    arguments: (argument_list) @di.args) @di.call
`;

const slice = (node, src) => src.slice(node.startIndex, node.endIndex);
const lineOf = (node) => node.startPosition.row + 1;

function captures(match) {
  const map = new Map();
  for (const c of match.captures) map.set(c.name, c.node);
  return map;
}

/** Last identifier of a (possibly qualified, possibly generic) type reference. */
function simpleName(text) {
  const noGeneric = String(text).replace(/<.*$/, "").trim();
  const segments = noGeneric.split(".");
  return segments[segments.length - 1].trim();
}

function qualify(parts) {
  return normalizeId(parts.filter(Boolean).join("."));
}

/**
 * The file-scoped namespace of a compilation unit. The C# grammar hoists the
 * body of a file-scoped namespace to `compilation_unit`, so the declaration
 * node is a sibling of the types, not their ancestor.
 */
function fileScopedNamespace(tree, src) {
  for (const child of tree.rootNode.namedChildren) {
    if (child.type === "file_scoped_namespace_declaration") {
      const name = child.childForFieldName("name");
      if (name) return slice(name, src).trim();
    }
  }
  return null;
}

/** Walk up the ancestors collecting the enclosing block namespace names. */
function blockNamespaceParts(node, src) {
  const parts = [];
  let cur = node.parent;
  while (cur) {
    if (cur.type === "namespace_declaration") {
      const name = cur.childForFieldName("name");
      if (name) parts.unshift(slice(name, src).trim());
    }
    cur = cur.parent;
  }
  return parts;
}

/** Namespace-prefixed qualified name of a type within `tree`. */
function qualifyIn(tree, src, decl, name) {
  const parts = [fileScopedNamespace(tree, src), ...blockNamespaceParts(decl, src), name];
  return qualify(parts);
}

/**
 * The qualified name of the type that encloses `node`, or null when the node
 * is not inside a class/interface body. Resolved by position (ancestor
 * traversal), not by node identity: tree-sitter node wrappers are not stable
 * across `.parent` calls, so a Map keyed by the wrapper object is unreliable.
 */
function enclosingTypeQname(tree, src, node) {
  const typeNames = [];
  let outerTypeNode = null;
  let cur = node.parent;
  while (cur) {
    if (cur.type === "class_declaration" || cur.type === "interface_declaration") {
      const name = cur.childForFieldName("name");
      if (name) typeNames.unshift(slice(name, src).trim());
      if (!outerTypeNode) outerTypeNode = cur;
    }
    cur = cur.parent;
  }
  if (typeNames.length === 0) return null;
  return qualify([
    fileScopedNamespace(tree, src),
    ...blockNamespaceParts(outerTypeNode, src),
    ...typeNames,
  ]);
}

function findDescendant(node, type) {
  if (node.type === type) return node;
  for (const child of node.namedChildren) {
    const found = findDescendant(child, type);
    if (found) return found;
  }
  return null;
}

/**
 * The type name a scan registration scans, read literally from the source:
 * either the `typeof(X)` reference of `AddX(typeof(X).Assembly)` or the
 * generic argument of `AddXContaining<T>()`. Returns null when there is no
 * readable type reference (e.g. `RegisterServicesFromAssembly(Assembly.X())`):
 * the scanned assembly cannot be resolved, so no observation is emitted.
 */
function scanTypeName(argsNode, targsNode, source) {
  if (targsNode) {
    const first = targsNode.namedChildren[0];
    return first ? simpleName(slice(first, source)) : null;
  }
  if (!argsNode) return null;
  const typeOf = findDescendant(argsNode, "typeof_expression");
  if (!typeOf) return null;
  const typeChild = typeOf.namedChildren[0];
  return typeChild ? simpleName(slice(typeChild, source)) : null;
}

/**
 * The project domain (assembly) that declares a type: the namespace-qualified
 * name minus its last segment. `class:Shop.Api.Startup` -> `Shop.Api`.
 */
function assemblyOfTypeId(id) {
  const qname = String(id).replace(/^[^:]+:/, "");
  const parts = qname.split(".");
  parts.pop();
  return parts.length > 0 ? parts.join(".") : null;
}

/** The route literal of a Map* call: the first argument, when it is a string. */
function firstRouteArgument(argsNode, src) {
  const first = argsNode.firstNamedChild;
  if (!first) return null;
  const content = findDescendant(first, "string_literal_content");
  return content ? slice(content, src) : null;
}

function addToIndex(map, name, id) {
  let set = map.get(name);
  if (!set) {
    set = new Set();
    map.set(name, set);
  }
  set.add(id);
  return map;
}

/**
 * Create an extractor bound to a loaded C# grammar.
 *
 * @returns {{ collectTypes: ({source: string}) => TypeIndex,
 *            extract: ({source, file, rev, index}) => {nodes, edges, observations} }}
 */
export function createCSharpExtractor(language, parser) {
  const query = new Query(language, QUERY);

  function parse(source) {
    return parser.parse(source);
  }

  /** Collect the types DECLARED in a file, keyed by simple name -> ids. */
  function collectTypes({ source }) {
    const tree = parse(source);
    const interfaces = new Map();
    const classes = new Map();
    for (const m of query.matches(tree.rootNode)) {
      const cap = captures(m);
      const decl = cap.get("type.decl");
      if (!decl) continue;
      const isInterface = decl.type === "interface_declaration";
      const name = slice(cap.get("type.name"), source);
      const qname = qualifyIn(tree, source, decl, name);
      const id = makeNodeId(isInterface ? "interface" : "class", qname);
      addToIndex(isInterface ? interfaces : classes, name, id);
    }
    return { interfaces, classes };
  }

  /**
   * Extract the model for one file. `index` must already aggregate the types
   * declared across the whole corpus so implements/binds_implementation edges
   * can resolve cross-file references with certainty (rule 2).
   */
  function extract({ source, file, rev, index = EMPTY_TYPE_INDEX }) {
    const tree = parse(source);
    const nodes = [];
    const edges = [];
    const observations = [];

    const typeRecords = [];

    // Scan registrations are surfaced as observations (call + resolved
    // assembly): the resolve pass turns each into a binding_rule node. The
    // assembly is only resolved when the referenced type is declared exactly
    // once in the corpus (rule 2); otherwise there is no observation at all.
    const scanObservation = ({ callNode, method, argsNode, targsNode }) => {
      const typeName = scanTypeName(argsNode, targsNode, source);
      if (!typeName) return null;
      const ids = [];
      for (const key of ["classes", "interfaces"]) {
        const set = index[key].get(typeName);
        if (set) ids.push(...set);
      }
      if (ids.length !== 1) return null;
      const assembly = assemblyOfTypeId(ids[0]);
      if (!assembly) return null;
      return {
        kind: "scan_registration",
        method,
        call: slice(callNode, source),
        assembly,
        typeRef: typeName,
        file,
        lineStart: lineOf(callNode),
        rev,
      };
    };

    for (const m of query.matches(tree.rootNode)) {
      const cap = captures(m);

      const decl = cap.get("type.decl");
      if (decl) {
        const isInterface = decl.type === "interface_declaration";
        const name = slice(cap.get("type.name"), source);
        const qname = qualifyIn(tree, source, decl, name);
        const id = makeNodeId(isInterface ? "interface" : "class", qname);
        const bases = decl.namedChildren.find((c) => c.type === "base_list") ?? null;
        const rec = {
          kind: isInterface ? "interface" : "class",
          name,
          qname,
          id,
          bases,
          lineStart: lineOf(decl),
        };
        typeRecords.push(rec);
        nodes.push(
          createNode({
            kind: rec.kind,
            name: rec.name,
            qualifiedName: rec.qname,
            file,
            lineStart: rec.lineStart,
            rev,
          }),
        );
        continue;
      }

      const method = cap.get("method.decl");
      if (method) {
        const name = slice(cap.get("method.name"), source);
        const owner = enclosingTypeQname(tree, source, method);
        const qname = owner ? `${owner}.${name}` : name;
        nodes.push(
          createNode({
            kind: "method",
            name,
            qualifiedName: qname,
            file,
            lineStart: lineOf(method),
            rev,
          }),
        );
        continue;
      }

      const call = cap.get("endpoint.call");
      if (call) {
        const methodName = slice(cap.get("endpoint.name"), source);
        if (SCAN_METHODS.has(methodName)) {
          const obs = scanObservation({
            callNode: call,
            method: methodName,
            argsNode: cap.get("endpoint.args"),
          });
          if (obs) observations.push(obs);
          continue;
        }
        if (MAP_METHODS.has(methodName)) {
          const route = firstRouteArgument(cap.get("endpoint.args"), source);
          if (route !== null) {
            const verb = methodName.replace("Map", "").toUpperCase();
            const qname = `${verb} ${route}`;
            nodes.push(
              createNode({
                kind: "endpoint",
                name: qname,
                qualifiedName: qname,
                method: verb,
                route,
                file,
                lineStart: lineOf(call),
                rev,
              }),
            );
          }
        }
        continue;
      }

      const dcall = cap.get("di.call");
      if (dcall) {
        const diName = slice(cap.get("di.name"), source);
        if (SCAN_METHODS.has(diName)) {
          const obs = scanObservation({
            callNode: dcall,
            method: diName,
            argsNode: cap.get("di.args"),
            targsNode: cap.get("di.targs"),
          });
          if (obs) observations.push(obs);
          continue;
        }
        if (DI_METHODS.has(diName)) {
          const targs = cap.get("di.targs");
          const dargs = cap.get("di.args");
          const typeArgs = targs ? targs.namedChildren : [];
          // B7: only the explicit two-type-argument registration with an empty
          // argument list is a literal binding. The opaque factory form
          // (one type argument + a factory lambda) is deliberately NOT a
          // binding: the implementation is decided inside the lambda (B8).
          const isExplicitRegistration =
            typeArgs.length === 2 && (!dargs || dargs.namedChildren.length === 0);
          if (isExplicitRegistration) {
            const ifaceName = slice(typeArgs[0], source);
            const implName = slice(typeArgs[1], source);
            const ifaceIds = index.interfaces.get(ifaceName);
            const implIds = index.classes.get(implName);
            if (ifaceIds && ifaceIds.size === 1 && implIds && implIds.size === 1) {
              const [srcId] = ifaceIds;
              const [dstId] = implIds;
              edges.push(
                createEdge({
                  src: srcId,
                  dst: dstId,
                  kind: "binds_implementation",
                  nature: "EXTRACTED",
                  extractor: EXTRACTOR,
                  extractorVersion: EXTRACTOR_VERSION,
                  evidence: { file, lineStart: lineOf(dcall), rev },
                }),
              );
            }
          }
        }
      }
    }

    // implements: an explicit base that names an interface declared in the
    // corpus. Only when the reference resolves to exactly one interface does
    // the edge exist (rule 2).
    for (const rec of typeRecords) {
      if (rec.kind !== "class" || !rec.bases) continue;
      for (const base of rec.bases.namedChildren) {
        const baseName = simpleName(slice(base, source));
        const ifaceIds = index.interfaces.get(baseName);
        if (ifaceIds && ifaceIds.size === 1) {
          const [dstId] = ifaceIds;
          edges.push(
            createEdge({
              src: rec.id,
              dst: dstId,
              kind: "implements",
              nature: "EXTRACTED",
              extractor: EXTRACTOR,
              extractorVersion: EXTRACTOR_VERSION,
              evidence: { file, lineStart: lineOf(base), rev },
            }),
          );
        }
      }
    }

    return { nodes, edges, observations };
  }

  return { collectTypes, extract };
}

/**
 * Merge nodes with the same id, keeping the evidence of every fragment.
 * A partial class split across files is ONE node with the evidence of both
 * fragments (docs/API.md rule 6; acceptance B6).
 */
export function mergeNodes(nodes) {
  const byId = new Map();
  for (const node of nodes) {
    const existing = byId.get(node.id);
    if (!existing) {
      byId.set(node.id, { ...node, evidence: [...(node.evidence ?? [])] });
      continue;
    }
    const seen = new Set((existing.evidence ?? []).map((e) => `${e.file}:${e.lineStart}`));
    for (const ev of node.evidence ?? []) {
      const key = `${ev.file}:${ev.lineStart}`;
      if (!seen.has(key)) {
        existing.evidence.push(ev);
        seen.add(key);
      }
    }
  }
  return [...byId.values()];
}