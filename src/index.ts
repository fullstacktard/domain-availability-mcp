export { DomainMcpServer, createConfigFromEnv } from './server.js';
export { HttpVerificationService, RdapService, NamecheapService } from './services/index.js';
export type { HttpVerificationResult, NamecheapConfig } from './services/index.js';
export * from './types.js';

// Provider exports
export {
  ProviderRegistry,
  providerRegistry,
  TldListProvider,
  PorkbunProvider,
  NamecheapAuctionsProvider,
} from './providers/index.js';
export type {
  Provider,
  PricingProvider,
  AftermarketProvider,
  ProviderCapabilities,
  ProviderConfig,
  MultiRegistrarPricing,
  RegistrarPrice,
  AuctionListing,
  AftermarketSearchResult,
  AftermarketSearchOptions,
  NamecheapAuctionsConfig,
} from './providers/index.js';
