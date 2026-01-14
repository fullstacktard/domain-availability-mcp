/**
 * Porkbun API Provider
 *
 * Provides domain pricing data from Porkbun registrar.
 * This API is completely FREE and requires NO authentication!
 *
 * API Documentation: https://porkbun.com/api/json/v3/documentation
 *
 * Coverage:
 * - 896+ TLDs
 * - Registration, renewal, transfer prices
 * - Coupon/promo information
 */

import type {
  PricingProvider,
  ProviderCapabilities,
  ProviderConfig,
  MultiRegistrarPricing,
  RegistrarPrice,
} from './types.js';
import { fetchIPv4 } from '../utils/fetch.js';

const API_URL = 'https://api.porkbun.com/api/json/v3/pricing/get';

/**
 * Porkbun API response structure
 */
interface PorkbunApiResponse {
  status: string;
  pricing: {
    [tld: string]: {
      registration: string;
      renewal: string;
      transfer: string;
      coupons: {
        code: string;
        max_per_user: number;
        first_year_only: string;
        type: string;
        amount: number;
      }[];
    };
  };
}

/**
 * Porkbun pricing provider
 * Note: This is a single-registrar provider, but returns data in multi-registrar format
 * for consistency with the provider interface.
 *
 * No caching - fetches fresh data on each request.
 */
export class PorkbunProvider implements PricingProvider {
  readonly name = 'porkbun';
  readonly capabilities: ProviderCapabilities = {
    pricing: true,
    availability: false,
    aftermarket: false,
    bulkCheck: false,
  };

  private timeout: number;

  constructor(config: ProviderConfig = {}) {
    this.timeout = config.timeout || 60000; // 60 second default (Porkbun API can be slow)
  }

  /**
   * Always configured - no API key required!
   */
  isConfigured(): boolean {
    return true;
  }

  /**
   * Fetch all pricing from Porkbun API
   */
  private async fetchAllPricing(): Promise<PorkbunApiResponse | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetchIPv4(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'fst-domain-mcp/0.3.0',
        },
        body: '{}',
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Porkbun API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as PorkbunApiResponse;

      if (data.status !== 'SUCCESS') {
        throw new Error(`Porkbun API returned status: ${data.status}`);
      }

      return data;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.error('Porkbun API request timed out');
      } else {
        console.error('Porkbun API error:', error);
      }
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Parse API response into pricing map
   */
  private parsePricingResponse(response: PorkbunApiResponse): Map<string, MultiRegistrarPricing> {
    const pricingMap = new Map<string, MultiRegistrarPricing>();
    const now = new Date().toISOString();

    for (const [tld, pricing] of Object.entries(response.pricing)) {
      const registrationPrice = parseFloat(pricing.registration);
      const renewalPrice = parseFloat(pricing.renewal);
      const transferPrice = parseFloat(pricing.transfer);

      // Check for active coupons
      let promoPrice: number | undefined;
      let promoEndDate: string | undefined;

      if (pricing.coupons && pricing.coupons.length > 0) {
        const coupon = pricing.coupons[0];
        if (coupon.type === 'amount') {
          promoPrice = Math.max(0, registrationPrice - coupon.amount);
        } else if (coupon.type === 'percent') {
          promoPrice = registrationPrice * (1 - coupon.amount / 100);
        }
      }

      const registrarPrice: RegistrarPrice = {
        registrar: 'Porkbun',
        registrationPrice,
        renewalPrice,
        transferPrice,
        currency: 'USD',
        promoPrice,
        promoEndDate,
      };

      pricingMap.set(tld.toLowerCase(), {
        tld: tld.toLowerCase(),
        prices: [registrarPrice],
        cheapestRegistration: registrarPrice,
        cheapestRenewal: registrarPrice,
        fetchedAt: now,
      });
    }

    return pricingMap;
  }

  /**
   * Get pricing for a specific TLD (fetches fresh data)
   */
  async getTldPricing(tld: string): Promise<MultiRegistrarPricing | null> {
    const normalizedTld = tld.toLowerCase().replace(/^\./, '');
    const response = await this.fetchAllPricing();

    if (!response || !response.pricing) {
      return null;
    }

    const pricingMap = this.parsePricingResponse(response);
    return pricingMap.get(normalizedTld) || null;
  }

  /**
   * Get all available TLD pricing (fetches fresh data)
   */
  async getAllTldPricing(): Promise<MultiRegistrarPricing[]> {
    const response = await this.fetchAllPricing();

    if (!response || !response.pricing) {
      return [];
    }

    const pricingMap = this.parsePricingResponse(response);
    return Array.from(pricingMap.values());
  }

  /**
   * Get list of supported registrars (just Porkbun for this provider)
   */
  async getSupportedRegistrars(): Promise<string[]> {
    return ['Porkbun'];
  }
}
