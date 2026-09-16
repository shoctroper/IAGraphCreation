// Canonical graph schema and node/edge model (RFC-G1 v3, docs/API.md).
//
// This module is deliberately dependency-free: it is the vocabulary every other
// slice (store, analyzers, resolve, incremental, query) is written against. It
// encodes the three invariants that may not be relaxed anywhere else:
//
//   1. No edge without evidence carrying `file` and `lineStart`.
//   2. When the resolution is uncertain there is no edge at all.
//   3. `EXTRACTED` only for what is read literally in the source.
//
// Operational metadata (timestamps, durations) is represented but excluded from
// the canonical form; see ./serialize.mjs.

export const NATURES = Object.freeze(["EXTRACTED", "INFERRED", "AMBIGUOUS"]);

export const NODE_KINDS = Object.freeze([
  "repository",
  "project",
  "module",
  "namespace",
  "file",
  "type",
  "class",
  "interface",
  "method",
  "function",
  "endpoint",
  "route",
  "client",
  "component",
  "page",
  "binding",
  "binding_rule",
]);

export const EDGE_KINDS = Object.freeze([
  "contains",
  "imports",
  "calls",
  "references",
  "inherits",
  "implements",
  "instantiates",
  "declares_endpoint",
  "calls_endpoint",
  "consumed_by",
  "routes_to",
  "binds_implementation",
  "generated_from",
]);

export const NATURE_SET = new Set(NATURES);
export const NODE_KIND_SET = new Set(NODE_KINDS);
export const EDGE_KIND_SET = new Set(EDGE_KINDS);

// Roles a repository can be added with (docs/API.md `addRepo`).
export const REPO_ROLES = Object.freeze(["api", "ui", "lib"]);

export function isNature(value) {
  return NATURE_SET.has(value);
}

export function isNodeKind(value) {
  return NODE_KIND_SET.has(value);
}

export function isEdgeKind(value) {
  return EDGE_KIND_SET.has(value);
}

/**
 * Normalise a path to POSIX form so the model is portable (acceptance K3).
 * Windows separators must never leak into the graph.
 */
export function toPosixPath(value) {
  if (typeof value !== "string") return value;
  return value.replaceAll("\\", "/");
}

/** Collapse insignificant whitespace so ids are stable across formatting. */
export function normalizeId(value) {
  return String(value).trim().replace(/\s+/g, " ");
}

/**
 * Stable node identity, keyed by qualified name and never by file
 * (docs/API.md rule 6): a `partial class` split across files is ONE node.
 */
export function makeNodeId(kind, qualifiedName) {
  return `${kind}:${normalizeId(qualifiedName)}`;
}

/**
 * Stable edge identity derived only from semantic content and its evidence
 * location, so two builds of the same revision produce the same ids.
 */
export function makeEdgeId({ src, dst, kind, evidence, ruleId }) {
  const file = evidence && evidence.file ? toPosixPath(evidence.file) : "?";
  const line = evidence && Number.isInteger(evidence.lineStart) ? evidence.lineStart : "?";
  const suffix = ruleId ? `#${ruleId}` : "";
  return `${src}->${dst}:${kind}@${file}:${line}${suffix}`;
}

export function createEvidence({ file, lineStart, lineEnd, rev } = {}) {
  if (typeof file !== "string" || file.length === 0) {
    throw new TypeError("evidence.file is required");
  }
  if (!Number.isInteger(lineStart) || lineStart < 1) {
    throw new TypeError("evidence.lineStart must be a positive integer");
  }
  if (lineEnd !== undefined && (!Number.isInteger(lineEnd) || lineEnd < lineStart)) {
    throw new TypeError("evidence.lineEnd must be an integer >= lineStart");
  }
  // A rev that IS supplied must be a real revision: builders must produce
  // evidence that validates as-is. Omitting `rev` stays legal so nodes/edges
  // can backfill it from their own revision (rule 5), but a wrong type or an
  // empty string would make every downstream invariant fail.
  if (rev !== undefined && (typeof rev !== "string" || rev.length === 0)) {
    throw new TypeError("evidence.rev must be a non-empty string when provided");
  }
  const ev = { file: toPosixPath(file), lineStart, rev };
  if (Number.isInteger(lineEnd)) ev.lineEnd = lineEnd;
  return ev;
}

/**
 * Build a canonical node. Revision-awareness is not optional: a node always
 * carries `firstSeenRev` and `lastSeenRev`.
 */
