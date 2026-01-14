/**
 * Provider Registry
 *
 * Central registry for managing pluggable data providers.
 * Allows dynamic registration and retrieval of pricing and aftermarket providers.
 */

import type {
  Provider,
  PricingProvider,
  AftermarketProvider,
  ProviderConfig,
} from './types.js';

/**
 * Provider factory function type
 */
type ProviderFactory<T extends Provider> = (config: ProviderConfig) => T;

/**
 * Registry for managing data providers
 */
export class ProviderRegistry {
  private pricingProviders = new Map<string, PricingProvider>();
  private aftermarketProviders = new Map<string, AftermarketProvider>();
  private factories = new Map<string, ProviderFactory<Provider>>();

  /**
   * Register a pricing provider
   */
  registerPricingProvider(provider: PricingProvider): void {
    if (!provider.isConfigured()) {
      console.error(`Pricing provider ${provider.name} is not configured, skipping registration`);
      return;
    }
    this.pricingProviders.set(provider.name, provider);
    console.error(`Registered pricing provider: ${provider.name}`);
  }

  /**
   * Register an aftermarket provider
   */
  registerAftermarketProvider(provider: AftermarketProvider): void {
    if (!provider.isConfigured()) {
      console.error(`Aftermarket provider ${provider.name} is not configured, skipping registration`);
      return;
    }
    this.aftermarketProviders.set(provider.name, provider);
    console.error(`Registered aftermarket provider: ${provider.name}`);
  }

  /**
   * Register a provider factory for lazy initialization
   */
  registerFactory(name: string, factory: ProviderFactory<Provider>): void {
    this.factories.set(name, factory);
  }

  /**
   * Get all registered pricing providers
   */
  getPricingProviders(): PricingProvider[] {
    return Array.from(this.pricingProviders.values());
  }

  /**
   * Get all registered aftermarket providers
   */
  getAftermarketProviders(): AftermarketProvider[] {
    return Array.from(this.aftermarketProviders.values());
  }

  /**
   * Get a specific pricing provider by name
   */
  getPricingProvider(name: string): PricingProvider | undefined {
    return this.pricingProviders.get(name);
  }

  /**
   * Get a specific aftermarket provider by name
   */
  getAftermarketProvider(name: string): AftermarketProvider | undefined {
    return this.aftermarketProviders.get(name);
  }

  /**
   * Check if any pricing providers are registered
   */
  hasPricingProviders(): boolean {
    return this.pricingProviders.size > 0;
  }

  /**
   * Check if any aftermarket providers are registered
   */
  hasAftermarketProviders(): boolean {
    return this.aftermarketProviders.size > 0;
  }

  /**
   * Get summary of registered providers
   */
  getSummary(): { pricing: string[]; aftermarket: string[] } {
    return {
      pricing: Array.from(this.pricingProviders.keys()),
      aftermarket: Array.from(this.aftermarketProviders.keys()),
    };
  }

  /**
   * Reset registry (useful for testing)
   */
  reset(): void {
    this.pricingProviders.clear();
    this.aftermarketProviders.clear();
    this.factories.clear();
  }
}

/**
 * Global provider registry instance
 * Note: The DomainMcpServer creates its own instance, this is provided
 * for convenience when using providers programmatically
 */
export const providerRegistry = new ProviderRegistry();
