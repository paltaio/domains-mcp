import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { searchIwantmyname, searchIwantmynameBulk } from "./providers/iwantmyname.js";
import { searchPorkbun, searchPorkbunBulk } from "./providers/porkbun.js";
import type {
  DomainResult,
  ProviderSearchResult,
} from "./providers/types.js";

const config = loadConfig();

function formatDomain(d: DomainResult): string {
  const status = d.available ? "AVAILABLE" : "taken";
  const price = d.price
    ? `$${d.price.registration}` +
      (d.price.renewal !== d.price.registration
        ? ` (renews $${d.price.renewal})`
        : "")
    : "no price";
  const premium = d.premium ? " [premium]" : "";
  return `- **${d.domain}** — ${status} — ${price}${premium}`;
}

function formatResults(results: ProviderSearchResult[]): string {
  const sections: string[] = [];
  for (const r of results) {
    if (r.error) {
      sections.push(`### ${r.provider}\n\nError: ${r.error}`);
      continue;
    }
    const available = r.results.filter((d) => d.available);
    const taken = r.results.filter((d) => !d.available);
    const lines: string[] = [`### ${r.provider}`];
    if (available.length > 0) {
      lines.push("", "**Available:**", ...available.map(formatDomain));
    }
    if (taken.length > 0) {
      lines.push("", "**Taken:**", ...taken.map(formatDomain));
    }
    if (r.results.length === 0) {
      lines.push("", "No results.");
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

function filterExact(
  results: ProviderSearchResult[],
  query: string,
): ProviderSearchResult[] {
  const target = query.trim().toLowerCase();
  return results.map((r) => ({
    ...r,
    results: r.results.filter((d) => d.domain.toLowerCase() === target),
  }));
}

function filterDomains(
  results: ProviderSearchResult[],
  domains: string[],
): ProviderSearchResult[] {
  const targets = new Set(domains.map((d) => d.trim().toLowerCase()));
  return results.map((r) => ({
    ...r,
    results: r.results.filter((d) => targets.has(d.domain.toLowerCase())),
  }));
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "domains-mcp",
    version: "1.0.0",
  });

  const querySchema = {
    query: z
      .string()
      .describe("Domain name to search, e.g. 'example.ai'"),
    exact: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only return the exact domain queried, no suggestions"),
    json: z
      .boolean()
      .optional()
      .default(false)
      .describe("Return raw JSON instead of formatted Markdown"),
  };

  server.registerTool(
    "search_iwantmyname",
    {
      description:
        "Search domain availability and pricing via iwantmyname",
      inputSchema: querySchema,
    },
    async ({ query, exact, json }) => {
      const result = await searchIwantmyname(query);
      const filtered = exact ? filterExact([result], query) : [result];
      const text = json
        ? JSON.stringify(filtered, null, 2)
        : formatResults(filtered);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.registerTool(
    "search_porkbun",
    {
      description: "Search domain availability and pricing via Porkbun",
      inputSchema: querySchema,
    },
    async ({ query, exact, json }) => {
      const result = await searchPorkbun(query);
      const filtered = exact ? filterExact([result], query) : [result];
      const text = json
        ? JSON.stringify(filtered, null, 2)
        : formatResults(filtered);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.registerTool(
    "search_domains",
    {
      description:
        "Search domain availability and pricing across all providers (iwantmyname + Porkbun) in parallel",
      inputSchema: querySchema,
    },
    async ({ query, exact, json }) => {
      const searches: Promise<ProviderSearchResult>[] = [
        searchIwantmyname(query),
        searchPorkbun(query),
      ];
      const results = await Promise.all(searches);
      const filtered = exact ? filterExact(results, query) : results;
      const text = json
        ? JSON.stringify(filtered, null, 2)
        : formatResults(filtered);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  const bulkSchema = {
    domains: z
      .array(z.string())
      .describe("List of full domain names, e.g. ['source.ai', 'test.dev']"),
    json: z
      .boolean()
      .optional()
      .default(false)
      .describe("Return raw JSON instead of formatted Markdown"),
  };

  server.registerTool(
    "bulk_search_porkbun",
    {
      description:
        "Check availability and pricing for multiple exact domains via Porkbun",
      inputSchema: bulkSchema,
    },
    async ({ domains, json }) => {
      const result = await searchPorkbunBulk(domains);
      const filtered = filterDomains([result], domains);
      const text = json
        ? JSON.stringify(filtered, null, 2)
        : formatResults(filtered);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.registerTool(
    "bulk_search_iwantmyname",
    {
      description:
        "Check availability and pricing for multiple exact domains via iwantmyname",
      inputSchema: bulkSchema,
    },
    async ({ domains, json }) => {
      const result = await searchIwantmynameBulk(domains);
      const filtered = filterDomains([result], domains);
      const text = json
        ? JSON.stringify(filtered, null, 2)
        : formatResults(filtered);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.registerTool(
    "bulk_search_domains",
    {
      description:
        "Check availability and pricing for multiple exact domains across all providers in parallel",
      inputSchema: bulkSchema,
    },
    async ({ domains, json }) => {
      const results = await Promise.all([
        searchIwantmynameBulk(domains),
        searchPorkbunBulk(domains),
      ]);
      const filtered = filterDomains(results, domains);
      const text = json
        ? JSON.stringify(filtered, null, 2)
        : formatResults(filtered);
      return { content: [{ type: "text" as const, text }] };
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
  console.log(`domains-mcp listening on port ${config.port}`);
  console.log("Providers: iwantmyname, Porkbun");
});