export function createNode(input = {}) {
  const {
    kind,
    name,
    qualifiedName = name,
    id,
    file,
    lineStart,
    lineEnd,
    route,
    method,
    scope,
    evidence,
    firstSeenRev,
    lastSeenRev,
    rev,
    metadata,
  } = input;

  if (!isNodeKind(kind)) {
    throw new TypeError(`unknown node kind: ${String(kind)}`);
  }
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("node.name is required");
  }
  if (typeof qualifiedName !== "string" || qualifiedName.length === 0) {
    throw new TypeError("node.qualifiedName is required");
  }

  const first = firstSeenRev ?? rev;
  const last = lastSeenRev ?? rev ?? first;
  if (typeof first !== "string" || first.length === 0) {
    throw new TypeError("node.firstSeenRev is required");
  }
  if (typeof last !== "string" || last.length === 0) {
    throw new TypeError("node.lastSeenRev is required");
  }

  const node = {
    id: id ?? makeNodeId(kind, qualifiedName),
    kind,
    name,
    qualifiedName,
    firstSeenRev: first,
    lastSeenRev: last,
  };

  if (file !== undefined) node.file = toPosixPath(file);
  if (Number.isInteger(lineStart)) node.lineStart = lineStart;
  if (Number.isInteger(lineEnd)) node.lineEnd = lineEnd;
  if (route !== undefined) node.route = route;
  if (method !== undefined) node.method = method;
  if (scope !== undefined) node.scope = scope;
  if (metadata !== undefined) node.metadata = metadata;

  // Nodes record every place they were observed: a partial class keeps the
  // evidence of both fragments (acceptance B6). Evidence without a revision is
  // a defect: the node's own revision is backfilled so every fragment stays
  // traceable to the revision it was observed at (rule 5).
  if (evidence !== undefined) {
    node.evidence = evidence.map((e) => {
      const ev = createEvidence(e);
      if (!ev.rev) ev.rev = first;
      return ev;
    });
  } else if (file !== undefined && Number.isInteger(lineStart)) {
    node.evidence = [createEvidence({ file, lineStart, lineEnd, rev: first })];
  }

  return node;
}

/**
 * Build a canonical edge. Throws on a missing or malformed evidence location:
 * an edge without evidence is a defect, not a low-confidence edge.
 */
export function createEdge(input = {}) {
  const {
    id,
    src,
    dst,
    kind,
    nature,
    extractor,
    extractorVersion,
    evidence,
    observedInRev,
    firstSeenRev,
    lastSeenRev,
    ruleId,
    metadata,
  } = input;

  if (typeof src !== "string" || src.length === 0) throw new TypeError("edge.src is required");
  if (typeof dst !== "string" || dst.length === 0) throw new TypeError("edge.dst is required");
  if (!isEdgeKind(kind)) throw new TypeError(`unknown edge kind: ${String(kind)}`);
  if (!isNature(nature)) throw new TypeError(`unknown edge nature: ${String(nature)}`);
  if (typeof extractor !== "string" || extractor.length === 0) {
    throw new TypeError("edge.extractor is required");
  }
  if (typeof extractorVersion !== "string" || extractorVersion.length === 0) {
    throw new TypeError("edge.extractorVersion is required");
  }

  const ev = createEvidence(evidence);
  if (!ev.rev) {
    if (typeof observedInRev !== "string" || observedInRev.length === 0) {
      throw new TypeError("edge.evidence.rev or edge.observedInRev is required");
    }
    ev.rev = observedInRev;
  }

  const observed = observedInRev ?? ev.rev;
  const first = firstSeenRev ?? observed;
  const last = lastSeenRev ?? observed;

  if (ruleId !== undefined && nature !== "INFERRED") {
    throw new TypeError("edges derived from a binding_rule must be INFERRED");
  }

  const edge = {
    id: id ?? makeEdgeId({ src, dst, kind, evidence: ev, ruleId }),
    src,
    dst,
    kind,
    nature,
    extractor,
    extractorVersion,
    evidence: ev,
    observedInRev: observed,
    firstSeenRev: first,
    lastSeenRev: last,
  };

  if (ruleId !== undefined) edge.ruleId = ruleId;
  if (metadata !== undefined) edge.metadata = metadata;
  return edge;
}

/** A node born under `rev`, or the same node refreshed at `rev`. */
export function withRevision(node, rev) {
  return {
    ...node,
    lastSeenRev: rev,
    firstSeenRev: node.firstSeenRev ?? rev,
  };
}

/**
 * A revision as first-class metadata: the git identity a graph was observed at.
 * `sha` is the semantic identity and the only required field; `parent` records
 * lineage and `summary` a human-readable subject. `at` is the commit timestamp,
 * which is operational and therefore excluded from the canonical form
 * (docs/API.md rule 7: timestamps never enter the canonical hash).
 */
export function createRevision({ sha, parent, at, summary } = {}) {
  if (typeof sha !== "string" || sha.length === 0) {
    throw new TypeError("revision.sha is required");
  }
  const revision = { sha };
  if (typeof parent === "string" && parent.length > 0) revision.parent = parent;
  if (typeof at === "string" && at.length > 0) revision.at = at;
  if (typeof summary === "string" && summary.length > 0) revision.summary = summary;
  return revision;
}
