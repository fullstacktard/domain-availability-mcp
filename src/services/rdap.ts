/**
 * RDAP (Registration Data Access Protocol) service for domain availability
 * RDAP is the modern replacement for WHOIS with structured JSON responses
 */

import { fetchIPv4 } from '../utils/fetch.js';

// RDAP servers by TLD - manually curated for common TLDs
// Full list available at: https://data.iana.org/rdap/dns.json
const RDAP_SERVERS: Record<string, string> = {
  // Generic TLDs
  com: 'https://rdap.verisign.com/com/v1',
  net: 'https://rdap.verisign.com/net/v1',
  org: 'https://rdap.publicinterestregistry.org/rdap',
  info: 'https://rdap.afilias.net/rdap/info',
  biz: 'https://rdap.nic.biz',

  // Tech TLDs
  io: 'https://rdap.nic.io',
  dev: 'https://rdap.nic.google',
  app: 'https://rdap.nic.google',
  ai: 'https://rdap.nic.ai',
  sh: 'https://rdap.nic.sh',
  co: 'https://rdap.nic.co',
  me: 'https://rdap.nic.me',
  xyz: 'https://rdap.nic.xyz',
  tech: 'https://rdap.nic.tech',
  run: 'https://rdap.nic.run',

  // Country codes
  uk: 'https://rdap.nominet.uk/uk',
  de: 'https://rdap.denic.de',
  nl: 'https://rdap.sidn.nl',
  eu: 'https://rdap.eurid.eu',
  au: 'https://rdap.auda.org.au',
  ca: 'https://rdap.ca.fury.ca/rdap',
  us: 'https://rdap.nic.us',

  // Other popular
  gg: 'https://rdap.ci.gg',
  tv: 'https://rdap.nic.tv',
  fm: 'https://rdap.nic.fm',
};

export interface RdapResult {
  available: boolean;
  registered: boolean;
  domain: string;
  registrar?: string;
  createdDate?: string;
  expirationDate?: string;
  status?: string[];
  error?: string;
}

export interface RdapDomainResponse {
  objectClassName: string;
  handle?: string;
  ldhName: string;
  status?: string[];
  events?: Array<{
    eventAction: string;
    eventDate: string;
  }>;
  entities?: Array<{
    roles?: string[];
    vcardArray?: unknown[];
    publicIds?: Array<{
      type: string;
      identifier: string;
    }>;
  }>;
  nameservers?: Array<{
    ldhName: string;
  }>;
  errorCode?: number;
  title?: string;
  description?: string[];
}

/**
 * RDAP service for checking domain availability via RDAP protocol
 */
export class RdapService {
  private timeout: number;
  private bootstrapCache: Map<string, string> = new Map();
  private bootstrapLoaded = false;

  constructor(timeout: number = 10000) {
    this.timeout = timeout;
  }

  /**
   * Load RDAP bootstrap data from IANA
   * This maps TLDs to their RDAP server URLs
   */
  async loadBootstrap(): Promise<void> {
    if (this.bootstrapLoaded) return;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetchIPv4('https://data.iana.org/rdap/dns.json', {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
        },
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json() as {
          services: Array<[string[], string[]]>;
        };

        // Parse bootstrap data
        for (const service of data.services) {
          const tlds = service[0];
          const urls = service[1];
          if (urls.length > 0) {
            const rdapUrl = urls[0].replace(/\/$/, ''); // Remove trailing slash
            for (const tld of tlds) {
              this.bootstrapCache.set(tld.toLowerCase(), rdapUrl);
            }
          }
        }
        this.bootstrapLoaded = true;
      }
    } catch {
      // Bootstrap load failed, will fall back to hardcoded servers
      console.error('Failed to load RDAP bootstrap, using fallback servers');
    }
  }

  /**
   * Get RDAP server URL for a TLD
   */
  getRdapServer(tld: string): string | null {
    const normalizedTld = tld.toLowerCase();

    // Check bootstrap cache first
    if (this.bootstrapCache.has(normalizedTld)) {
      return this.bootstrapCache.get(normalizedTld)!;
    }

    // Fall back to hardcoded servers
    if (RDAP_SERVERS[normalizedTld]) {
      return RDAP_SERVERS[normalizedTld];
    }

    return null;
  }

  /**
   * Check domain availability via RDAP
   * Returns structured result with availability and registration details
   */
  async checkDomain(domain: string): Promise<RdapResult> {
    const normalizedDomain = domain.toLowerCase().trim();
    const tld = normalizedDomain.split('.').pop() || '';

    // Try to load bootstrap if not loaded
    if (!this.bootstrapLoaded) {
      await this.loadBootstrap();
    }

    const rdapServer = this.getRdapServer(tld);

    if (!rdapServer) {
      return {
        available: false,
        registered: false,
        domain: normalizedDomain,
        error: `No RDAP server found for TLD: .${tld}`,
      };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetchIPv4(`${rdapServer}/domain/${normalizedDomain}`, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/rdap+json, application/json',
        },
      });

      clearTimeout(timeoutId);

      // 404 typically means domain is available (not registered)
      if (response.status === 404) {
        return {
          available: true,
          registered: false,
          domain: normalizedDomain,
        };
      }

      // 200 means domain is registered
      if (response.ok) {
        const data = await response.json() as RdapDomainResponse;
        return this.parseRdapResponse(normalizedDomain, data);
      }

      // Other status codes
      return {
        available: false,
        registered: false,
        domain: normalizedDomain,
        error: `RDAP returned status ${response.status}`,
      };

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Connection errors don't tell us about availability
      return {
        available: false,
        registered: false,
        domain: normalizedDomain,
        error: `RDAP query failed: ${message}`,
      };
    }
  }

  /**
   * Parse RDAP response to extract useful information
   */
  private parseRdapResponse(domain: string, data: RdapDomainResponse): RdapResult {
    const result: RdapResult = {
      available: false,
      registered: true,
      domain,
      status: data.status,
    };

    // Extract dates from events
    if (data.events) {
      for (const event of data.events) {
        if (event.eventAction === 'registration') {
          result.createdDate = event.eventDate;
        } else if (event.eventAction === 'expiration') {
          result.expirationDate = event.eventDate;
        }
      }
    }

    // Extract registrar from entities
    if (data.entities) {
      for (const entity of data.entities) {
        if (entity.roles?.includes('registrar')) {
          // Try to get registrar name from public IDs or vcard
          if (entity.publicIds) {
            for (const id of entity.publicIds) {
              if (id.type === 'IANA Registrar ID') {
                result.registrar = `IANA ID: ${id.identifier}`;
              }
            }
          }
        }
      }
    }

    return result;
  }

  /**
   * Bulk check domains via RDAP
   * Note: RDAP doesn't have bulk endpoints, so this runs sequentially with small delays
   */
  async checkBulk(domains: string[]): Promise<Map<string, RdapResult>> {
    const results = new Map<string, RdapResult>();

    // Load bootstrap once
    if (!this.bootstrapLoaded) {
      await this.loadBootstrap();
    }

    for (const domain of domains) {
      const result = await this.checkDomain(domain);
      results.set(domain, result);

      // Small delay to avoid rate limiting
      await this.delay(100);
    }

    return results;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
