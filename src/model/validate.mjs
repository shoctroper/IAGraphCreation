// Invariant validation for the canonical graph (docs/API.md "Reglas invariantes").
//
// These checks are the executable form of the rules that override any
// implementation detail. They are used by the model and, later, by the store
// before anything is persisted.
import {
  NATURES,
  NODE_KINDS,
  EDGE_KINDS,
  NATURE_SET,
  NODE_KIND_SET,
  EDGE_KIND_SET,
} from "./types.mjs";

const isNonEmptyString = (v) => typeof v === "string" && v.length > 0;
const isPositiveInt = (v) => Number.isInteger(v) && v >= 1;

function validateEvidence(evidence, { required }) {
  const errors = [];
  if (evidence === undefined || evidence === null) {
    if (required) errors.push("evidence is required");
    return errors;
  }
  if (typeof evidence !== "object") {
    errors.push("evidence must be an object");
    return errors;
  }
  if (!isNonEmptyString(evidence.file)) errors.push("evidence.file is required");
  else if (evidence.file.includes("\\")) errors.push("evidence.file must be a POSIX path");
  if (!isPositiveInt(evidence.lineStart)) {
    errors.push("evidence.lineStart must be a positive integer");
  }
  if (evidence.lineEnd !== undefined && !isPositiveInt(evidence.lineEnd)) {
    errors.push("evidence.lineEnd must be a positive integer");
  }
  if (!isNonEmptyString(evidence.rev)) errors.push("evidence.rev is required");
  return errors;
}

export function validateNode(node) {
  const errors = [];
  if (node === null || typeof node !== "object") return ["node must be an object"];

  if (!isNonEmptyString(node.id)) errors.push("node.id is required");
  if (!NODE_KIND_SET.has(node.kind)) {
    errors.push(`node.kind must be one of ${NODE_KINDS.join(", ")}`);
  }
  if (!isNonEmptyString(node.name)) errors.push("node.name is required");
  // Rule 6: identity is the qualified name, never the file.
  if (!isNonEmptyString(node.qualifiedName)) errors.push("node.qualifiedName is required");
  if (!isNonEmptyString(node.firstSeenRev)) errors.push("node.firstSeenRev is required");
  if (!isNonEmptyString(node.lastSeenRev)) errors.push("node.lastSeenRev is required");
  if (node.file !== undefined) {
    if (!isNonEmptyString(node.file)) errors.push("node.file must be a non-empty string");
    else if (node.file.includes("\\")) errors.push("node.file must be a POSIX path");
  }
  if (node.lineStart !== undefined && !isPositiveInt(node.lineStart)) {
    errors.push("node.lineStart must be a positive integer");
  }
  if (node.evidence !== undefined) {
    if (!Array.isArray(node.evidence)) {
      errors.push("node.evidence must be an array");
    } else {
      node.evidence.forEach((ev, i) => {
        for (const e of validateEvidence(ev, { required: true })) {
          errors.push(`node.evidence[${i}]: ${e}`);
        }
      });
    }
  }
  return errors;
}

export function validateEdge(edge) {
  const errors = [];
  if (edge === null || typeof edge !== "object") return ["edge must be an object"];

  if (!isNonEmptyString(edge.id)) errors.push("edge.id is required");
  if (!isNonEmptyString(edge.src)) errors.push("edge.src is required");
  if (!isNonEmptyString(edge.dst)) errors.push("edge.dst is required");
  if (!EDGE_KIND_SET.has(edge.kind)) {
    errors.push(`edge.kind must be one of ${EDGE_KINDS.join(", ")}`);
  }
  if (!NATURE_SET.has(edge.nature)) {
    errors.push(`edge.nature must be one of ${NATURES.join(", ")}`);
  }
  if (!isNonEmptyString(edge.extractor)) errors.push("edge.extractor is required");
  if (!isNonEmptyString(edge.extractorVersion)) errors.push("edge.extractorVersion is required");

  // Rule 1: no edge without evidence carrying file and lineStart.
  errors.push(...validateEvidence(edge.evidence, { required: true }).map((e) => `edge.${e}`));

  if (!isNonEmptyString(edge.observedInRev)) errors.push("edge.observedInRev is required");
  if (!isNonEmptyString(edge.firstSeenRev)) errors.push("edge.firstSeenRev is required");
  if (!isNonEmptyString(edge.lastSeenRev)) errors.push("edge.lastSeenRev is required");

  // Rule 3 + B10: an edge produced by a binding_rule is always INFERRED.
  if (edge.ruleId !== undefined && edge.nature !== "INFERRED") {
    errors.push("edge.ruleId requires nature INFERRED");
  }
  return errors;
}

export function assertValidNode(node) {
  const errors = validateNode(node);
  if (errors.length > 0) {
    throw new TypeError(`invalid node ${node && node.id ? node.id : "<anonymous>"}: ${errors.join("; ")}`);
  }
  return node;
}

export function assertValidEdge(edge) {
  const errors = validateEdge(edge);
  if (errors.length > 0) {
    throw new TypeError(`invalid edge ${edge && edge.id ? edge.id : "<anonymous>"}: ${errors.join("; ")}`);
  }
  return edge;
}

/** Validate a whole graph; returns every violation instead of stopping at one. */
export function validateGraph({ nodes = [], edges = [] } = {}) {
  const errors = [];
  const ids = new Set();
  for (const node of nodes) {
    errors.push(...validateNode(node).map((e) => `node ${node && node.id}: ${e}`));
    if (node && node.id) {
      if (ids.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
      ids.add(node.id);
    }
  }
  const edgeIds = new Set();
  for (const edge of edges) {
    errors.push(...validateEdge(edge).map((e) => `edge ${edge && edge.id}: ${e}`));
    if (edge && edge.id) {
      if (edgeIds.has(edge.id)) errors.push(`duplicate edge id: ${edge.id}`);
      edgeIds.add(edge.id);
    }
  }
  return { ok: errors.length === 0, errors };
}
