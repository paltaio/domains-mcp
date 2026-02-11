import { parse } from "node-html-parser";
import type {
  DomainResult,
  ProviderSearchResult,
  WhoisData,
} from "./types.js";

const WHOIS_URL = "https://www.nic.cl/registry/Whois.do";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// NIC Chile pricing (USD) — see https://www.nic.cl/dominios/tarifas.html
const PRICE_USD = { registration: 11.5, renewal: 11.5, currency: "USD" };

const BULK_DELAY_MS = 1500;

function normalizeDomain(query: string): string {
  const q = query.trim().toLowerCase();
  return q.endsWith(".cl") ? q : `${q}.cl`;
}

const LABEL_MAP: Record<string, keyof WhoisData> = {
  "Titular": "registrant",
  "Organización": "organization",
  "Agente Registrador": "registrar",
  "Fecha de creación": "creationDate",
  "Fecha de última modificación": "lastModified",
  "Fecha de expiración": "expirationDate",
  "Servidor de Nombre": "nameservers",
};

function parseWhois(html: string): WhoisData {
  const whois: WhoisData = {
    registrant: null,
    organization: null,
    registrar: null,
    creationDate: null,
    lastModified: null,
    expirationDate: null,
    nameservers: [],
    website: null,
  };

  const doc = parse(html);
  const table = doc.querySelector(".tablabusqueda");
  if (!table) return whois;

  // Each row has: <td><div><b>Label:</b></div><div>Value</div></td>
  for (const row of table.querySelectorAll("tr")) {
    const bold = row.querySelector("b");
    if (!bold) continue;

    const label = bold.textContent.replace(/:$/, "").trim();
    const field = LABEL_MAP[label];
    if (!field) continue;

    // Value is in the sibling div after the label div
    const divs = row.querySelectorAll("td > div");
    const valuDiv = divs[1];
    if (!valuDiv) continue;

    const value = valuDiv.textContent.trim();
    if (!value) continue;

    if (field === "nameservers") {
      whois.nameservers.push(value);
    } else {
      whois[field] = value;
    }
  }

  // Website: <td>Sitio web: <a ...>www.example.cl</a></td>
  for (const td of table.querySelectorAll("td")) {
    if (td.textContent.includes("Sitio web:")) {
      const link = td.querySelector("a");
      if (link) {
        whois.website = link.textContent.trim();
      }
      break;
    }
  }

  return whois;
}

async function fetchWhoisPage(
  domain: string,
): Promise<{ html: string; ok: boolean; status: number }> {
  const url = `${WHOIS_URL}?d=${encodeURIComponent(domain)}`;
  const resp = await fetch(url, {
    headers: {
      Accept: "text/html",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    return { html: "", ok: false, status: resp.status };
  }

  return { html: await resp.text(), ok: true, status: resp.status };
}

function parseDomainResult(
  domain: string,
  html: string,
  whoisRequested: boolean,
): DomainResult {
  const available = html.includes("Nombre de dominio no existe.");
  const pendingDeletion = html.includes(
    "Este dominio está en proceso de eliminación.",
  );

  const result: DomainResult = {
    domain,
    available,
    premium: false,
    price: available ? PRICE_USD : null,
    provider: "nicchile",
  };

  if (pendingDeletion) {
    result.status = "pending_deletion";
  }

  if (!available && !pendingDeletion && whoisRequested) {
    result.whois = parseWhois(html);
  } else if (!available) {
    result.whois = null;
  }

  return result;
}

export async function searchNicChile(
  query: string,
  whois = false,
): Promise<ProviderSearchResult> {
  try {
    const domain = normalizeDomain(query);
    const { html, ok, status } = await fetchWhoisPage(domain);

    if (!ok) {
      return {
        provider: "nicchile",
        results: [],
        error: `HTTP ${status} from NIC Chile`,
      };
    }

    const result = parseDomainResult(domain, html, whois);
    return { provider: "nicchile", results: [result], error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { provider: "nicchile", results: [], error: message };
  }
}

export async function searchNicChileBulk(
  domains: string[],
  whois = false,
): Promise<ProviderSearchResult> {
  const results: DomainResult[] = [];

  for (let i = 0; i < domains.length; i++) {
    const domain = normalizeDomain(domains[i]);
    try {
      const { html, ok } = await fetchWhoisPage(domain);
      if (ok) {
        results.push(parseDomainResult(domain, html, whois));
      } else {
        results.push({
          domain,
          available: false,
          premium: false,
          price: null,
          provider: "nicchile",
        });
      }
    } catch {
      results.push({
        domain,
        available: false,
        premium: false,
        price: null,
        provider: "nicchile",
      });
    }

    // Delay between requests (skip after last)
    if (i < domains.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, BULK_DELAY_MS));
    }
  }

  return { provider: "nicchile", results, error: null };
}
