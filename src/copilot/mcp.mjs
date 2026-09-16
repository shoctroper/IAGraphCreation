// MCP server slice (spine step 9, docs/API.md `src/copilot`).
//
// startMcpServer(workspace, opts) -> { close() }
//
// A minimal Model Context Protocol (MCP) server exposing the graph as tools.
// Every tool reads from the SAME SQLite store the viewer and the Copilot
// context derive from (rule 4): the server never invents nodes or edges and
// every response carries the evidence location {file, lineStart} (rule 1).
//
// Transport:
//   - "stdio"    standard MCP: NDJSON request/response on stdin/stdout.
//   - "inmemory" programmatic: the returned object exposes `request(method,
//     params)`, `notify(method, params)` and `handle(message)` in addition to
//     the contract's `close()`, so a caller can query the graph directly.
//
// The dispatch is lenient on purpose (the graph query is the contract, not the
// wire spelling): `tools/call` accepts the tool name in `params.name` or
// `params.tool`, arguments in `params.arguments`/`params.params`/`params.input`,
// and a bare JSON-RPC method equal to a tool name is treated as a tool call.

import { createInterface } from "node:readline";
import { search, explain, path, impact } from "../query/index.mjs";
import { renderGraphContext } from "./context.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "iagraph";
const SERVER_VERSION = "0.1.0";

const TOOLS = {
  search: {
    def: {
      name: "search",
      description:
        "Search the code graph: nodes in the store whose name, qualifiedName, route or file match the query, with score and evidence location.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
          kind: { type: "string" },
        },
        required: ["query"],
      },
    },
    run: async (ws, args) =>
      search(ws, args?.query ?? args?.q, { limit: args?.limit, kind: args?.kind }),
  },
  explain: {
    def: {
      name: "explain",
      description:
        "Explain a node: its evidence, incoming and outgoing edges, and the current store revision.",
      inputSchema: {
        type: "object",
        properties: { nodeId: { type: "string" } },
        required: ["nodeId"],
      },
    },
    run: async (ws, args) => explain(ws, args?.nodeId ?? args?.id ?? args?.node),
  },
  path: {
    def: {
      name: "path",
      description:
        "Find a path between two nodes through the edges stored in the graph; every hop cites its evidence.",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
        },
        required: ["from", "to"],
      },
    },
    run: async (ws, args) =>
      path(ws, args?.from ?? args?.fromId, args?.to ?? args?.toId),
  },
  impact: {
    def: {
      name: "impact",
      description:
        "Compute the impact area of a change target (a file, node id, kind, or orphan query) over the stored nodes and edges.",
      inputSchema: {
        type: "object",
        properties: { target: {} },
        required: ["target"],
      },
    },
    run: async (ws, args) => impact(ws, args?.target),
  },
  graph_context: {
    def: {
      name: "graph_context",
      description:
        "Render the whole revision-aware graph as a compact, evidence-bearing context string.",
      inputSchema: { type: "object", properties: {} },
    },
    run: async (ws) => renderGraphContext(ws.store),
  },
};

// Aliases so a caller can reach the same graph query under several spellings;
// the canonical names are what `tools/list` reports.
const ALIASES = {
  query: "search",
  graph_search: "search",
  find: "search",
  graph_explain: "explain",
  graph_path: "path",
  graph_impact: "impact",
  context: "graph_context",
  graph: "graph_context",
  graph_context: "graph_context",
};

