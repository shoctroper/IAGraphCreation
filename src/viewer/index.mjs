// Viewer slice (spine step 8, docs/API.md `src/viewer`).
//
// renderViewer(workspace, { focus?, out }) -> ruta del HTML
//
// Compiles the graph into ONE self-contained HTML file: graph data embedded as
// JSON (never a server query), zero network references at runtime, openable
// from file://. The viewer is derived from the SAME SQLite store the AI context
// derives from (rule 4: one source of truth, no two graphs that can diverge).
//
// The page implements the eight mandatory interactions (docs/API.md Visor):
// SEARCH, FILTER, FOCUS, EXPAND, COLLAPSE, UPSTREAM, DOWNSTREAM and DETAILS,
// distinguishing EXTRACTED evidence (read literally in the source) from
// INFERRED (derived from a rule or resolution) and citing file + lineStart in
// every node detail.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DEFAULT_OUT = (workspace) => join(workspace.dir ?? ".", ".iagraph", "viewer.html");

/**
 * Compile the graph into a standalone HTML file.
 *
 * @param {object} workspace  a Workspace whose `store` is the single source of
 *   truth (rule 4). Nodes and edges are read straight from that store.
 * @param {{ focus?: string, out?: string }} [opts] `focus` is a node id or
 *   qualified name to open focused; `out` is the target path (defaults to
 *   `<dir>/.iagraph/viewer.html`).
 * @returns {Promise<string>} the absolute path of the written HTML file.
 */
export async function renderViewer(workspace, { focus, out } = {}) {
  const store = workspace?.store;
  if (!store) {
    throw new TypeError(
      "renderViewer: workspace.store is required (rule 4: the viewer derives from the same SQLite store)",
    );
  }
  const nodes = store.findNodes({});
  const edges = store.getEdges({});

  // Embed the graph as JSON. `<` is escaped so no value can ever close the
  // script tag and smuggle markup into the page (the whole point of a
  // file://-openable, network-free artifact).
  const data = JSON.stringify({
    nodes,
    edges,
    focus: typeof focus === "string" && focus.length > 0 ? focus : null,
    revision: store.lastRevision() ?? null,
  }).replace(/</g, "\\u003c");

  const target = resolve(out ?? DEFAULT_OUT(workspace));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, shell(data), "utf8");
  return target;
}

