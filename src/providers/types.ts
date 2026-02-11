export interface DomainResult {
  domain: string;
  available: boolean;
  premium: boolean;
  price: {
    registration: number;
    renewal: number;
    currency: string;
  } | null;
  provider: "iwantmyname" | "porkbun";
}

export interface ProviderSearchResult {
  provider: "iwantmyname" | "porkbun";
  results: DomainResult[];
  error: string | null;
}
