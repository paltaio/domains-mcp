import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { searchIwantmyname, searchIwantmynameBulk } from "./providers/iwantmyname.js";
import { searchNicChile, searchNicChileBulk } from "./providers/nicchile.js";
import { searchPorkbun, searchPorkbunBulk } from "./providers/porkbun.js";
import type {
  DomainResult,
  ProviderSearchResult,
} from "./providers/types.js";

const config = loadConfig();

function formatDomain(d: DomainResult): string {
  const status = d.status === "pending_deletion"
    ? "PENDING DELETION"
    : d.available ? "AVAILABLE" : "taken";
  const price = d.price
    ? `$${d.price.registration}` +
      (d.price.renewal !== d.price.registration
        ? ` (renews $${d.price.renewal})`
        : "")
    : "no price";
  const premium = d.premium ? " [premium]" : "";
  let line = `- **${d.domain}** — ${status} — ${price}${premium}`;

  if (d.whois) {
    const w = d.whois;
    const fields: string[] = [];
    if (w.registrant) fields.push(`  Registrant: ${w.registrant}`);
    if (w.organization) fields.push(`  Organization: ${w.organization}`);
    if (w.registrar) fields.push(`  Registrar: ${w.registrar}`);
    if (w.creationDate) fields.push(`  Created: ${w.creationDate}`);
    if (w.expirationDate) fields.push(`  Expires: ${w.expirationDate}`);
    if (w.lastModified) fields.push(`  Modified: ${w.lastModified}`);
    if (w.nameservers.length > 0)
      fields.push(`  Nameservers: ${w.nameservers.join(", ")}`);
    if (w.website) fields.push(`  Website: ${w.website}`);
    if (fields.length > 0) line += "\n" + fields.join("\n");
  }

  return line;
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

  const nicChileQuerySchema = {
    query: z
      .string()
      .describe("Domain name to search, e.g. 'example.cl' (.cl will be appended if missing)"),
    whois: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include WHOIS data (registrant, dates, nameservers) for taken domains"),
    json: z
      .boolean()
      .optional()
      .default(false)
      .describe("Return raw JSON instead of formatted Markdown"),
  };

  server.registerTool(
    "search_nicchile",
    {
      description:
        "Search .cl domain availability and WHOIS via NIC Chile (the official .cl registry)",
      inputSchema: nicChileQuerySchema,
    },
    async ({ query, whois, json }) => {
      const result = await searchNicChile(query, whois);
      const text = json
        ? JSON.stringify([result], null, 2)
        : formatResults([result]);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  const combinedQuerySchema = {
    query: z
      .string()
      .describe("Domain name to search, e.g. 'example.ai'"),
    exact: z
      .boolean()
      .optional()
      .default(false)
      .describe("Only return the exact domain queried, no suggestions"),
    whois: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include WHOIS data from NIC Chile for taken .cl domains"),
    json: z
      .boolean()
      .optional()
      .default(false)
      .describe("Return raw JSON instead of formatted Markdown"),
  };

  server.registerTool(
    "search_domains",
    {
      description:
        "Search domain availability and pricing across all providers (iwantmyname + Porkbun + NIC Chile) in parallel",
      inputSchema: combinedQuerySchema,
    },
    async ({ query, exact, whois, json }) => {
      const searches: Promise<ProviderSearchResult>[] = [
        searchIwantmyname(query),
        searchPorkbun(query),
        searchNicChile(query, whois),
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

  const nicChileBulkSchema = {
    domains: z
      .array(z.string())
      .describe("List of .cl domain names, e.g. ['example.cl', 'test.cl']"),
    whois: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include WHOIS data for taken domains"),
    json: z
      .boolean()
      .optional()
      .default(false)
      .describe("Return raw JSON instead of formatted Markdown"),
  };

  server.registerTool(
    "bulk_search_nicchile",
    {
      description:
        "Check .cl domain availability and WHOIS for multiple domains via NIC Chile",
      inputSchema: nicChileBulkSchema,
    },
    async ({ domains, whois, json }) => {
      const result = await searchNicChileBulk(domains, whois);
      const text = json
        ? JSON.stringify([result], null, 2)
        : formatResults([result]);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  const combinedBulkSchema = {
    domains: z
      .array(z.string())
      .describe("List of full domain names, e.g. ['source.ai', 'test.dev']"),
    whois: z
      .boolean()
      .optional()
      .default(false)
      .describe("Include WHOIS data from NIC Chile for taken .cl domains"),
    json: z
      .boolean()
      .optional()
      .default(false)
      .describe("Return raw JSON instead of formatted Markdown"),
  };

  server.registerTool(
    "bulk_search_domains",
    {
      description:
        "Check availability and pricing for multiple exact domains across all providers (iwantmyname + Porkbun + NIC Chile) in parallel",
      inputSchema: combinedBulkSchema,
    },
    async ({ domains, whois, json }) => {
      const results = await Promise.all([
        searchIwantmynameBulk(domains),
        searchPorkbunBulk(domains),
        searchNicChileBulk(domains, whois),
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
  console.log("Providers: iwantmyname, Porkbun, NIC Chile");
});
