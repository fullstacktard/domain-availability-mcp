/**
 * Domain availability status
 */
export type DomainStatus =
  | 'available'      // Truly available at standard price
  | 'taken'          // Registered and in active use
  | 'parked'         // Registered but showing parking page
  | 'for_sale'       // Listed on aftermarket/broker
  | 'premium'        // Available but at premium price
  | 'unknown';       // Could not determine status

/**
 * Parking detection result
 */
export interface ParkingDetection {
  isParked: boolean;
  broker?: string;          // Sedo, Dan.com, GoDaddy, etc.
  indicators: string[];     // What triggered the detection
  estimatedPrice?: string;  // If price is visible
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Domain check result
 */
export interface DomainCheckResult {
  domain: string;
  tld: string;
  status: DomainStatus;
  registrationPrice?: number;   // Price in USD
  renewalPrice?: number;        // Renewal price in USD
  currency?: string;
  registrar?: string;
  parkingDetection?: ParkingDetection;
  aftermarketPrice?: number;    // If found on aftermarket
  aftermarketSource?: string;   // Which aftermarket
  httpStatus?: number;          // HTTP response status code
  redirectUrl?: string;         // Final URL after redirects
  verifiedAt: string;           // ISO timestamp
  verificationMethod: 'registrar_api' | 'http_check' | 'rdap' | 'whois';
}

/**
 * Bulk check result
 */
export interface BulkCheckResult {
  results: DomainCheckResult[];
  totalChecked: number;
  available: number;
  taken: number;
  parked: number;
  forSale: number;
}

/**
 * TLD information
 */
export interface TldInfo {
  tld: string;
  registrationPrice: number;
  renewalPrice: number;
  transferPrice?: number;
  currency: string;
  available: boolean;
}

/**
 * Aftermarket listing
 */
export interface AftermarketListing {
  domain: string;
  price: number;
  currency: string;
  source: string;          // Sedo, Dan.com, GoDaddy Auctions, etc.
  listingUrl?: string;
  listingType: 'fixed' | 'auction' | 'make_offer';
  expiresAt?: string;
}

/**
 * Aftermarket search result
 */
export interface AftermarketSearchResult {
  query: string;
  listings: AftermarketListing[];
  sources: string[];
  searchedAt: string;
}

/**
 * Namecheap API configuration
 */
export interface NamecheapConfig {
  /** Bearer JWT token for Auctions API (from Namecheap account settings) */
  auctionsToken?: string;
  /** Legacy: API user (not used for Auctions API) */
  apiUser?: string;
  /** Legacy: API key (not used for Auctions API) */
  apiKey?: string;
  /** Legacy: Username (not used for Auctions API) */
  username?: string;
  /** Legacy: Client IP (not used for Auctions API) */
  clientIp?: string;
  useSandbox?: boolean;
}

/**
 * Server configuration
 */
export interface ServerConfig {
  namecheap?: NamecheapConfig;
  tldListApiKey?: string;
  enableHttpVerification: boolean;
  httpTimeout: number;      // ms
  cacheTtl: number;         // seconds
}

/**
 * Lookup domain result - comprehensive domain information
 */
export interface LookupDomainResult {
  domain: string;
  tld: string;
  availability: {
    status: DomainStatus;
    verifiedAt: string;
    verificationMethod: string;
  };
  pricing?: {
    registrars: Array<{
      registrar: string;
      registrationPrice: number;
      renewalPrice: number;
      currency: string;
      promoPrice?: number;
    }>;
    cheapest?: {
      registrar: string;
      registrationPrice: number;
      renewalPrice: number;
      currency: string;
    };
  };
  aftermarket?: {
    isListed: boolean;
    listings: Array<{
      source: string;
      price: number;
      currency: string;
      listingType: 'fixed' | 'auction' | 'make_offer';
      listingUrl?: string;
      endTime?: string;
    }>;
  };
  parking?: ParkingDetection;
  httpStatus?: number;
  redirectUrl?: string;
}

/**
 * Search domains result
 */
export interface SearchDomainsResult {
  query: string;
  tlds: string[];
  results: Array<{
    domain: string;
    tld: string;
    status: DomainStatus;
    pricing?: {
      cheapestRegistrar: string;
      registrationPrice: number;
      renewalPrice: number;
      currency: string;
    };
    aftermarket?: {
      isListed: boolean;
      cheapestListing?: {
        source: string;
        price: number;
        currency: string;
      };
    };
  }>;
  totalResults: number;
  searchedAt: string;
}

/**
 * Common parking service patterns
 */
export const PARKING_PATTERNS = {
  brokers: {
    // Use more specific patterns to avoid false positives
    sedo: ['sedo.com/', 'href="https://sedo.com', 'Sedo.com', 'powered by sedo'],
    dan: ['dan.com/', 'href="https://dan.com', 'Dan.com domain'],
    afternic: ['afternic.com/', 'Afternic.com'],
    godaddy: ['godaddy.com/', 'GoDaddy Auctions', 'Get this domain at GoDaddy'],
    namecheap: ['namecheap.com/market', 'Namecheap Marketplace'],
    hugedomains: ['hugedomains.com/', 'HugeDomains.com'],
    parkingcrew: ['parkingcrew.com', 'Powered by ParkingCrew'],
    bodis: ['bodis.com/', 'Bodis.com'],
  },
  indicators: [
    'This domain is for sale',
    'Buy this domain',
    'Make an offer on this domain',
    'Domain parking',
    'Premium domain for sale',
    'Get this domain',
    'Domain is for sale',
    'Inquire about this domain',
    'This domain may be for sale',
    'domain has been registered',
    'parked free',
    'Buy Now for',
  ],
} as const;
