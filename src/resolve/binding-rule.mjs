// Binding-rule resolution (spine step 4, docs/API.md "binding_rule").
//
// An assembly-scanning DI registration (`AddHandlersFromAssembly`,
// `RegisterServicesFromAssembly`, `AddMaps(Assembly…)`) is not a fact anchored
// to a single pair of types: it is a RULE with a DOMAIN. Adding a handler does
// not change the file that declares the scan, so a fact-anchored edge would
// never be invalidated and the handler would disappear silently.
//
// The resolve pass turns each scan-registration observation surfaced by the
// analyzers into ONE `binding_rule` node carrying:
//   - a truthy `scope` (the scanned assembly/project domain, resolved from the
//     literal type reference of the call);
//   - `name` and a stable qualified name;
//   - evidence {file, lineStart, rev} citing the exact scan call line.
//
// The node is evidence-bearing and marked EXTRACTED only for the literal scan
// call text (rule 3). No derived binds_implementation edges are invented here:
// those belong to the incremental/ruleId work and would be born INFERRED with
// the rule's id (B10).
import { createNode } from "../model/index.mjs";

export const RESOLVER = "resolve";
export const RESOLVER_VERSION = "0.1.0";

/**
 * Deduplicate rule nodes by id, keeping the evidence of every literal call
 * site. Two scan registrations that resolve to the same `assembly:method`
 * (e.g. `AddHandlersFromAssembly` called for the same assembly from two files)
 * are ONE rule, exactly as a partial class is ONE node (docs/API.md rule 6;
 * acceptance B6). Like `mergeNodes`, the primary location is the first
 * fragment's, and only the evidence list grows.
 */
function mergeRuleNodes(nodes) {
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

/**
 * Derive binding_rule nodes from scan-registration observations.
 *
 * @param {{ observations: object[], rev: string }} opts `observations` are the
 *   `scan_registration` records surfaced by the analyzers (call + resolved
 *   assembly + evidence location).
 * @returns {{ nodes: object[], edges: object[] }}
 */
export function resolveBindingRules({ observations = [], rev } = {}) {
  const nodes = [];
  const edges = [];
  for (const obs of observations) {
    if (obs.kind !== "scan_registration") continue;
    if (typeof obs.assembly !== "string" || obs.assembly.length === 0) continue;
    if (typeof obs.method !== "string" || obs.method.length === 0) continue;
    if (typeof obs.file !== "string" || obs.file.length === 0) continue;
    if (!Number.isInteger(obs.lineStart) || obs.lineStart < 1) continue;

    const qualifiedName = `${obs.assembly}:${obs.method}`;
    nodes.push(
      createNode({
        kind: "binding_rule",
        name: obs.method,
        qualifiedName,
        scope: obs.assembly,
        file: obs.file,
        lineStart: obs.lineStart,
        rev: obs.rev ?? rev,
        metadata: { method: obs.method, call: obs.call ?? null },
      }),
    );
  }
  return { nodes: mergeRuleNodes(nodes), edges };
}