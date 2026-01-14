import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  HttpVerificationService,
  RdapService,
  NamecheapService,
} from './services/index.js';
import {
  ProviderRegistry,
  TldListProvider,
  PorkbunProvider,
  NamecheapAuctionsProvider,
} from './providers/index.js';
import type {
  ServerConfig,
  DomainCheckResult,
  BulkCheckResult,
  DomainStatus,
  LookupDomainResult,
  SearchDomainsResult,
} from './types.js';

// Domain validation constants
const MAX_DOMAIN_LENGTH = 253;
const DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const KEYWORD_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

// Common TLDs for search (user can override with any TLDs)
const DEFAULT_TLDS = [
  'com', 'net', 'org', 'io', 'co', 'ai', 'dev', 'app',
  'xyz', 'info', 'biz', 'me', 'tv', 'cc', 'us', 'uk',
];

/**
 * MCP Server for domain availability, pricing, and aftermarket search
 *
 * Version 0.3.0 - Multi-provider architecture:
 * 1. RDAP - Fast availability checking (no API key, no rate limits)
 * 2. TLD-List.com - Multi-registrar pricing aggregation (54+ registrars)
 * 3. Namecheap - Direct pricing and bulk availability
 * 4. Namecheap Auctions - Aftermarket/auction listings
 * 5. HTTP Verification - Parked domain detection
 */
export class DomainMcpServer {
  private server: Server;
  private namecheapService?: NamecheapService;
  private rdapService: RdapService;
  private httpService: HttpVerificationService;
  private providerRegistry: ProviderRegistry;
  private config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
    this.server = new Server(
      { name: 'fst-domain-mcp', version: '0.3.0' },
      { capabilities: { tools: {} } }
    );

    // Initialize core services
    // NamecheapService requires full legacy credentials (for domain registration operations)
    if (config.namecheap?.apiUser && config.namecheap?.apiKey &&
        config.namecheap?.username && config.namecheap?.clientIp) {
      this.namecheapService = new NamecheapService({
        apiUser: config.namecheap.apiUser,
        apiKey: config.namecheap.apiKey,
        username: config.namecheap.username,
        clientIp: config.namecheap.clientIp,
        useSandbox: config.namecheap.useSandbox,
      }, config.cacheTtl, config.httpTimeout);
    }
    this.rdapService = new RdapService(config.httpTimeout);
    this.httpService = new HttpVerificationService(config.httpTimeout);

    // Initialize provider registry
    this.providerRegistry = new ProviderRegistry();
    this.initializeProviders();