const TOOL_DEFS = Object.values(TOOLS).map((t) => t.def);

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function fail(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Start the MCP server for a workspace.
 *
 * @param {object} workspace a Workspace whose `store` is the single source of
 *   truth (rule 4).
 * @param {{ transport?: "stdio" | "inmemory" }} [opts]
 * @returns {Promise<object>} an object with `close()` (the frozen contract);
 *   for "inmemory" it also exposes `request(method, params)`,
 *   `notify(method, params)`, `handle(message)` and the tools as direct
 *   methods (`search`, `explain`, `path`, `impact`, `graphContext`).
 */
export async function startMcpServer(workspace, { transport = "stdio" } = {}) {
  const store = workspace?.store;
  if (!store) {
    throw new TypeError(
      "startMcpServer: workspace.store is required (rule 4: the server reads from the same SQLite store)",
    );
  }

  let idSeq = 0;

  async function callTool(name, args) {
    const canonical = ALIASES[name] ?? name;
    const tool = TOOLS[canonical];
    if (!tool) {
      const err = new Error(`unknown tool: ${name}`);
      err.code = -32602;
      throw err;
    }
    return tool.run(workspace, args ?? {});
  }

  async function dispatch(msg) {
    if (!msg || typeof msg !== "object") {
      return fail(null, -32600, "Invalid Request: expected a JSON-RPC message object");
    }
    const { id, method, params } = msg;

    // Notifications (no id) never get a response.
    if (id === undefined || id === null) {
      return null;
    }
    if (typeof method !== "string" || method.length === 0) {
      return fail(id, -32600, "Invalid Request: method is required");
    }

    try {
      switch (method) {
        case "initialize":
          return ok(id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          });
        case "ping":
          return ok(id, {});
        case "tools/list":
          return ok(id, { tools: TOOL_DEFS });
        case "tools/call": {
          const args =
            params?.arguments ?? params?.params ?? params?.input ?? {};
          const output = await callTool(params?.name ?? params?.tool, args);
          const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
          return ok(id, { content: [{ type: "text", text }], isError: false });
        }
        default: {
          // A bare method equal to a tool name is a graph query.
          const canonical = ALIASES[method] ?? method;
          if (TOOLS[canonical]) {
            const output = await callTool(method, params ?? {});
            const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
            return ok(id, { content: [{ type: "text", text }], isError: false });
          }
          return fail(id, -32601, `Method not found: ${method}`);
        }
      }
    } catch (err) {
      const code = err?.code ?? -32603;
      const message = err?.code ? err.message : `Internal error: ${err?.message ?? String(err)}`;
      return fail(id, code, message);
    }
  }

  const server = {
    transport,
    closed: false,
    async request(method, params) {
      if (server.closed) throw new Error("startMcpServer: server is closed");
      // Allow request({ jsonrpc, id, method, params }) and request(message)
      // as well as the positional request(method, params) form.
      const msg =
        typeof method === "object" && method !== null
          ? { ...method, id: method.id ?? ++idSeq }
          : { jsonrpc: "2.0", id: ++idSeq, method, params };
      const res = await dispatch(msg);
      if (res?.error) {
        const err = new Error(res.error.message);
        err.code = res.error.code;
        throw err;
      }
      return res?.result;
    },
    async notify(method, params) {
      if (server.closed) throw new Error("startMcpServer: server is closed");
      await dispatch(
        typeof method === "object" && method !== null ? method : { jsonrpc: "2.0", method, params },
      );
    },
    async handle(message, params) {
      if (server.closed) throw new Error("startMcpServer: server is closed");
      const msg =
        typeof message === "string"
          ? { jsonrpc: "2.0", id: ++idSeq, method: message, params }
          : message;
      return dispatch(msg);
    },
    close() {
      if (server.closed) return;
      server.closed = true;
      if (server._rl) {
        server._rl.close();
        server._rl.removeAllListeners("line");
      }
    },
  };

  // Direct tool methods so a graph query is reachable without the wire shape:
  // srv.listTools(), srv.callTool(name, args), srv.search(query, opts),
  // srv.explain(nodeId), srv.path(from, to), srv.impact(target),
  // srv.graphContext().
  server.listTools = async () => TOOL_DEFS.map((t) => ({ ...t }));
  server.callTool = async (name, args) => {
    const output = await callTool(name, args);
    const text = typeof output === "string" ? output : JSON.stringify(output, null, 2);
    return { content: [{ type: "text", text }], isError: false };
  };
  server.call = async (name, args) => {
    const output = await callTool(name, args);
    return { results: output };
  };
  server.search = async (query, opts) => search(workspace, query, opts);
  server.explain = async (nodeId) => explain(workspace, nodeId);
  server.path = async (from, to) => path(workspace, from, to);
  server.impact = async (target) => impact(workspace, target);
  server.graphContext = async () => renderGraphContext(store);

  if (transport === "stdio") {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const res = await dispatch(msg);
      if (res) process.stdout.write(JSON.stringify(res) + "\n");
    });
    server._rl = rl;
  } else if (transport !== "inmemory") {
    throw new TypeError(`startMcpServer: unknown transport "${transport}"`);
  }

  return server;
}