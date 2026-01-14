/**
 * Namecheap API service for domain availability and pricing
 *
 * Requirements (must meet ONE):
 * - $50+ account balance
 * - 20+ domains in account
 * - $50+ spent in last 2 years
 *
 * API Documentation: https://www.namecheap.com/support/api/methods/
 */

import type { DomainCheckResult, TldInfo } from '../types.js';
import { fetchIPv4 } from '../utils/fetch.js';

const NAMECHEAP_API_URL = 'https://api.namecheap.com/xml.response';
const NAMECHEAP_SANDBOX_URL = 'https://api.sandbox.namecheap.com/xml.response';

export interface NamecheapConfig {
  apiUser: string;
  apiKey: string;
  username: string;
  clientIp: string;
  useSandbox?: boolean;
}

interface DomainCheckItem {
  domain: string;
  available: boolean;
  premium: boolean;
  premiumRegistrationPrice?: number;
  premiumRenewalPrice?: number;
  premiumRestorePrice?: number;
  icannFee?: number;
  eapFee?: number;
}

/**
 * Namecheap API service
 * Provides domain availability checking and TLD pricing
 */
export class NamecheapService {
  private config: NamecheapConfig;
  private pricingCache: Map<string, TldInfo> = new Map();
  private cacheExpiry: number = 0;
  private cacheTtl: number;
  private timeout: number;

  constructor(config: NamecheapConfig, cacheTtl: number = 3600, timeout: number = 15000) {
    this.config = config;
    this.cacheTtl = cacheTtl * 1000;
    this.timeout = timeout;
  }

  private get apiUrl(): string {
    return this.config.useSandbox ? NAMECHEAP_SANDBOX_URL : NAMECHEAP_API_URL;
  }

  /**
   * Build base API parameters
   */
  private buildParams(command: string): URLSearchParams {
    const params = new URLSearchParams();
    params.set('ApiUser', this.config.apiUser);
    params.set('ApiKey', this.config.apiKey);
    params.set('UserName', this.config.username);
    params.set('ClientIp', this.config.clientIp);
    params.set('Command', command);
    return params;
  }

  /**
   * Check domain availability - single domain
   */
  async checkDomain(domain: string): Promise<DomainCheckResult> {
    const results = await this.checkBulk([domain]);
    return results[0];
  }

  /**
   * Check multiple domains (up to 50 per request)
   */
  async checkBulk(domains: string[]): Promise<DomainCheckResult[]> {
    const now = new Date().toISOString();
    const results: DomainCheckResult[] = [];

    // Namecheap supports up to 50 domains per request
    const chunks = this.chunkArray(domains, 50);

    for (const chunk of chunks) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout);

        const params = this.buildParams('namecheap.domains.check');
        params.set('DomainList', chunk.join(','));