    this.setupHandlers();
  }

  /**
   * Initialize and register providers based on configuration
   */
  private initializeProviders(): void {
    // Register TLD-List.com provider for multi-registrar pricing (if API key provided)
    if (this.config.tldListApiKey) {
      const tldListProvider = new TldListProvider({
        apiKey: this.config.tldListApiKey,
        timeout: this.config.httpTimeout,
        cacheTtl: this.config.cacheTtl,
      });
      this.providerRegistry.registerPricingProvider(tldListProvider);
    } else {
      // Use Porkbun as free default pricing provider (no API key required!)
      const porkbunProvider = new PorkbunProvider({
        timeout: this.config.httpTimeout,
        cacheTtl: this.config.cacheTtl,
      });
      this.providerRegistry.registerPricingProvider(porkbunProvider);
    }

    // Register Namecheap Auctions provider for aftermarket
    // Uses the new Auctions API (aftermarketapi.namecheap.com) with Bearer JWT token
    if (this.config.namecheap) {
      const namecheapAuctions = new NamecheapAuctionsProvider({
        auctionsToken: this.config.namecheap.auctionsToken,
        // Legacy fields kept for backward compatibility
        apiUser: this.config.namecheap.apiUser,
        apiKey: this.config.namecheap.apiKey,
        username: this.config.namecheap.username,
        clientIp: this.config.namecheap.clientIp,
        sandbox: this.config.namecheap.useSandbox,
        timeout: this.config.httpTimeout,
        cacheTtl: this.config.cacheTtl,
      });
      this.providerRegistry.registerAftermarketProvider(namecheapAuctions);
    }
  }

  /**
   * Validate and normalize a domain name
   */
  private validateDomain(domain: unknown): string {
    if (typeof domain !== 'string') {
      throw new Error('Domain must be a string');
    }

    const normalized = domain.toLowerCase().trim();

    if (normalized.length === 0) {
      throw new Error('Domain cannot be empty');
    }

    if (normalized.length > MAX_DOMAIN_LENGTH) {
      throw new Error(`Domain exceeds maximum length of ${MAX_DOMAIN_LENGTH} characters`);
    }

    if (!DOMAIN_REGEX.test(normalized)) {
      throw new Error('Invalid domain format. Expected format: example.com');
    }

    return normalized;
  }

  /**
   * Validate a keyword for domain search
   */
  private validateKeyword(keyword: unknown): string {
    if (typeof keyword !== 'string') {
      throw new Error('Keyword must be a string');
    }

    const normalized = keyword.toLowerCase().trim();

    if (normalized.length === 0) {
      throw new Error('Keyword cannot be empty');
    }

    if (normalized.length > 63) {
      throw new Error('Keyword exceeds maximum length of 63 characters');
    }

    if (!KEYWORD_REGEX.test(normalized)) {
      throw new Error('Invalid keyword format. Use only letters, numbers, and hyphens');
    }

    return normalized;
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [
        // New comprehensive lookup tool
        {
          name: 'lookup_domain',
          description: 'Comprehensive domain lookup with pricing, availability, aftermarket listings, and parking detection. Returns pricing from Porkbun (896 TLDs, free) by default, or 54+ registrars if TLD_LIST_API_KEY is configured.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              domain: {
                type: 'string',
                description: 'The domain to lookup (e.g., "example.com")',
              },
              include_pricing: {
                type: 'boolean',
                description: 'Include multi-registrar pricing comparison (default: true)',
                default: true,
              },
              include_aftermarket: {
                type: 'boolean',
                description: 'Include aftermarket/auction listings (default: true)',
                default: true,
              },
              include_parking: {
                type: 'boolean',
                description: 'Include parking detection via HTTP (default: true)',
                default: true,
              },
            },
            required: ['domain'],
          },
        },
        // New multi-TLD search tool
        {
          name: 'search_domains',
          description: 'Search for domain availability across multiple TLDs with pricing. Enter a keyword and get results for .com, .net, .io, etc. with Porkbun pricing (or 54+ registrars if TLD_LIST_API_KEY configured).',
          inputSchema: {
            type: 'object' as const,
            properties: {
              keyword: {
                type: 'string',
                description: 'The keyword to search (e.g., "mybrand")',
              },
              tlds: {
                type: 'array',
                items: { type: 'string' },
                description: 'TLDs to search (default: 16 popular TLDs). Pass any TLDs you want, e.g. ["com", "io", "xyz", "tech", "store"]',
              },
              include_aftermarket: {
                type: 'boolean',
                description: 'Include aftermarket listings in search (default: true)',
                default: true,
              },
            },
            required: ['keyword'],
          },
        },
        // Legacy tools (kept for backward compatibility)
        {
          name: 'check_domain',
          description: 'Check if a domain is available, including parking detection and pricing. Returns verified availability status using RDAP, Namecheap API (if configured), and HTTP verification.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              domain: {
                type: 'string',
                description: 'The domain to check (e.g., "example.com")',
              },
              verify_http: {
                type: 'boolean',
                description: 'Whether to verify via HTTP to detect parked domains (default: true)',
                default: true,
              },
            },
            required: ['domain'],
          },
        },
        {
          name: 'check_bulk',
          description: 'Check multiple domains for availability with parking detection. Uses Namecheap bulk API (up to 50 domains per request) for efficient checking.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              domains: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of domains to check (max 50)',
              },
              verify_http: {
                type: 'boolean',
                description: 'Whether to verify via HTTP (default: true for small batches)',
                default: true,
              },
            },
            required: ['domains'],
          },
        },
        {
          name: 'get_tld_pricing',
          description: 'Get registration and renewal pricing for a specific TLD from multiple registrars. Uses TLD-List.com aggregator when configured, falls back to Namecheap.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              tld: {
                type: 'string',
                description: 'The TLD to get pricing for (e.g., "com", "io"). Omit for all TLDs.',
              },
            },
            required: [],
          },
        },
        {
          name: 'detect_parking',
          description: 'Detect if a domain is parked or for sale. Uses HTTP analysis to identify parking pages and brokers.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              domain: {
                type: 'string',
                description: 'The domain to check for parking',
              },
            },
            required: ['domain'],
          },
        },
        // Auction search tool
        {
          name: 'search_auctions',
          description: 'Search for domain auctions on Namecheap marketplace. Find auction domains by keyword, TLD, or price range. Returns auction details including current price, bid count, end time, and domain metrics. Note: Only returns auction listings (Buy Now/fixed-price listings are not available via API).',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: {
                type: 'string',
                description: 'Search keywords (e.g., "crypto", "ai", "tech"). Searches domain names containing these terms.',
              },
              tlds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter by TLDs (e.g., ["com", "io", "net"]). Leave empty for all TLDs.',
              },
              min_price: {
                type: 'number',
                description: 'Minimum price filter in USD',
              },
              max_price: {
                type: 'number',
                description: 'Maximum price filter in USD',
              },
              sort_by: {
                type: 'string',
                enum: ['price', 'ending_soon', 'relevance'],
                description: 'Sort results by: "price", "ending_soon", or "relevance" (default)',
              },
              max_results: {
                type: 'number',
                description: 'Maximum number of results to return (default: 25, max: 100)',
              },
            },
            required: ['query'],
          },
        },
        // Browse auctions tool (no keyword required)
        {
          name: 'browse_auctions',
          description: 'Browse all domain auctions on Namecheap marketplace without a specific keyword. Great for discovering auction domains by TLD, price range, or ending soon. Returns auction details including current price, bid count, end time, and domain metrics. Note: Only returns auction listings (Buy Now/fixed-price listings are not available via API).',
          inputSchema: {
            type: 'object' as const,
            properties: {
              tlds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter by TLDs (e.g., ["com", "io", "net"]). Leave empty for all TLDs.',
              },
              min_price: {
                type: 'number',
                description: 'Minimum price filter in USD',
              },
              max_price: {
                type: 'number',
                description: 'Maximum price filter in USD',
              },
              sort_by: {
                type: 'string',
                enum: ['price', 'ending_soon'],
                description: 'Sort results by: "price" or "ending_soon" (default)',
              },
              max_results: {
                type: 'number',
                description: 'Maximum number of results to return (default: 50, max: 100)',
              },
            },
            required: [],
          },
        },
      ];

      return { tools };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'lookup_domain':
            return await this.handleLookupDomain(args as {
              domain: string;
              include_pricing?: boolean;
              include_aftermarket?: boolean;
              include_parking?: boolean;
            });

          case 'search_domains':
            return await this.handleSearchDomains(args as {
              keyword: string;
              tlds?: string[];
              include_aftermarket?: boolean;
            });

          case 'check_domain':
            return await this.handleCheckDomain(args as { domain: string; verify_http?: boolean });

          case 'check_bulk':
            return await this.handleCheckBulk(args as { domains: string[]; verify_http?: boolean });

          case 'get_tld_pricing':
            return await this.handleGetTldPricing(args as { tld?: string });

          case 'detect_parking':
            return await this.handleDetectParking(args as { domain: string });

          case 'search_auctions':
            return await this.handleSearchAuctions(args as {
              query: string;
              tlds?: string[];
              min_price?: number;
              max_price?: number;
              sort_by?: 'price' | 'ending_soon' | 'relevance';
              max_results?: number;
            });

          case 'browse_auctions':
            return await this.handleBrowseAuctions(args as {
              tlds?: string[];
              min_price?: number;
              max_price?: number;
              sort_by?: 'price' | 'ending_soon';
              max_results?: number;
            });

          default:
            return {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text', text: `Error: ${message}` }],
          isError: true,
        };
      }
    });
  }

  /**
   * Handle lookup_domain tool - comprehensive domain lookup
   */
  private async handleLookupDomain(args: {
    domain: string;
    include_pricing?: boolean;
    include_aftermarket?: boolean;
    include_parking?: boolean;
  }): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const {
      include_pricing = true,
      include_aftermarket = true,
      include_parking = true,
    } = args;

    // Validate domain
    let normalizedDomain: string;
    try {
      normalizedDomain = this.validateDomain(args.domain);
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Validation error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }

    const tld = normalizedDomain.split('.').pop() || '';
    const now = new Date().toISOString();

    // Initialize result
    const result: LookupDomainResult = {
      domain: normalizedDomain,
      tld,
      availability: {
        status: 'unknown',
        verifiedAt: now,
        verificationMethod: 'rdap',
      },
    };

    // Step 1: Check availability via RDAP (fast, no rate limits)
    const rdapResult = await this.rdapService.checkDomain(normalizedDomain);
    if (rdapResult.available) {
      result.availability.status = 'available';
    } else if (rdapResult.registered) {
      result.availability.status = 'taken';
    }

    // Step 2: Get multi-registrar pricing
    if (include_pricing) {
      const pricingProviders = this.providerRegistry.getPricingProviders();

      if (pricingProviders.length > 0) {
        // Use TLD-List.com for multi-registrar pricing
        const provider = pricingProviders[0];
        const pricing = await provider.getTldPricing(tld);

        if (pricing && pricing.prices.length > 0) {
          result.pricing = {
            registrars: pricing.prices.map(p => ({
              registrar: p.registrar,
              registrationPrice: p.registrationPrice,
              renewalPrice: p.renewalPrice,
              currency: p.currency,
              promoPrice: p.promoPrice,
            })),
            cheapest: pricing.cheapestRegistration ? {
              registrar: pricing.cheapestRegistration.registrar,
              registrationPrice: pricing.cheapestRegistration.registrationPrice,
              renewalPrice: pricing.cheapestRegistration.renewalPrice,
              currency: pricing.cheapestRegistration.currency,
            } : undefined,
          };
        }
      } else if (this.namecheapService) {
        // Fall back to Namecheap pricing
        const ncPricing = await this.namecheapService.getTldPricing(tld);
        if (ncPricing) {
          result.pricing = {
            registrars: [{
              registrar: 'Namecheap',
              registrationPrice: ncPricing.registrationPrice,
              renewalPrice: ncPricing.renewalPrice,
              currency: ncPricing.currency,
            }],
            cheapest: {
              registrar: 'Namecheap',
              registrationPrice: ncPricing.registrationPrice,
              renewalPrice: ncPricing.renewalPrice,
              currency: ncPricing.currency,
            },
          };
        }
      }
    }

    // Step 3: Check aftermarket listings
    if (include_aftermarket) {
      const aftermarketProviders = this.providerRegistry.getAftermarketProviders();

      if (aftermarketProviders.length > 0) {
        const allListings: LookupDomainResult['aftermarket'] = {
          isListed: false,
          listings: [],
        };

        for (const provider of aftermarketProviders) {
          const listing = await provider.getDomainListing(normalizedDomain);
          if (listing) {
            allListings.isListed = true;
            allListings.listings.push({
              source: listing.source,
              price: listing.price,
              currency: listing.currency,
              listingType: listing.listingType,
              listingUrl: listing.listingUrl,
              endTime: listing.endTime,
            });
          }
        }

        if (allListings.isListed) {
          result.aftermarket = allListings;
          if (result.availability.status === 'taken') {
            result.availability.status = 'for_sale';
          }
        }
      }
    }

    // Step 4: Parking detection via HTTP
    if (include_parking && this.config.enableHttpVerification) {
      const httpResult = await this.httpService.verifyDomain(normalizedDomain);

      if (httpResult.status === 'parked' || httpResult.status === 'for_sale') {
        result.availability.status = httpResult.status;
        result.parking = httpResult.parkingDetection;
        result.availability.verificationMethod = 'http_check';
      } else if (httpResult.status === 'taken' && result.availability.status === 'available') {
        // HTTP shows site is live but RDAP said available - trust HTTP
        result.availability.status = 'taken';
      }

      result.httpStatus = httpResult.httpStatus;
      result.redirectUrl = httpResult.redirectUrl;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  /**
   * Handle search_domains tool - multi-TLD domain search
   */
  private async handleSearchDomains(args: {
    keyword: string;
    tlds?: string[];
    include_aftermarket?: boolean;
  }): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
    const { tlds = DEFAULT_TLDS, include_aftermarket = true } = args;

    // Validate keyword
    let normalizedKeyword: string;
    try {
      normalizedKeyword = this.validateKeyword(args.keyword);
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Validation error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }

    const now = new Date().toISOString();
    const results: SearchDomainsResult['results'] = [];

    // Generate domains to check
    const domainsToCheck = tlds.map(tld => `${normalizedKeyword}.${tld.toLowerCase().replace(/^\./, '')}`);

    // Check availability for all domains via RDAP
    const rdapResults = await this.rdapService.checkBulk(domainsToCheck);

    // Get pricing for each TLD
    const pricingProviders = this.providerRegistry.getPricingProviders();
    const pricingCache = new Map<string, { registrar: string; registrationPrice: number; renewalPrice: number; currency: string }>();

    for (const tld of tlds) {
      const normalizedTld = tld.toLowerCase().replace(/^\./, '');

      if (pricingProviders.length > 0) {
        const pricing = await pricingProviders[0].getTldPricing(normalizedTld);
        if (pricing?.cheapestRegistration) {
          pricingCache.set(normalizedTld, {
            registrar: pricing.cheapestRegistration.registrar,
            registrationPrice: pricing.cheapestRegistration.registrationPrice,
            renewalPrice: pricing.cheapestRegistration.renewalPrice,
            currency: pricing.cheapestRegistration.currency,
          });
        }
      } else if (this.namecheapService) {
        const ncPricing = await this.namecheapService.getTldPricing(normalizedTld);
        if (ncPricing) {
          pricingCache.set(normalizedTld, {
            registrar: 'Namecheap',
            registrationPrice: ncPricing.registrationPrice,
            renewalPrice: ncPricing.renewalPrice,
            currency: ncPricing.currency,
          });
        }
      }
    }

    // Check aftermarket listings
    let aftermarketListings: Map<string, { source: string; price: number; currency: string }> | undefined;

    if (include_aftermarket) {
      const aftermarketProviders = this.providerRegistry.getAftermarketProviders();
      if (aftermarketProviders.length > 0) {
        aftermarketListings = new Map();

        for (const provider of aftermarketProviders) {
          const searchResult = await provider.searchListings(normalizedKeyword, {
            maxResults: 50,
            tlds,
          });

          for (const listing of searchResult.listings) {
            const existing = aftermarketListings.get(listing.domain.toLowerCase());
            if (!existing || listing.price < existing.price) {
              aftermarketListings.set(listing.domain.toLowerCase(), {
                source: listing.source,
                price: listing.price,
                currency: listing.currency,
              });
            }
          }
        }
      }
    }

    // Build results
    for (const domain of domainsToCheck) {
      const tld = domain.split('.').pop() || '';
      const rdapResult = rdapResults.get(domain);

      let status: DomainStatus = 'unknown';
      if (rdapResult) {
        if (rdapResult.available) {
          status = 'available';
        } else if (rdapResult.registered) {
          status = 'taken';
        }
      }

      const pricing = pricingCache.get(tld);
      const aftermarket = aftermarketListings?.get(domain.toLowerCase());

      if (aftermarket && status === 'taken') {
        status = 'for_sale';
      }

      results.push({
        domain,
        tld,
        status,
        pricing: pricing ? {
          cheapestRegistrar: pricing.registrar,
          registrationPrice: pricing.registrationPrice,
          renewalPrice: pricing.renewalPrice,
          currency: pricing.currency,
        } : undefined,
        aftermarket: aftermarket ? {
          isListed: true,
          cheapestListing: aftermarket,
        } : undefined,
      });
    }

    const searchResult: SearchDomainsResult = {
      query: normalizedKeyword,
      tlds,
      results,
      totalResults: results.length,
      searchedAt: now,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(searchResult, null, 2) }],
    };
  }

  /**
   * Handle check_domain tool (legacy)
   */
  private async handleCheckDomain(args: { domain: string; verify_http?: boolean }): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const { verify_http = true } = args;

    // Validate domain input
    let normalizedDomain: string;
    try {
      normalizedDomain = this.validateDomain(args.domain);
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Validation error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }

    const tld = normalizedDomain.split('.').pop() || '';
    const now = new Date().toISOString();

    let result: DomainCheckResult = {
      domain: normalizedDomain,
      tld,
      status: 'unknown',
      verifiedAt: now,
      verificationMethod: 'rdap',
    };

    // Step 1: Fast RDAP check for availability (no rate limits)
    const rdapResult = await this.rdapService.checkDomain(normalizedDomain);

    if (rdapResult.available) {
      result.status = 'available';
      result.registrar = rdapResult.registrar;
    } else if (rdapResult.registered) {
      result.status = 'taken';
      result.registrar = rdapResult.registrar;
    }

    // Step 2: Get pricing from multi-registrar or Namecheap
    const pricingProviders = this.providerRegistry.getPricingProviders();

    if (pricingProviders.length > 0) {
      const pricing = await pricingProviders[0].getTldPricing(tld);
      if (pricing?.cheapestRegistration) {
        result.registrationPrice = pricing.cheapestRegistration.registrationPrice;
        result.renewalPrice = pricing.cheapestRegistration.renewalPrice;
        result.currency = pricing.cheapestRegistration.currency;
        result.registrar = pricing.cheapestRegistration.registrar;
      }
    } else if (this.namecheapService) {
      try {
        const namecheapResult = await this.namecheapService.checkDomain(normalizedDomain);

        if (namecheapResult.status === 'available') {
          result.status = 'available';
        } else if (namecheapResult.status === 'taken') {
          result.status = 'taken';
        } else if (namecheapResult.status === 'premium') {
          result.status = 'premium';
          result.registrationPrice = namecheapResult.registrationPrice;
          result.renewalPrice = namecheapResult.renewalPrice;
        }

        result.registrar = namecheapResult.registrar || 'Namecheap';
        result.verificationMethod = 'registrar_api';

        const pricing = await this.namecheapService.getTldPricing(tld);
        if (pricing && result.status !== 'premium') {
          result.registrationPrice = pricing.registrationPrice;
          result.renewalPrice = pricing.renewalPrice;
          result.currency = pricing.currency;
        }
      } catch (error) {
        console.error('Namecheap API error:', error);
      }
    }

    // Step 3: HTTP verification for parked/live site detection
    if (verify_http && this.config.enableHttpVerification) {
      if (result.status === 'taken' || result.status === 'unknown') {
        const httpResult = await this.httpService.verifyDomain(normalizedDomain);

        if (httpResult.status === 'available') {
          result.status = rdapResult.registered ? 'taken' : 'available';
        } else if (httpResult.status === 'parked' || httpResult.status === 'for_sale') {
          result.status = httpResult.status;
          result.parkingDetection = httpResult.parkingDetection;
        } else if (httpResult.status === 'taken') {
          result.status = 'taken';
        }

        result.httpStatus = httpResult.httpStatus;
        result.redirectUrl = httpResult.redirectUrl;
        result.verificationMethod = 'http_check';
      } else if (result.status === 'available') {
        const httpResult = await this.httpService.verifyDomain(normalizedDomain);
        if (httpResult.status === 'parked' || httpResult.status === 'for_sale') {
          result.status = httpResult.status as DomainStatus;
          result.parkingDetection = httpResult.parkingDetection;
          result.httpStatus = httpResult.httpStatus;
          result.redirectUrl = httpResult.redirectUrl;
        } else if (httpResult.status === 'taken') {
          result.status = 'taken';
          result.httpStatus = httpResult.httpStatus;
          result.redirectUrl = httpResult.redirectUrl;
        }
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  /**
   * Handle check_bulk tool
   */
  private async handleCheckBulk(args: { domains: string[]; verify_http?: boolean }): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const { domains, verify_http = true } = args;

    if (!Array.isArray(domains)) {
      return {
        content: [{ type: 'text', text: 'Error: domains must be an array' }],
        isError: true,
      };
    }

    if (domains.length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: domains array cannot be empty' }],
        isError: true,
      };
    }

    if (domains.length > 50) {
      return {
        content: [{ type: 'text', text: 'Error: Maximum 50 domains per request' }],
        isError: true,
      };
    }

    const normalizedDomains: string[] = [];
    const validationErrors: string[] = [];

    for (let i = 0; i < domains.length; i++) {
      try {
        normalizedDomains.push(this.validateDomain(domains[i]));
      } catch (error) {
        validationErrors.push(`domains[${i}]: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (validationErrors.length > 0) {
      return {
        content: [{ type: 'text', text: `Validation errors:\n${validationErrors.join('\n')}` }],
        isError: true,
      };
    }

    const results: DomainCheckResult[] = [];
    const now = new Date().toISOString();

    // Use Namecheap bulk API if available
    if (this.namecheapService) {
      try {
        const namecheapResults = await this.namecheapService.checkBulk(normalizedDomains);
        for (const ncResult of namecheapResults) {
          results.push(ncResult);
        }
      } catch (error) {
        console.error('Namecheap bulk check failed:', error);
      }
    }

    // Fall back to RDAP
    if (results.length === 0) {
      const rdapResults = await this.rdapService.checkBulk(normalizedDomains);

      for (const domain of normalizedDomains) {
        const tld = domain.split('.').pop() || '';
        const rdapResult = rdapResults.get(domain);

        const result: DomainCheckResult = {
          domain,
          tld,
          status: 'unknown',
          verifiedAt: now,
          verificationMethod: 'rdap',
        };

        if (rdapResult) {
          if (rdapResult.available) {
            result.status = 'available';
          } else if (rdapResult.registered) {
            result.status = 'taken';
            result.registrar = rdapResult.registrar;
          }
        }

        results.push(result);
      }
    }

    // HTTP verification for smaller batches
    if (verify_http && this.config.enableHttpVerification && domains.length <= 20) {
      const httpResults = await this.httpService.verifyBulk(normalizedDomains);

      for (const result of results) {
        const httpResult = httpResults.get(result.domain);
        if (httpResult) {
          if (httpResult.status === 'taken') {
            result.status = 'taken';
            result.httpStatus = httpResult.httpStatus;
            result.redirectUrl = httpResult.redirectUrl;
          } else if (httpResult.status === 'parked' || httpResult.status === 'for_sale') {
            result.status = httpResult.status as DomainStatus;
            result.parkingDetection = httpResult.parkingDetection;
            result.httpStatus = httpResult.httpStatus;
          } else if (httpResult.status === 'available' && result.status !== 'available') {
            result.status = 'available';
          }
        }
      }
    }

    const bulkResult: BulkCheckResult = {
      results,
      totalChecked: results.length,
      available: results.filter(r => r.status === 'available').length,
      taken: results.filter(r => r.status === 'taken').length,
      parked: results.filter(r => r.status === 'parked').length,
      forSale: results.filter(r => r.status === 'for_sale').length,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(bulkResult, null, 2) }],
    };
  }

  /**
   * Handle get_tld_pricing tool
   */
  private async handleGetTldPricing(args: { tld?: string }): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const pricingProviders = this.providerRegistry.getPricingProviders();

    // Use multi-registrar pricing if available
    if (pricingProviders.length > 0) {
      const provider = pricingProviders[0];

      if (args.tld) {
        const pricing = await provider.getTldPricing(args.tld);
        if (!pricing) {
          return {
            content: [{ type: 'text', text: `TLD "${args.tld}" not found or pricing unavailable` }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(pricing, null, 2) }],
        };
      }

      const allPricing = await provider.getAllTldPricing();
      return {
        content: [{ type: 'text', text: JSON.stringify(allPricing, null, 2) }],
      };
    }

    // Fall back to Namecheap
    if (!this.namecheapService) {
      return {
        content: [{
          type: 'text',
          text: 'Error: No pricing provider configured. Set TLD_LIST_API_KEY or NAMECHEAP_API_* environment variables.',
        }],
        isError: true,
      };
    }

    if (args.tld) {
      const pricing = await this.namecheapService.getTldPricing(args.tld);
      if (!pricing) {
        return {
          content: [{ type: 'text', text: `TLD "${args.tld}" not found or pricing unavailable` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(pricing, null, 2) }],
      };
    }

    const allPricing = await this.namecheapService.getAllTldPricing();
    return {
      content: [{ type: 'text', text: JSON.stringify(allPricing, null, 2) }],
    };
  }

  /**
   * Handle detect_parking tool
   */
  private async handleDetectParking(args: { domain: string }): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    let normalizedDomain: string;
    try {
      normalizedDomain = this.validateDomain(args.domain);
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Validation error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }

    const result = await this.httpService.verifyDomain(normalizedDomain);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          domain: normalizedDomain,
          isParked: result.status === 'parked' || result.status === 'for_sale',
          status: result.status,
          parkingDetection: result.parkingDetection,
          httpStatus: result.httpStatus,
          redirectUrl: result.redirectUrl,
        }, null, 2),
      }],
    };
  }

  /**
   * Handle search_auctions tool - search Namecheap marketplace
   *
   * Note: Only auction listings are returned. Buy Now/fixed-price listings
   * are not available via the Namecheap Auctions API.
   */
  private async handleSearchAuctions(args: {
    query: string;
    tlds?: string[];
    min_price?: number;
    max_price?: number;
    sort_by?: 'price' | 'ending_soon' | 'relevance';
    max_results?: number;
  }): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const {
      query,
      tlds,
      min_price,
      max_price,
      sort_by = 'relevance',
      max_results = 25,
    } = args;

    // Validate query
    if (!query || query.trim().length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: query is required' }],
        isError: true,
      };
    }

    // Check for aftermarket providers
    const aftermarketProviders = this.providerRegistry.getAftermarketProviders();
    if (aftermarketProviders.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'Error: No auction provider configured. Set NAMECHEAP_AUCTIONS_TOKEN environment variable to enable auction search.',
        }],
        isError: true,
      };
    }

    // Limit max results to 100
    const limitedMaxResults = Math.min(max_results, 100);

    try {
      const allListings: Array<{
        domain: string;
        price: number;
        currency: string;
        source: string;
        listingType: string;
        listingUrl?: string;
        endTime?: string;
        bidCount?: number;
        startPrice?: number;
        minBid?: number;
        renewalPrice?: number;
        metrics?: {
          age?: number;
          backlinks?: number;
          extensionsTaken?: number;
          cloudflareRanking?: number;
        };
      }> = [];

      // Search across all aftermarket providers
      for (const provider of aftermarketProviders) {
        const searchResult = await provider.searchListings(query.trim(), {
          tlds,
          minPrice: min_price,
          maxPrice: max_price,
          // Note: listingType not passed - API only returns auctions
          sortBy: sort_by,
          maxResults: limitedMaxResults,
        });

        if (searchResult.error) {
          // If provider returned an error, include it in response
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                query: query.trim(),
                error: searchResult.error,
                source: searchResult.source,
                searchedAt: searchResult.searchedAt,
              }, null, 2),
            }],
            isError: true,
          };
        }

        for (const listing of searchResult.listings) {
          allListings.push({
            domain: listing.domain,
            price: listing.price,
            currency: listing.currency,
            source: listing.source,
            listingType: listing.listingType,
            listingUrl: listing.listingUrl,
            endTime: listing.endTime,
            bidCount: listing.bidCount,
            startPrice: listing.startPrice,
            minBid: listing.minBid,
            renewalPrice: listing.renewalPrice,
            metrics: listing.metrics,
          });
        }
      }

      // Build response
      const response = {
        query: query.trim(),
        filters: {
          tlds: tlds || 'all',
          minPrice: min_price,
          maxPrice: max_price,
          sortBy: sort_by,
        },
        totalResults: allListings.length,
        listings: allListings.slice(0, limitedMaxResults),
        searchedAt: new Date().toISOString(),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error searching auctions: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  }

  /**
   * Handle browse_auctions tool - browse all auctions without keyword
   *
   * Note: Only auction listings are returned. Buy Now/fixed-price listings
   * are not available via the Namecheap Auctions API.
   */
  private async handleBrowseAuctions(args: {
    tlds?: string[];
    min_price?: number;
    max_price?: number;
    sort_by?: 'price' | 'ending_soon';
    max_results?: number;
  }): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
  }> {
    const {
      tlds,
      min_price,
      max_price,
      sort_by = 'ending_soon',
      max_results = 50,
    } = args;

    // Check for aftermarket providers
    const aftermarketProviders = this.providerRegistry.getAftermarketProviders();
    if (aftermarketProviders.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'Error: No auction provider configured. Set NAMECHEAP_AUCTIONS_TOKEN environment variable to enable auction browsing.',
        }],
        isError: true,
      };
    }

    // Limit max results to 100
    const limitedMaxResults = Math.min(max_results, 100);

    try {
      const allListings: Array<{
        domain: string;
        price: number;
        currency: string;
        source: string;
        listingType: string;
        listingUrl?: string;
        endTime?: string;
        bidCount?: number;
        startPrice?: number;
        minBid?: number;
        renewalPrice?: number;
        metrics?: {
          age?: number;
          backlinks?: number;
          extensionsTaken?: number;
          cloudflareRanking?: number;
        };
      }> = [];

      // Browse auctions from all providers (empty query = browse all)
      for (const provider of aftermarketProviders) {
        const searchResult = await provider.searchListings('', {
          tlds,
          minPrice: min_price,
          maxPrice: max_price,
          // Note: listingType not passed - API only returns auctions
          sortBy: sort_by,
          maxResults: limitedMaxResults,
        });

        if (searchResult.error) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: searchResult.error,
                source: searchResult.source,
                searchedAt: searchResult.searchedAt,
              }, null, 2),
            }],
            isError: true,
          };
        }

        for (const listing of searchResult.listings) {
          allListings.push({
            domain: listing.domain,
            price: listing.price,
            currency: listing.currency,
            source: listing.source,
            listingType: listing.listingType,
            listingUrl: listing.listingUrl,
            endTime: listing.endTime,
            bidCount: listing.bidCount,
            startPrice: listing.startPrice,
            minBid: listing.minBid,
            renewalPrice: listing.renewalPrice,
            metrics: listing.metrics,
          });
        }
      }

      // Build response
      const response = {
        filters: {
          tlds: tlds || 'all',
          minPrice: min_price,
          maxPrice: max_price,
          sortBy: sort_by,
        },
        totalResults: allListings.length,
        listings: allListings.slice(0, limitedMaxResults),
        searchedAt: new Date().toISOString(),
      };

      return {
        content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error browsing auctions: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('fst-domain-mcp server started');
  }

  /**
   * Get provider summary for logging
   */
  getProviderSummary(): { pricing: string[]; aftermarket: string[] } {
    return this.providerRegistry.getSummary();
  }
}

/**
 * Create server configuration from environment variables
 */
export function createConfigFromEnv(): ServerConfig {
  // Namecheap Auctions API token (new API)
  const namecheapAuctionsToken = process.env.NAMECHEAP_AUCTIONS_TOKEN;
  // Legacy Namecheap XML API credentials (kept for backward compatibility)
  const namecheapApiUser = process.env.NAMECHEAP_API_USER;
  const namecheapApiKey = process.env.NAMECHEAP_API_KEY;
  const namecheapUsername = process.env.NAMECHEAP_USERNAME;
  const namecheapClientIp = process.env.NAMECHEAP_CLIENT_IP;
  const namecheapSandbox = process.env.NAMECHEAP_SANDBOX === 'true';
  const tldListApiKey = process.env.TLD_LIST_API_KEY;

  // Configure Namecheap if either new token or legacy credentials are present
  const hasAuctionsToken = !!namecheapAuctionsToken;
  const hasLegacyCredentials = namecheapApiUser && namecheapApiKey && namecheapUsername && namecheapClientIp;

  return {
    namecheap: hasAuctionsToken || hasLegacyCredentials
      ? {
          auctionsToken: namecheapAuctionsToken,
          apiUser: namecheapApiUser,
          apiKey: namecheapApiKey,
          username: namecheapUsername,
          clientIp: namecheapClientIp,
          useSandbox: namecheapSandbox,
        }
      : undefined,
    tldListApiKey,
    enableHttpVerification: process.env.DISABLE_HTTP_VERIFICATION !== 'true',
    httpTimeout: parseInt(process.env.HTTP_TIMEOUT || '60000', 10),
    cacheTtl: parseInt(process.env.CACHE_TTL || '3600', 10),
  };
}
