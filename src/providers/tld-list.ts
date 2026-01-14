/**
 * TLD-List.com API Provider
 *
 * Provides multi-registrar pricing data for domain TLDs.
 * TLD-List.com aggregates pricing from 54+ registrars.
 *
 * API Documentation: https://tld-list.com/api
 *
 * Rate Limits:
 * - Free tier: 100 requests/day
 * - Paid tier: Higher limits available
 *
 * No caching - fetches fresh data on each request.
 */

import type {
  PricingProvider,
  ProviderCapabilities,
  ProviderConfig,
  MultiRegistrarPricing,
  RegistrarPrice,
} from './types.js';
import { fetchIPv4 } from '../utils/fetch.js';

const API_BASE_URL = 'https://tld-list.com/api';

/**
 * TLD pricing data from the API
 */
interface TldListApiResponse {
  tld: string;
  type: string;
  registrars: TldListRegistrarData[];
}

/**
 * Individual registrar pricing from API
 */
interface TldListRegistrarData {
  registrar: string;
  register: number;
  renew: number;
  transfer?: number;
  currency: string;
  promo_price?: number;
  promo_end?: string;
}

/**
 * TLD-List.com pricing provider
 */
export class TldListProvider implements PricingProvider {
  readonly name = 'tld-list';
  readonly capabilities: ProviderCapabilities = {
    pricing: true,
    availability: false,
    aftermarket: false,
    bulkCheck: false,
  };

  private apiKey: string;
  private timeout: number;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey || '';
    this.timeout = config.timeout || 30000;
  }

  /**
   * Check if provider is configured
   */
  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Fetch data from TLD-List API
   */
  private async fetchApi(endpoint: string): Promise<unknown> {
    const url = `${API_BASE_URL}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetchIPv4(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
          'User-Agent': 'fst-domain-mcp/0.3.0',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('TLD-List API: Invalid API key');
        }
        if (response.status === 429) {
          throw new Error('TLD-List API: Rate limit exceeded');
        }
        throw new Error(`TLD-List API error: ${response.status} ${response.statusText}`);
      }

      return await response.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Validate API response structure
   */
  private isValidTldResponse(data: unknown): data is TldListApiResponse {
    if (!data || typeof data !== 'object') return false;
    const obj = data as Record<string, unknown>;
    return typeof obj.tld === 'string' && Array.isArray(obj.registrars);
  }

  /**
   * Validate registrar data
   */
  private isValidRegistrarData(data: unknown): data is TldListRegistrarData {
    if (!data || typeof data !== 'object') return false;
    const obj = data as Record<string, unknown>;
    return (
      typeof obj.registrar === 'string' &&
      typeof obj.register === 'number' &&
      typeof obj.renew === 'number' &&
      typeof obj.currency === 'string'
    );
  }

  /**
   * Convert API response to our pricing format
   */
  private convertToPricing(data: TldListApiResponse): MultiRegistrarPricing {
    const prices: RegistrarPrice[] = data.registrars.map(r => ({
      registrar: r.registrar,
      registrationPrice: r.register,
      renewalPrice: r.renew,
      transferPrice: r.transfer,
      currency: r.currency,
      promoPrice: r.promo_price,
      promoEndDate: r.promo_end,
    }));

    // Sort by registration price to find cheapest
    const sortedByRegistration = [...prices].sort((a, b) => a.registrationPrice - b.registrationPrice);
    const sortedByRenewal = [...prices].sort((a, b) => a.renewalPrice - b.renewalPrice);

    return {
      tld: data.tld,
      prices,
      cheapestRegistration: sortedByRegistration[0],
      cheapestRenewal: sortedByRenewal[0],
      fetchedAt: new Date().toISOString(),
    };
  }

  /**
   * Get pricing for a specific TLD from multiple registrars (fetches fresh data)
   */
  async getTldPricing(tld: string): Promise<MultiRegistrarPricing | null> {
    // Normalize TLD (remove leading dot if present)
    const normalizedTld = tld.toLowerCase().replace(/^\./, '');

    try {
      const response = await this.fetchApi(`/tld/${normalizedTld}`);

      // Validate response structure
      if (!this.isValidTldResponse(response)) {
        console.error(`Invalid TLD-List API response for ${normalizedTld}`);
        return null;
      }

      if (response.registrars.length === 0) {
        return null;
      }

      // Filter to only valid registrar entries
      const validRegistrars = response.registrars.filter(r => this.isValidRegistrarData(r));
      if (validRegistrars.length === 0) {
        return null;
      }

      return this.convertToPricing({ ...response, registrars: validRegistrars as TldListRegistrarData[] });
    } catch (error) {
      console.error(`TLD-List API error for ${normalizedTld}:`, error);
      return null;
    }
  }

  /**
   * Get all available TLD pricing (fetches fresh data)
   */
  async getAllTldPricing(): Promise<MultiRegistrarPricing[]> {
    try {
      const response = await this.fetchApi('/tlds') as TldListApiResponse[];

      if (!Array.isArray(response)) {
        return [];
      }

      return response
        .filter(data => data.registrars && data.registrars.length > 0)
        .map(data => this.convertToPricing(data));
    } catch (error) {
      console.error('TLD-List API error fetching all TLDs:', error);
      return [];
    }
  }

  /**
   * Get list of supported registrars
   */
  async getSupportedRegistrars(): Promise<string[]> {
    try {
      const response = await this.fetchApi('/registrars') as { registrars: string[] };
      return response.registrars || [];
    } catch (error) {
      console.error('TLD-List API error fetching registrars:', error);
      return [];
    }
  }
}
