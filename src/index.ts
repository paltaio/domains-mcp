import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { searchIwantmyname } from "./providers/iwantmyname.js";
import { searchPorkbun } from "./providers/porkbun.js";
import type { ProviderSearchResult } from "./providers/types.js";

const config = loadConfig();

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "domain-mcp",
    version: "1.0.0",
  });

  const querySchema = {
    query: z
      .string()
      .describe("Domain name to search, e.g. 'example.ai'"),
  };

  server.registerTool(
    "search_iwantmyname",
    {
      description:
        "Search domain availability and pricing via iwantmyname",
      inputSchema: querySchema,
    },
    async ({ query }) => {
      const result = await searchIwantmyname(query);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "search_porkbun",
    {
      description: "Search domain availability and pricing via Porkbun",
      inputSchema: querySchema,
    },
    async ({ query }) => {
      const result = await searchPorkbun(query);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "search_domains",
    {
      description:
        "Search domain availability and pricing across all providers (iwantmyname + Porkbun) in parallel",
      inputSchema: querySchema,
    },
    async ({ query }) => {
      const searches: Promise<ProviderSearchResult>[] = [
        searchIwantmyname(query),
        searchPorkbun(query),
      ];
      const results = await Promise.all(searches);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(results, null, 2) },
        ],
      };
    },
  );

  return server;
}

async function parseBody(
  req: import("node:http").IncomingMessage,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const httpServer = createServer(async (req, res) => {
  if (req.method === "POST") {
    try {
      const body = await parseBody(req);
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
            id: null,
          }),
        );
      }
    }
  } else if (req.method === "DELETE") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed. Use POST for MCP requests.",
        },
        id: null,
      }),
    );
  }
});

httpServer.listen(config.port, () => {
  console.log(`domain-mcp listening on port ${config.port}`);
  console.log("Providers: iwantmyname, Porkbun");
});
