import type { DomainResult, ProviderSearchResult } from "./types.js";

const BASE_URL = "https://porkbun.com";

interface PorkbunCheckResult {
  domain: string;
  tld: string;
  result: "AVAILABLE" | "UNAVAILABLE" | "PENDING";
  type: string;
  extended?: {
    premium?: number;
    price?: string;
    typePricing?: {
      registration?: { price?: string };
      renewal?: { price?: string };
    };
  };
}

interface PorkbunResponse {
  settings?: Record<string, unknown>;
  results?: PorkbunCheckResult[];
}

export async function searchPorkbun(
  query: string,
): Promise<ProviderSearchResult> {
  try {
    // Step 1: GET search page to obtain checkId, searchHash, and cookies
    const searchUrl = `${BASE_URL}/checkout/search?q=${encodeURIComponent(query.trim().toLowerCase())}`;
    const pageResp = await fetch(searchUrl, {
      headers: {
        Accept: "text/html",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!pageResp.ok) {
      return {
        provider: "porkbun",
        results: [],
        error: `HTTP ${pageResp.status} from search page`,
      };
    }

    const html = await pageResp.text();

    // Extract checkId and searchHash from inline script
    const checkIdMatch = html.match(/var\s+checkId\s*=\s*'([^']+)'/);
    const searchHashMatch = html.match(/var\s+searchHash\s*=\s*'([^']+)'/);

    if (!checkIdMatch || !searchHashMatch) {
      return {
        provider: "porkbun",
        results: [],
        error: "Could not extract checkId/searchHash from Porkbun page",
      };
    }

    const checkId = checkIdMatch[1];
    const searchHash = searchHashMatch[1];

    // Extract cookies from response
    const cookies = extractCookies(pageResp.headers);
    const csrfPb = cookies.get("csrf_pb") ?? "";

    if (!csrfPb) {
      return {
        provider: "porkbun",
        results: [],
        error: "Could not extract csrf_pb cookie from Porkbun",
      };
    }

    // Build cookie header for subsequent requests
    const cookieHeader = Array.from(cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    // Step 2: Poll for results (wait then request)
    await sleep(2500);

    const results = await pollForResults(
      checkId,
      searchHash,
      csrfPb,
      cookieHeader,
    );

    return { provider: "porkbun", results, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { provider: "porkbun", results: [], error: message };
  }
}

async function pollForResults(
  checkId: string,
  searchHash: string,
  csrfPb: string,
  cookieHeader: string,
  maxAttempts = 5,
): Promise<DomainResult[]> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const resp = await fetch(`${BASE_URL}/api/domains/getChecks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookieHeader,
        Accept: "application/json",
        Referer: `${BASE_URL}/checkout/search`,
      },
      body: new URLSearchParams({
        checkId,
        searchHash,
        addToCart: "",
        isajax: "true",
        csrf_pb: csrfPb,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) continue;

    const data: PorkbunResponse = await resp.json();
    if (!data.results || data.results.length === 0) {
      await sleep(1500);
      continue;
    }

    const hasPending = data.results.some((r) => r.result === "PENDING");
    if (hasPending && attempt < maxAttempts - 1) {
      await sleep(1500);
      continue;
    }

    // Parse results
    return data.results
      .filter((r) => r.result !== "PENDING")
      .map((r) => parsePorkbunResult(r));
  }

  return [];
}

function parsePorkbunResult(r: PorkbunCheckResult): DomainResult {
  const available = r.result === "AVAILABLE";
  const premium = (r.extended?.premium ?? 0) > 0;

  let price: DomainResult["price"] = null;
  const regPriceCents = r.extended?.typePricing?.registration?.price
    ?? r.extended?.price;
  const renewPriceCents = r.extended?.typePricing?.renewal?.price;

  if (regPriceCents) {
    const reg = parseInt(regPriceCents, 10) / 100;
    const renew = renewPriceCents
      ? parseInt(renewPriceCents, 10) / 100
      : reg;
    if (!isNaN(reg)) {
      price = { registration: reg, renewal: renew, currency: "USD" };
    }
  }

  return {
    domain: r.domain,
    available,
    premium,
    price,
    provider: "porkbun",
  };
}

function extractCookies(
  headers: Headers,
): Map<string, string> {
  const cookies = new Map<string, string>();
  const setCookieHeaders = headers.getSetCookie?.() ?? [];

  for (const header of setCookieHeaders) {
    const match = header.match(/^([^=]+)=([^;]*)/);
    if (match) {
      cookies.set(match[1].trim(), match[2].trim());
    }
  }

  return cookies;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
