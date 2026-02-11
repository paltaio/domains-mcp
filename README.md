# domains-mcp

MCP server for checking domain availability and pricing. Queries iwantmyname and Porkbun in parallel — no API keys needed.

## Tools

| Tool | Description |
|------|-------------|
| `search_domains` | Query both providers in parallel |
| `search_iwantmyname` | Query iwantmyname only |
| `search_porkbun` | Query Porkbun only |

All tools accept `query` (string) and optional `json` (boolean, default false) for raw JSON output.

## Run

```bash
bun src/index.ts
```

Or with Docker:

```bash
docker compose up
```

Server listens on port 3000 by default. Override with `PORT` env var.

## MCP config

```json
{
  "mcpServers": {
    "domains": {
      "url": "http://localhost:3000"
    }
  }
}
```