function shell(data) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>IAGraph — self-contained viewer</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, sans-serif; }
header { padding: 0.75rem 1rem; border-bottom: 1px solid #8884; }
h1 { font-size: 1.1rem; margin: 0 0 0.25rem; }
p.meta { margin: 0; font-size: 0.8rem; color: #888; }
.toolbar { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 0.5rem; }
.toolbar label { display: flex; align-items: center; gap: 0.25rem; font-size: 0.85rem; }
input, select, button { font: inherit; padding: 0.25rem 0.4rem; }
.status { padding: 0.4rem 1rem; font-size: 0.85rem; color: #888; }
main { padding: 0.5rem 1rem; }
#legend { font-size: 0.8rem; color: #888; margin-bottom: 0.5rem; }
#legend .ex { color: #2e7d32; font-weight: 600; }
#legend .inf { color: #b26a00; font-weight: 600; }
#legend .amb { color: #c62828; font-weight: 600; }
ul#nodes { list-style: none; margin: 0; padding: 0; }
#nodes li { padding: 0.35rem 0.5rem; border-bottom: 1px solid #8882; cursor: pointer; }
#nodes li.focused { background: #42a5f51f; outline: 1px solid #42a5f5aa; }
#nodes li .kind { font-size: 0.75rem; color: #888; }
#nodes li .loc { font-size: 0.8rem; color: #666; margin-left: 0.4rem; }
#nodes li .rel { display: block; font-size: 0.8rem; color: #777; margin-top: 0.15rem; }
#panel { position: fixed; top: 0; right: 0; width: min(560px, 90vw); height: 100vh; overflow: auto; background: #1e1e1e; color: #ddd; padding: 1rem; border-left: 1px solid #8886; }
#panel h2 { margin: 0 0 0.5rem; font-size: 1rem; }
#panel pre { white-space: pre-wrap; font-size: 0.8rem; }
footer { padding: 0.5rem 1rem; font-size: 0.75rem; color: #888; }
</style>
</head>
<body>
<header>
  <h1>IAGraph viewer</h1>
  <p class="meta">graph data embedded from the same SQLite store (rule 4) — no server, no network</p>
</header>
<section class="toolbar">
  <label>search <input id="search" type="search" placeholder="type to search…"></label>
  <label>filter
    <select id="filter"><option value="">all kinds</option></select>
  </label>
  <label>focus <input id="focus" placeholder="node id or name…"></label>
  <button id="focusBtn">focus</button>
  <button id="expand">expand</button>
  <button id="collapse">collapse</button>
  <button id="upstream">upstream</button>
  <button id="downstream">downstream</button>
  <button id="details">details</button>
</section>
<section class="status"><span id="count"></span><span id="mode"></span></section>
<main>
  <section id="legend">
    <span class="ex">■ EXTRACTED</span> read literally in the source&nbsp;·&nbsp;
    <span class="inf">◇ INFERRED</span> derived from a rule or resolution&nbsp;·&nbsp;
    <span class="amb">△ AMBIGUOUS</span> unresolved
  </section>
  <ul id="nodes"></ul>
</main>
<aside id="panel" hidden>
  <h2>details</h2>
  <button id="closePanel">close</button>
  <pre id="panelBody"></pre>
</aside>
<footer>iagraph viewer — single file, works from file://</footer>
<script>
"use strict";
var GRAPH = ${data};

var nodesById = {};
GRAPH.nodes.forEach(function (n) { nodesById[n.id] = n; });

var outgoing = {};
var incoming = {};
GRAPH.edges.forEach(function (e) {
  (outgoing[e.src] || (outgoing[e.src] = [])).push(e);
  (incoming[e.dst] || (incoming[e.dst] = [])).push(e);
});

var kinds = [];
GRAPH.nodes.forEach(function (n) { if (kinds.indexOf(n.kind) < 0) kinds.push(n.kind); });
kinds.sort();

var state = { mode: "all", focused: null, selected: null, query: "", kind: "" };

function matchesQuery(n, q) {
  if (!q) return true;
  q = q.toLowerCase();
  return [n.name, n.qualifiedName, n.id, n.route, n.file]
    .some(function (v) { return v && String(v).toLowerCase().indexOf(q) >= 0; });
}

function neighbors(id, direction) {
  var ids = {};
  var lists = [];
  if (direction === 1 || direction === 0) lists.push(incoming[id] || []);
  if (direction === 2 || direction === 0) lists.push(outgoing[id] || []);
  lists.forEach(function (list) {
    list.forEach(function (e) {
      var other = (e.src === id) ? e.dst : e.src;
      if (other !== id) ids[other] = true;
    });
  });
  return Object.keys(ids);
}

function visibleNodes() {
  var f = state.focused;
  var ids = [];
  if (state.mode === "expand" && f) {
    ids = [f].concat(neighbors(f, 0));
  } else if (state.mode === "upstream" && f) {
    ids = [f].concat(neighbors(f, 1));
  } else if (state.mode === "downstream" && f) {
    ids = [f].concat(neighbors(f, 2));
  } else if (state.mode === "collapse" && f) {
    ids = [f];
  } else {
    ids = GRAPH.nodes.map(function (n) { return n.id; });
  }
  var set = {};
  ids.forEach(function (id) { set[id] = true; });
  return GRAPH.nodes.filter(function (n) {
    if (!set[n.id]) return false;
    if (state.kind && n.kind !== state.kind) return false;
    return matchesQuery(n, state.query);
  }).sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
}

function edgeLabel(e) {
  return e.kind + " (" + (e.nature || "?") + ")";
}

function nodeName(id) {
  var n = nodesById[id];
  return n ? n.name : id;
}

function render() {
  var nodes = visibleNodes();
  var list = document.getElementById("nodes");
  list.textContent = "";
  nodes.forEach(function (n) {
    var li = document.createElement("li");
    li.className = "node " + n.kind + (n.id === state.focused ? " focused" : "");
    var name = document.createElement("strong");
    name.textContent = n.name || n.id;
    var tag = document.createElement("span");
    tag.className = "kind";
    tag.textContent = " " + n.kind;
    li.appendChild(name);
    li.appendChild(tag);
    var loc = document.createElement("span");
    loc.className = "loc";
    if (n.file) {
      loc.textContent = " " + n.file + (n.lineStart ? ":" + n.lineStart : "");
    } else if (n.route) {
      loc.textContent = " " + (n.method || "") + " " + n.route;
    }
    li.appendChild(loc);
    var rel = document.createElement("span");
    rel.className = "rel";
    var parts = [];
    (incoming[n.id] || []).forEach(function (e) {
      parts.push("upstream " + nodeName(e.src) + " [" + edgeLabel(e) + "]");
    });
    (outgoing[n.id] || []).forEach(function (e) {
      parts.push("downstream " + nodeName(e.dst) + " [" + edgeLabel(e) + "]");
    });
    rel.textContent = parts.join("  ·  ");
    li.appendChild(rel);
    li.addEventListener("click", function () { select(n.id); });
    list.appendChild(li);
  });
  document.getElementById("count").textContent =
    nodes.length + " of " + GRAPH.nodes.length + " nodes · " + GRAPH.edges.length + " edges" +
    (GRAPH.revision ? " · revision " + GRAPH.revision : "");
  document.getElementById("mode").textContent =
    "  ·  mode " + state.mode + (state.focused ? " · focus " + nodeName(state.focused) : "");
}

function showDetails(id) {
  var n = nodesById[id];
  if (!n) return;
  var lines = [];
  lines.push("id: " + n.id);
  lines.push("kind: " + n.kind);
  lines.push("name: " + n.name);
  lines.push("qualifiedName: " + n.qualifiedName);
  if (n.file) lines.push("file: " + n.file);
  if (n.lineStart) lines.push("lineStart: " + n.lineStart);
  if (n.lineEnd) lines.push("lineEnd: " + n.lineEnd);
  if (n.route) lines.push("route: " + n.route);
  if (n.method) lines.push("method: " + n.method);
  if (n.scope) lines.push("scope: " + n.scope);
  if (n.firstSeenRev) lines.push("firstSeenRev: " + n.firstSeenRev);
  if (n.lastSeenRev) lines.push("lastSeenRev: " + n.lastSeenRev);
  lines.push("evidence: " + JSON.stringify(n.evidence || []));
  lines.push("incoming (" + (incoming[id] || []).length + "):");
  (incoming[id] || []).forEach(function (e) {
    var ev = e.evidence || {};
    lines.push("  " + nodeName(e.src) + " --[" + e.kind + " " + e.nature + "]--> " + nodeName(e.dst) + "  @ " + (ev.file || "?") + ":" + (ev.lineStart || "?"));
  });
  lines.push("outgoing (" + (outgoing[id] || []).length + "):");
  (outgoing[id] || []).forEach(function (e) {
    var ev = e.evidence || {};
    lines.push("  " + nodeName(e.src) + " --[" + e.kind + " " + e.nature + "]--> " + nodeName(e.dst) + "  @ " + (ev.file || "?") + ":" + (ev.lineStart || "?"));
  });
  document.getElementById("panelBody").textContent = lines.join("\\n");
  document.getElementById("panel").hidden = false;
}

function select(id) {
  state.focused = id;
  state.selected = id;
  showDetails(id);
  render();
}

function focusByIdentifier(ident) {
  ident = String(ident || "").trim();
  if (!ident) return;
  var hit = nodesById[ident];
  if (!hit) {
    var found = GRAPH.nodes.filter(function (n) {
      return n.qualifiedName === ident || n.name === ident;
    });
    if (found.length) hit = found[0];
  }
  if (hit) {
    state.focused = hit.id;
    state.selected = hit.id;
    render();
  }
}

function applyFocusFromEmbedded() {
  var value = GRAPH.focus;
  if (!value) return;
  var hit = nodesById[value];
  if (!hit) {
    var found = GRAPH.nodes.filter(function (n) {
      return n.qualifiedName === value || n.name === value;
    });
    if (found.length) hit = found[0];
  }
  if (hit) {
    state.focused = hit.id;
    state.selected = hit.id;
  }
}

document.getElementById("search").addEventListener("input", function (e) {
  state.query = e.target.value;
  render();
});
document.getElementById("filter").addEventListener("change", function (e) {
  state.kind = e.target.value;
  render();
});
document.getElementById("focusBtn").addEventListener("click", function () {
  focusByIdentifier(document.getElementById("focus").value);
});
document.getElementById("focus").addEventListener("keydown", function (e) {
  if (e.key === "Enter") focusByIdentifier(e.target.value);
});
document.getElementById("expand").addEventListener("click", function () {
  state.mode = "expand";
  render();
});
document.getElementById("collapse").addEventListener("click", function () {
  state.mode = "collapse";
  render();
});
document.getElementById("upstream").addEventListener("click", function () {
  state.mode = "upstream";
  render();
});
document.getElementById("downstream").addEventListener("click", function () {
  state.mode = "downstream";
  render();
});
document.getElementById("details").addEventListener("click", function () {
  if (state.focused) showDetails(state.focused);
});
document.getElementById("closePanel").addEventListener("click", function () {
  document.getElementById("panel").hidden = true;
});

(function init() {
  var sel = document.getElementById("filter");
  kinds.forEach(function (k) {
    var o = document.createElement("option");
    o.value = k;
    o.textContent = k;
    sel.appendChild(o);
  });
  applyFocusFromEmbedded();
  render();
})();
</script>
</body>
</html>
`;
}