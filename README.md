# domains-mcp

MCP server for checking domain availability and pricing. Queries iwantmyname, Porkbun, and NIC Chile in parallel — no API keys needed.

## Tools

### Single domain

| Tool | Description |
|------|-------------|
| `search_domains` | Query all three providers in parallel |
| `search_iwantmyname` | Query iwantmyname only |
| `search_porkbun` | Query Porkbun only |
| `search_nicchile` | Query NIC Chile only (.cl domains) |

Parameters: `query` (string), `exact` (boolean, default false — only return the queried domain), `json` (boolean, default false).

`search_nicchile` and `search_domains` also accept `whois` (boolean, default false) — includes WHOIS data (registrant, dates, nameservers) for taken .cl domains.

### Bulk

| Tool | Description |
|------|-------------|
| `bulk_search_domains` | Check multiple domains across all providers |
| `bulk_search_iwantmyname` | Check multiple domains via iwantmyname |
| `bulk_search_porkbun` | Check multiple domains via Porkbun |
| `bulk_search_nicchile` | Check multiple .cl domains via NIC Chile |

Parameters: `domains` (string array), `json` (boolean, default false).

`bulk_search_nicchile` and `bulk_search_domains` also accept `whois` (boolean, default false).

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
