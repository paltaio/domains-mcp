import type { DomainResult, ProviderSearchResult } from "./types.js";

const BASE_URL = "https://iwantmyname.com";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const HTML_ENTITIES: Record<string, string> = {
  "&#36;": "$",
  "&euro;": "\u20AC",
  "&pound;": "\u00A3",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
};

function decodeHtmlEntities(s: string): string {
  return s.replace(/&#?\w+;/g, (m) => HTML_ENTITIES[m] ?? m);
}

function parsePrice(s: string): number {
  return parseFloat(decodeHtmlEntities(s).replace(/[^0-9.]/g, ""));
}

const STATUS_AVAILABLE = 4;
const STATUS_UNAVAILABLE = 7;
const STATUS_RESERVED = 8;
const STATUS_PREREGISTRATION = 9;

interface PrepareResponse {
  errMsg?: string;
  data?: PrepareItem[];
  check_group?: Record<string, string[]>;
  cart?: Record<string, unknown>;
  cfg?: string;
  pricing_tier?: string;
}

interface PrepareItem {
  domain: string;
  idn?: string;
  tld?: string;
  status?: number;
  prices?: Record<string, { price?: string }>;
  renewalPrices?: Record<string, string>;
  premium?: string;
  suggest?: string;
  rtype?: string;
  provider?: string;
  period_tag?: string;
}

interface CheckResponse {
  result?: Record<string, number>;
  premium?: Record<string, Record<string, string>>;
}

function extractCookieHeader(resp: Response): string {
  const cookies = resp.headers.getSetCookie?.() ?? [];
  return cookies
    .map((c) => c.split(";")[0])
    .join("; ");
}

export async function searchIwantmyname(
  query: string,
): Promise<ProviderSearchResult> {
  return doSearch(query.trim().toLowerCase());
}

export async function searchIwantmynameBulk(
  domains: string[],
): Promise<ProviderSearchResult> {
  const domainName = domains.map((d) => d.trim().toLowerCase()).join("\n");
  return doSearch(domainName);
}

async function doSearch(
  domainName: string,
): Promise<ProviderSearchResult> {
  try {
    const prepareResp = await fetch(
      `${BASE_URL}/en/AvailabilityCheck-prepareDomainListForAjax.html`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        body: new URLSearchParams({
          ajax: "1",
          domainName,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!prepareResp.ok) {
      return {
        provider: "iwantmyname",
        results: [],
        error: `HTTP ${prepareResp.status} from prepare endpoint`,
      };
    }

    const cookieHeader = extractCookieHeader(prepareResp);
    const prepare: PrepareResponse = await prepareResp.json();
    if (prepare.errMsg) {
      return { provider: "iwantmyname", results: [], error: prepare.errMsg };
    }

    const results: DomainResult[] = [];
    const pendingDomains: string[] = [];

    // Parse initial data from prepare response
    if (prepare.data) {
      for (const item of prepare.data) {
        if (!item.domain) continue;

        const isPremium = item.premium === "y";
        const regPrice = item.prices?.USD?.price;
        const renewalPrice = item.renewalPrices?.USD;

        let price: DomainResult["price"] = null;
        if (regPrice) {
          const regNum = parsePrice(regPrice);
          const renewNum = renewalPrice
            ? parsePrice(renewalPrice)
            : regNum;
          if (!isNaN(regNum)) {
            price = { registration: regNum, renewal: renewNum, currency: "USD" };
          }
        }

        if (
          item.status === STATUS_AVAILABLE ||
          item.status === STATUS_PREREGISTRATION
        ) {
          results.push({
            domain: item.domain,
            available: true,
            premium: isPremium,
            price,
            provider: "iwantmyname",
          });
        } else if (
          item.status === STATUS_UNAVAILABLE ||
          item.status === STATUS_RESERVED
        ) {
          results.push({
            domain: item.domain,
            available: false,
            premium: isPremium,
            price,
            provider: "iwantmyname",
          });
        } else {
          // Status pending — need to check via second endpoint
          pendingDomains.push(item.domain);
          results.push({
            domain: item.domain,
            available: false,
            premium: isPremium,
            price,
            provider: "iwantmyname",
          });
        }
      }
    }

    // Step 2: Check availability for pending domains (requires session cookies)
    if (pendingDomains.length > 0) {
      const checkResults = await checkAvailability(pendingDomains, cookieHeader);
      if (checkResults) {
        for (const result of results) {
          const status = checkResults[result.domain];
          if (status !== undefined) {
            result.available =
              status === STATUS_AVAILABLE ||
              status === STATUS_PREREGISTRATION;
          }
        }
      }
    }

    return { provider: "iwantmyname", results, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { provider: "iwantmyname", results: [], error: message };
  }
}

async function checkAvailability(
  domains: string[],
  cookieHeader: string,
): Promise<Record<string, number> | null> {
  const allResults: Record<string, number> = {};

  // Process in chunks of 30 (matching the JS client's DEFAULT_MAX_DOMAINS_IN_GROUP)
  const chunkSize = 30;
  const chunks: string[][] = [];
  for (let i = 0; i < domains.length; i += chunkSize) {
    chunks.push(domains.slice(i, i + chunkSize));
  }

  const requests = chunks.map(async (chunk) => {
    const resp = await fetch(
      `${BASE_URL}/AvailabilityCheck-checkAvailabilityWithAjax.html`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          Cookie: cookieHeader,
        },
        body: new URLSearchParams({
          ajax: "1",
          domainNames: chunk.join("|"),
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!resp.ok) return;
    const data: CheckResponse = await resp.json();
    if (data.result) {
      Object.assign(allResults, data.result);
    }
  });

  await Promise.all(requests);
  return Object.keys(allResults).length > 0 ? allResults : null;
}
