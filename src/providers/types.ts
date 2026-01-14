/**
 * Provider types for external data sources
 *
 * This module defines the interfaces for pluggable providers that can
 * supply domain pricing, availability, and aftermarket data.
 */

/**
 * Pricing information from a registrar
 */
export interface RegistrarPrice {
  registrar: string;
  registrationPrice: number;
  renewalPrice: number;
  transferPrice?: number;
  currency: string;
  promoPrice?: number;
  promoEndDate?: string;
}

/**
 * Multi-registrar pricing result
 */
export interface MultiRegistrarPricing {
  tld: string;
  prices: RegistrarPrice[];
  cheapestRegistration?: RegistrarPrice;
  cheapestRenewal?: RegistrarPrice;
  fetchedAt: string;
}

/**
 * Aftermarket/auction listing
 */
export interface AuctionListing {
  domain: string;
  price: number;
  currency: string;
  source: string;
  listingUrl?: string;
  listingType: 'fixed' | 'auction' | 'make_offer';
  endTime?: string;
  bidCount?: number;
  buyNowPrice?: number;
  /** Starting price for auctions */
  startPrice?: number;
  /** Minimum bid increment */
  minBid?: number;
  /** Annual renewal price */
  renewalPrice?: number;
  /** Domain metrics (age, backlinks, etc.) */
  metrics?: {
    age?: number;
    backlinks?: number;
    extensionsTaken?: number;
    cloudflareRanking?: number;
    /** Ahrefs Domain Rating (0-100) */
    ahrefsDomainRating?: number;
    /** Estimated domain value in USD */
    estimatedValue?: number;
  };
}

/**
 * Aftermarket search result
 */
export interface AftermarketSearchResult {
  query: string;
  listings: AuctionListing[];
  source: string;
  totalResults?: number;
  searchedAt: string;
  /** Error message if search failed */
  error?: string;
}

/**
 * Provider capability flags
 */
export interface ProviderCapabilities {
  pricing: boolean;
  availability: boolean;
  aftermarket: boolean;
  bulkCheck: boolean;
}

/**
 * Base provider interface
 */
export interface Provider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;

  /**
   * Check if provider is configured and ready
   */
  isConfigured(): boolean;
}

/**
 * Provider that can return multi-registrar pricing
 */
export interface PricingProvider extends Provider {
  /**
   * Get pricing for a specific TLD from multiple registrars
   */
  getTldPricing(tld: string): Promise<MultiRegistrarPricing | null>;

  /**
   * Get all available TLD pricing
   */
  getAllTldPricing(): Promise<MultiRegistrarPricing[]>;

  /**
   * Get list of supported registrars
   */
  getSupportedRegistrars(): Promise<string[]>;
}

/**
 * Provider that can search aftermarket/auctions
 */
export interface AftermarketProvider extends Provider {
  /**
   * Search for domain listings
   */
  searchListings(query: string, options?: AftermarketSearchOptions): Promise<AftermarketSearchResult>;

  /**
   * Get listing for a specific domain
   */
  getDomainListing(domain: string): Promise<AuctionListing | null>;
}

/**
 * Options for aftermarket search
 */
export interface AftermarketSearchOptions {
  maxResults?: number;
  minPrice?: number;
  maxPrice?: number;
  tlds?: string[];
  listingType?: 'fixed' | 'auction' | 'make_offer' | 'all';
  sortBy?: 'price' | 'ending_soon' | 'relevance';
}

/**
 * Configuration for provider initialization
 */
export interface ProviderConfig {
  apiKey?: string;
  apiUser?: string;
  apiSecret?: string;
  clientIp?: string;
  sandbox?: boolean;
  timeout?: number;
  cacheTtl?: number;
}