        const response = await fetchIPv4(`${this.apiUrl}?${params.toString()}`, {
          method: 'GET',
          signal: controller.signal,
          headers: {
            'Accept': 'application/xml',
            'User-Agent': 'fst-domain-mcp/0.1.0',
          },
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Namecheap API error: ${response.status}`);
        }

        const xml = await response.text();
        const checkResults = this.parseCheckResponse(xml, chunk);

        for (const item of checkResults) {
          const tld = item.domain.split('.').pop() || '';

          results.push({
            domain: item.domain.toLowerCase(),
            tld,
            status: item.available ? (item.premium ? 'premium' : 'available') : 'taken',
            registrationPrice: item.premiumRegistrationPrice,
            renewalPrice: item.premiumRenewalPrice,
            currency: 'USD',
            registrar: 'Namecheap',
            verifiedAt: now,
            verificationMethod: 'registrar_api',
          });
        }
      } catch (error) {
        console.error('Namecheap bulk check failed:', error);
        // Add unknown results for failed chunk
        for (const domain of chunk) {
          results.push({
            domain: domain.toLowerCase(),
            tld: domain.split('.').pop() || '',
            status: 'unknown',
            verifiedAt: now,
            verificationMethod: 'registrar_api',
          });
        }
      }

      // Small delay between chunks to respect rate limits
      if (chunks.length > 1) {
        await this.delay(100);
      }
    }

    return results;
  }

  /**
   * Parse domains.check XML response
   */
  private parseCheckResponse(xml: string, requestedDomains: string[]): DomainCheckItem[] {
    const results: DomainCheckItem[] = [];

    // Check for API errors
    if (xml.includes('Status="ERROR"')) {
      const errorMatch = xml.match(/<Error[^>]*>([^<]+)<\/Error>/);
      const errorMsg = errorMatch ? errorMatch[1] : 'Unknown error';
      console.error('Namecheap API error:', errorMsg);
      return requestedDomains.map(domain => ({
        domain,
        available: false,
        premium: false,
      }));
    }

    // Parse DomainCheckResult elements
    const domainResultRegex = /<DomainCheckResult\s+([^>]+)\/>/g;
    let match;

    while ((match = domainResultRegex.exec(xml)) !== null) {
      const attrs = match[1];

      const domain = this.extractAttribute(attrs, 'Domain') || '';
      const available = this.extractAttribute(attrs, 'Available') === 'true';
      const premium = this.extractAttribute(attrs, 'IsPremiumName') === 'true';
      const premiumRegPrice = this.extractAttribute(attrs, 'PremiumRegistrationPrice');
      const premiumRenewPrice = this.extractAttribute(attrs, 'PremiumRenewalPrice');
      const premiumRestorePrice = this.extractAttribute(attrs, 'PremiumRestorePrice');
      const icannFee = this.extractAttribute(attrs, 'IcannFee');
      const eapFee = this.extractAttribute(attrs, 'EapFee');

      results.push({
        domain,
        available,
        premium,
        premiumRegistrationPrice: premiumRegPrice ? parseFloat(premiumRegPrice) : undefined,
        premiumRenewalPrice: premiumRenewPrice ? parseFloat(premiumRenewPrice) : undefined,
        premiumRestorePrice: premiumRestorePrice ? parseFloat(premiumRestorePrice) : undefined,
        icannFee: icannFee ? parseFloat(icannFee) : undefined,
        eapFee: eapFee ? parseFloat(eapFee) : undefined,
      });
    }

    return results;
  }

  /**
   * Extract attribute value from XML attributes string
   */
  private extractAttribute(attrs: string, name: string): string | null {
    const regex = new RegExp(`${name}="([^"]*)"`, 'i');
    const match = attrs.match(regex);
    return match ? match[1] : null;
  }

  /**
   * Get TLD pricing
   */
  async getTldPricing(tld: string): Promise<TldInfo | undefined> {
    if (this.cacheExpiry > Date.now()) {
      return this.pricingCache.get(tld.toLowerCase().replace(/^\./, ''));
    }

    try {
      await this.refreshPricingCache();
      return this.pricingCache.get(tld.toLowerCase().replace(/^\./, ''));
    } catch (error) {
      console.error('Failed to fetch TLD pricing:', error);
      return undefined;
    }
  }

  /**
   * Get all TLD pricing
   */
  async getAllTldPricing(): Promise<TldInfo[]> {
    if (this.cacheExpiry > Date.now()) {
      return Array.from(this.pricingCache.values());
    }

    await this.refreshPricingCache();
    return Array.from(this.pricingCache.values());
  }

  /**
   * Refresh pricing cache from Namecheap API
   */
  private async refreshPricingCache(): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    const params = this.buildParams('namecheap.users.getPricing');
    params.set('ProductType', 'DOMAIN');
    params.set('ActionName', 'REGISTER');

    const response = await fetchIPv4(`${this.apiUrl}?${params.toString()}`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/xml',
        'User-Agent': 'fst-domain-mcp/0.1.0',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Namecheap pricing API error: ${response.status}`);
    }

    const xml = await response.text();

    // Check for API errors
    if (xml.includes('Status="ERROR"')) {
      const errorMatch = xml.match(/<Error[^>]*>([^<]+)<\/Error>/);
      throw new Error(errorMatch ? errorMatch[1] : 'Unknown Namecheap API error');
    }

    // Parse pricing data
    // Format: <ProductCategory Name="domains"><Product Name="tld">...
    this.pricingCache.clear();

    const productRegex = /<Product\s+Name="([^"]+)"[^>]*>([\s\S]*?)<\/Product>/g;
    let match;

    while ((match = productRegex.exec(xml)) !== null) {
      const tld = match[1].toLowerCase();
      const productContent = match[2];

      // Extract pricing from Price elements
      const priceRegex = /<Price\s+([^>]+)\/>/g;
      let priceMatch;
      let registrationPrice: number | undefined;
      let renewalPrice: number | undefined;
      let transferPrice: number | undefined;

      while ((priceMatch = priceRegex.exec(productContent)) !== null) {
        const priceAttrs = priceMatch[1];
        const duration = this.extractAttribute(priceAttrs, 'Duration');
        const priceValue = this.extractAttribute(priceAttrs, 'Price');

        // Get 1-year pricing
        if (duration === '1' && priceValue) {
          const price = parseFloat(priceValue);
          // Determine price type based on context
          if (!registrationPrice) {
            registrationPrice = price;
          }
        }
      }

      if (registrationPrice) {
        this.pricingCache.set(tld, {
          tld,
          registrationPrice,
          renewalPrice: renewalPrice || registrationPrice,
          transferPrice,
          currency: 'USD',
          available: true,
        });
      }
    }

    this.cacheExpiry = Date.now() + this.cacheTtl;
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
