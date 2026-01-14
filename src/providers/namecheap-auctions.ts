/**
 * Namecheap Auctions API Provider
 *
 * Provides access to Namecheap's aftermarket domain auctions.
 * Uses the dedicated Auctions API at aftermarketapi.namecheap.com
 *
 * API Documentation: https://aftermarketapi.namecheap.com/client/docs/
 * Authentication: Bearer JWT token (different from main Namecheap API)
 *
 * Features:
 * - Search active auctions by keywords, TLD, price range
 * - Get specific auction details
 * - View bid history
 *
 * Note: Requires separate Auctions API token from Namecheap account settings
 */

import type {
  AftermarketProvider,
  ProviderCapabilities,
  ProviderConfig,
  AftermarketSearchResult,
  AftermarketSearchOptions,
  AuctionListing,
} from './types.js';
import { fetchIPv4 } from '../utils/fetch.js';

const API_BASE_URL = 'https://aftermarketapi.namecheap.com/client/api';

/**
 * Sale object from Namecheap Auctions API
 *
 * Note: The Auctions API ONLY returns auction listings.
 * Buy Now (fixed-price) listings are a separate system with no public API.
 * See: https://aftermarketapi.namecheap.com/client/docs/
 */
interface NamecheapSale {
  id: string;
  /** Source of the auction: expired domain, portfolio sale, or user listing */
  auctionType?: 'expired' | 'portfolio' | 'user';
  status: 'active' | 'ended' | 'cancelled' | 'sold';
  name: string; // domain name (may or may not include TLD)
  tld?: string; // TLD if not included in name
  price: number;
  startPrice?: number;
  minBid?: number;
  bidCount: number;
  renewPrice?: number;
  startDate: string;
  endDate: string;
  // Domain metrics
  registeredDate?: string;
  backlinksCount?: number;
  extensionsTaken?: number;
  cloudflareRanking?: number;
  ahrefsDomainRating?: number;
  alexaRanking?: number;
  umbrellaRanking?: number;
  estimatedValue?: number;
  keywordSearchCount?: number;
  keywordSearchQuery?: string;
  lastSoldPrice?: number;
  lastSoldYear?: string;
}

/**
 * API response for list sales endpoint
 */
interface SalesListResponse {
  cursor?: string;
  hasMore: boolean;
  items: NamecheapSale[];
}

/**
 * Namecheap Auctions provider configuration
 */
export interface NamecheapAuctionsConfig extends ProviderConfig {
  /** Bearer token for Auctions API (from Namecheap account settings) */
  auctionsToken?: string;
  /** Legacy: API user (not used for Auctions API) */
  apiUser?: string;
  /** Legacy: API key (not used for Auctions API) */
  apiKey?: string;
  /** Legacy: Username (not used for Auctions API) */
  username?: string;
  /** Legacy: Client IP (not used for Auctions API) */
  clientIp?: string;
  sandbox?: boolean;
}

/**
 * Namecheap Auctions API provider
 *
 * Uses the dedicated Auctions API (aftermarketapi.namecheap.com)
 * with Bearer JWT authentication.
 */
export class NamecheapAuctionsProvider implements AftermarketProvider {
  readonly name = 'namecheap-auctions';
  readonly capabilities: ProviderCapabilities = {
    pricing: false,
    availability: false,
    aftermarket: true,
    bulkCheck: false,
  };

  private bearerToken: string;
  private timeout: number;
  private cache = new Map<string, { data: AuctionListing; expiresAt: number }>();
  private cacheTtl: number;

  constructor(config: NamecheapAuctionsConfig) {
    // New Auctions API uses bearer token
    this.bearerToken = config.auctionsToken || process.env.NAMECHEAP_AUCTIONS_TOKEN || '';
    this.timeout = config.timeout || 30000;
    this.cacheTtl = config.cacheTtl || 300; // 5 minute default (auctions change frequently)
  }

  /**
   * Check if provider is configured
   */
  isConfigured(): boolean {
    return !!this.bearerToken;
  }

