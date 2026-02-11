# domains-mcp

MCP server for checking domain availability and pricing. Queries iwantmyname and Porkbun in parallel — no API keys needed.

## Tools

### Single domain

| Tool | Description |
|------|-------------|
| `search_domains` | Query both providers in parallel |
| `search_iwantmyname` | Query iwantmyname only |
| `search_porkbun` | Query Porkbun only |

Parameters: `query` (string), `exact` (boolean, default false — only return the queried domain), `json` (boolean, default false).

### Bulk

| Tool | Description |
|------|-------------|
| `bulk_search_domains` | Check multiple domains across both providers |
| `bulk_search_iwantmyname` | Check multiple domains via iwantmyname |
| `bulk_search_porkbun` | Check multiple domains via Porkbun |

Parameters: `domains` (string array), `json` (boolean, default false).

## Run

```bash
bun src/index.ts
```

Or with Docker:

```bash
docker compose up
```

Server listens on port 3000 by default. Override with `PORT` env var.

## Docker Compose

```yaml
services:
  domains:
    image: ghcr.io/paltaio/domains-mcp:latest
    restart: unless-stopped
    environment:
      TRANSPORT: http
```

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
