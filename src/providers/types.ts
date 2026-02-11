export interface WhoisData {
  registrant: string | null;
  organization: string | null;
  registrar: string | null;
  creationDate: string | null;
  lastModified: string | null;
  expirationDate: string | null;
  nameservers: string[];
  website: string | null;
}

export interface DomainResult {
  domain: string;
  available: boolean;
  premium: boolean;
  price: {
    registration: number;
    renewal: number;
    currency: string;
  } | null;
  provider: "iwantmyname" | "porkbun" | "nicchile";
  whois?: WhoisData | null;
}

export interface ProviderSearchResult {
  provider: "iwantmyname" | "porkbun" | "nicchile";
  results: DomainResult[];
  error: string | null;
}