  /**
   * Fetch from Namecheap Auctions API
   */
  private async fetchApi<T>(
    endpoint: string,
    params: Record<string, string | number | boolean | undefined> = {}
  ): Promise<T> {
    // Build query string from params
    const queryParams = Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join('&');

    const url = queryParams
      ? `${API_BASE_URL}${endpoint}?${queryParams}`
      : `${API_BASE_URL}${endpoint}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetchIPv4(url, {
        headers: {
          'Authorization': `Bearer ${this.bearerToken}`,
          'Accept': 'application/json',
          'User-Agent': 'fst-domain-mcp/0.3.0',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Namecheap Auctions API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      return await response.json() as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Convert API sale to AuctionListing format
   *
   * Note: All listings from this API are auctions (no Buy Now support).
   * The auctionType field indicates the source: expired, portfolio, or user.
   */
  private convertToListing(sale: NamecheapSale): AuctionListing {
    const domain = sale.name.includes('.') ? sale.name : `${sale.name}.${sale.tld}`;

    return {
      domain,
      price: sale.price,
      currency: 'USD',
      source: 'Namecheap',
      listingUrl: `https://www.namecheap.com/market/${domain}/`,
      listingType: 'auction', // API only returns auctions, no Buy Now support
      endTime: sale.endDate,
      bidCount: sale.bidCount,
      startPrice: sale.startPrice,
      minBid: sale.minBid,
      renewalPrice: sale.renewPrice,
      metrics: {
        backlinks: sale.backlinksCount,
        extensionsTaken: sale.extensionsTaken,
        cloudflareRanking: sale.cloudflareRanking,
        ahrefsDomainRating: sale.ahrefsDomainRating,
        estimatedValue: sale.estimatedValue,
      },
    };
  }

  /**
   * Search for domain auction listings
   */
  async searchListings(query: string, options: AftermarketSearchOptions = {}): Promise<AftermarketSearchResult> {
    if (!this.isConfigured()) {
      return {
        query,
        listings: [],
        source: 'Namecheap',
        totalResults: 0,
        searchedAt: new Date().toISOString(),
        error: 'Namecheap Auctions API not configured. Set NAMECHEAP_AUCTIONS_TOKEN environment variable.',
      };
    }

    const params: Record<string, string | number | boolean | undefined> = {
      // Search by keywords or name
      keywords: query,
      // Pagination - use cursor for efficiency
      page: 1,
    };

    // Note: Price and TLD filters are applied client-side after fetching results
    // The Namecheap Auctions API doesn't support direct filtering via query params

    // Sorting - only price is supported by API
    // The API only accepts specific orderBy values, and endDate/name are not valid
    // When sortBy is not specified or not 'price', we don't send orderBy (uses API default)
    if (options.sortBy === 'price') {
      params.orderBy = 'price';
      params.direction = 'asc';
    }
    // For 'ending_soon' and 'relevance', we don't send orderBy - API will use its default
    // The results will need to be sorted client-side if specific ordering is needed

    try {
      const listings: AuctionListing[] = [];
      let hasMore = true;
      let cursor: string | undefined;
      const maxResults = options.maxResults || 50;

      // Fetch pages until we have enough results
      while (hasMore && listings.length < maxResults) {
        if (cursor) {
          params.cursor = cursor;
        }

        const response = await this.fetchApi<SalesListResponse>('/sales', params);

        for (const sale of response.items) {
          const listing = this.convertToListing(sale);

          // Apply listing type filter
          if (options.listingType && options.listingType !== 'all') {
            if (options.listingType !== listing.listingType) {
              continue;
            }
          }

          // Apply price filters (client-side since API doesn't support them)
          if (options.minPrice !== undefined && listing.price < options.minPrice) {
            continue;
          }
          if (options.maxPrice !== undefined && listing.price > options.maxPrice) {
            continue;
          }

          // Apply TLD filter (client-side)
          if (options.tlds && options.tlds.length > 0) {
            const domainTld = listing.domain.split('.').pop()?.toLowerCase();
            if (!domainTld || !options.tlds.map(t => t.toLowerCase()).includes(domainTld)) {
              continue;
            }
          }

          listings.push(listing);

          if (listings.length >= maxResults) {
            break;
          }
        }

        hasMore = response.hasMore;
        cursor = response.cursor;
      }

      return {
        query,
        listings,
        source: 'Namecheap',
        totalResults: listings.length,
        searchedAt: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Namecheap Auctions search error:', errorMessage);

      return {
        query,
        listings: [],
        source: 'Namecheap',
        totalResults: 0,
        searchedAt: new Date().toISOString(),
        error: errorMessage,
      };
    }
  }

  /**
   * Get listing for a specific domain
   *
   * Note: The Auctions API searches by sale ID, not domain name.
   * We search for the domain name and return the first match.
   */
  async getDomainListing(domain: string): Promise<AuctionListing | null> {
    if (!this.isConfigured()) {
      return null;
    }

    // Check cache
    const cached = this.cache.get(domain.toLowerCase());
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    try {
      // Search for exact domain name
      const response = await this.fetchApi<SalesListResponse>('/sales', {
        name: domain,
      });

      if (response.items.length === 0) {
        return null;
      }

      // Find exact match (API may return partial matches)
      const exactMatch = response.items.find(sale => {
        const saleDomain = sale.name.includes('.') ? sale.name : `${sale.name}.${sale.tld}`;
        return saleDomain.toLowerCase() === domain.toLowerCase();
      });

      if (!exactMatch) {
        return null;
      }

      const listing = this.convertToListing(exactMatch);

      // Cache the result
      this.cache.set(domain.toLowerCase(), {
        data: listing,
        expiresAt: Date.now() + this.cacheTtl * 1000,
      });

      return listing;
    } catch (error) {
      console.error(`Namecheap auction lookup error for ${domain}:`, error);
      return null;
    }
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}
