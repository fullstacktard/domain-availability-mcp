#!/usr/bin/env node

import { DomainMcpServer, createConfigFromEnv } from './server.js';

async function main(): Promise<void> {
  const config = createConfigFromEnv();

  // Log configuration status to stderr (not stdout, as that's for MCP)
  console.error('fst-domain-mcp v0.3.0: Starting with configuration:');
  console.error(`  - RDAP: Enabled (no config required)`);
  console.error(`  - Pricing: ${config.tldListApiKey ? 'TLD-List.com (54 registrars)' : 'Porkbun (896 TLDs, FREE)'}`);
  const hasAuctionsToken = !!config.namecheap?.auctionsToken;
  console.error(`  - Namecheap Auctions: ${hasAuctionsToken ? 'Configured (token)' : 'Not configured (set NAMECHEAP_AUCTIONS_TOKEN)'}`);
  console.error(`  - HTTP verification: ${config.enableHttpVerification ? 'Enabled' : 'Disabled'}`);

  const server = new DomainMcpServer(config);

  // Log provider summary
  const summary = server.getProviderSummary();
  if (summary.pricing.length > 0 || summary.aftermarket.length > 0) {
    console.error('  - Providers:');
    if (summary.pricing.length > 0) {
      console.error(`    - Pricing: ${summary.pricing.join(', ')}`);
    }
    if (summary.aftermarket.length > 0) {
      console.error(`    - Aftermarket: ${summary.aftermarket.join(', ')}`);
    }
  }

  await server.start();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
