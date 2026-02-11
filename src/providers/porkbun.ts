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

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface SessionInfo {
  checkId: string;
  searchHash: string;
  csrfPb: string;
  cookieHeader: string;
}

function parseSession(html: string, resp: Response): SessionInfo | null {
  const checkIdMatch = html.match(/var\s+checkId\s*=\s*'([^']+)'/);
  const searchHashMatch = html.match(/var\s+searchHash\s*=\s*'([^']+)'/);
  if (!checkIdMatch || !searchHashMatch) return null;

  const cookies = extractCookies(resp.headers);
  const csrfPb = cookies.get("csrf_pb") ?? "";
  if (!csrfPb) return null;

  return {
    checkId: checkIdMatch[1],
    searchHash: searchHashMatch[1],
    csrfPb,
    cookieHeader: Array.from(cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; "),
  };
}

export async function searchPorkbun(
  query: string,
): Promise<ProviderSearchResult> {
  try {
    const searchUrl = `${BASE_URL}/checkout/search?q=${encodeURIComponent(query.trim().toLowerCase())}`;
    const pageResp = await fetch(searchUrl, {
      headers: { Accept: "text/html", "User-Agent": USER_AGENT },
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

    const session = parseSession(await pageResp.text(), pageResp);
    if (!session) {
      return {
        provider: "porkbun",
        results: [],
        error: "Could not extract session from Porkbun page",
      };
    }

    const results = await pollForResults(
      session.checkId,
      session.searchHash,
      session.csrfPb,
      session.cookieHeader,
    );

    return { provider: "porkbun", results, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { provider: "porkbun", results: [], error: message };
  }
}

export async function searchPorkbunBulk(
  domains: string[],
): Promise<ProviderSearchResult> {
  try {
    // Step 1: GET the search page to obtain cookies, csrf_pb, and prb token
    const initResp = await fetch(`${BASE_URL}/checkout/search?q=${encodeURIComponent(domains[0])}`, {
      headers: { Accept: "text/html", "User-Agent": USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!initResp.ok) {
      return {
        provider: "porkbun",
        results: [],
        error: `HTTP ${initResp.status} from search page`,
      };
    }

    const initHtml = await initResp.text();
    const initCookies = extractCookies(initResp.headers);
    const csrfPb = initCookies.get("csrf_pb") ?? "";
    if (!csrfPb) {
      return {
        provider: "porkbun",
        results: [],
        error: "Could not extract csrf_pb cookie from Porkbun",
      };
    }

    // Extract prb token from hidden input
    const prbMatch = initHtml.match(/name="prb"\s+value="([^"]*)"/);
    const prb = prbMatch?.[1] ?? "";

    const initCookieHeader = Array.from(initCookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");

    // Step 2: POST bulk search
    const searchDomains = domains.map((d) => d.trim().toLowerCase()).join("\r\n");
    const bulkResp = await fetch(`${BASE_URL}/checkout/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        "User-Agent": USER_AGENT,
        Cookie: initCookieHeader,
        Referer: `${BASE_URL}/checkout/search`,
      },
      body: new URLSearchParams({
        prb,
        bulk: "1",
        bulkAction: "bulkSearchList",
        searchDomains,
        bulkSearchSld: "",
        search: "search",
        csrf_pb: csrfPb,
      }),
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!bulkResp.ok) {
      return {
        provider: "porkbun",
        results: [],
        error: `HTTP ${bulkResp.status} from bulk search`,
      };
    }

    // Merge cookies from both responses
    const bulkCookies = extractCookies(bulkResp.headers);
    const mergedCookies = new Map([...initCookies, ...bulkCookies]);
    const cookieHeader = Array.from(mergedCookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    const finalCsrf = mergedCookies.get("csrf_pb") ?? csrfPb;

    const bulkHtml = await bulkResp.text();
    const checkIdMatch = bulkHtml.match(/var\s+checkId\s*=\s*'([^']+)'/);
    const searchHashMatch = bulkHtml.match(/var\s+searchHash\s*=\s*'([^']+)'/);

    if (!checkIdMatch || !searchHashMatch) {
      return {
        provider: "porkbun",
        results: [],
        error: "Could not extract checkId/searchHash from bulk response",
      };
    }

    const results = await pollForResults(
      checkIdMatch[1],
      searchHashMatch[1],
      finalCsrf,
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
): Promise<DomainResult[]> {
  const DELAYS = [500, 500, 500, 1000, 2000, 3000, 3000, 3000, 3000, 3000];
  const MAX_ATTEMPTS = DELAYS.length;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
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

    if (!resp.ok) {
      await sleep(DELAYS[attempt]);
      continue;
    }

    const data: PorkbunResponse = await resp.json();
    if (!data.results || data.results.length === 0) {
      await sleep(DELAYS[attempt]);
      continue;
    }

    const hasPending = data.results.some((r) => r.result === "PENDING");
    if (hasPending && attempt < MAX_ATTEMPTS - 1) {
      await sleep(DELAYS[attempt]);
      continue;
    }

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
