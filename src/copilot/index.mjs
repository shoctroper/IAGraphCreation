// Copilot slice (spine step 9, docs/API.md `src/copilot`): instrucciones por
// ruta y servidor MCP.
//
// generateCopilotContext(workspace, { out }) -> [rutas escritas]
// startMcpServer(workspace, opts)            -> { close() }
export { generateCopilotContext, renderGraphContext, renderRouteContext } from "./context.mjs";
export { startMcpServer } from "./mcp.mjs";