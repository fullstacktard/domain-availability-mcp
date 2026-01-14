# domain-availability-mcp

MCP (Model Context Protocol) server for comprehensive domain research, providing:

- **Domain availability checking** via RDAP (no API key required)
- **TLD pricing** from 896+ TLDs via Porkbun API (FREE, no API key required!)
- **Multi-registrar pricing** comparison from 54+ registrars (optional, via TLD-List.com)
- **Aftermarket/auction listings** search (optional, via Namecheap Auctions)
- **Parking detection** to identify parked domains and broker listings
- **Modular provider architecture** for easy extension

**Works out of the box with zero configuration!** Domain availability + pricing works immediately.

## Requirements

- **Node.js 18.0.0 or higher** (uses native fetch API)

## Installation

```bash
npm install domain-availability-mcp
```

Or globally:
```bash
npm install -g domain-availability-mcp
```

## Quick Start

### As MCP Server (Claude Desktop / Claude Code)

Add to your MCP configuration:

**Minimal (works immediately):**
```json
{
  "mcpServers": {
    "domain-search": {
      "command": "npx",
      "args": ["domain-availability-mcp"]
    }
  }
}
```

**Full configuration (all features):**
```json
{
  "mcpServers": {
    "domain-search": {
      "command": "npx",
      "args": ["domain-availability-mcp"],
      "env": {
        "TLD_LIST_API_KEY": "your-tld-list-api-key",
        "NAMECHEAP_API_USER": "your-api-user",
        "NAMECHEAP_API_KEY": "your-api-key",
        "NAMECHEAP_USERNAME": "your-username",
        "NAMECHEAP_CLIENT_IP": "your-ip"
      }
    }
  }
}
```

### Programmatic Usage

```typescript
import { DomainMcpServer, createConfigFromEnv } from 'domain-availability-mcp';

const config = createConfigFromEnv();
const server = new DomainMcpServer(config);
await server.start();
```

## Environment Variables

**No environment variables are required!** The server works out of the box with:
- RDAP for availability checking (free, no config)
- Porkbun API for pricing (free, no config)

### Optional (Enhanced Features)

| Variable | Description |
|----------|-------------|
| `TLD_LIST_API_KEY` | API key for TLD-List.com (54 registrar comparison - paid) |

### Optional (Namecheap Auctions)

| Variable | Description |
|----------|-------------|
| `NAMECHEAP_AUCTIONS_TOKEN` | Bearer JWT token from Namecheap Market settings (for auction search) |

Get your token: Namecheap > Profile > Tools > Market Settings > API Token

### Optional (Legacy Namecheap XML API)

| Variable | Description |
|----------|-------------|
| `NAMECHEAP_API_USER` | Namecheap API username |
| `NAMECHEAP_API_KEY` | Namecheap API key |
| `NAMECHEAP_USERNAME` | Namecheap account username |
| `NAMECHEAP_CLIENT_IP` | Your whitelisted IP address |
| `NAMECHEAP_SANDBOX` | Set to `true` for sandbox mode |

### Configuration Options

| Variable | Default | Description |
|----------|---------|-------------|
| `DISABLE_HTTP_VERIFICATION` | `false` | Set to `true` to disable HTTP parking detection |
| `HTTP_TIMEOUT` | `60000` | HTTP request timeout in milliseconds (60 seconds) |
| `CACHE_TTL` | `3600` | Cache TTL in seconds |

## MCP Tools

### lookup_domain

Comprehensive single-domain lookup with pricing, aftermarket, and parking data.

```json
{
  "domain": "example.com",
  "include_pricing": true,
  "include_aftermarket": true,
  "include_parking": true
}
```

**Response:**
```json
{
  "domain": "example.com",
  "tld": "com",
  "availability": {
    "status": "taken",
    "verifiedAt": "2025-01-15T10:30:00Z",
    "verificationMethod": "rdap"
  },
  "pricing": {
    "registrars": [
      { "registrar": "Namecheap", "registrationPrice": 8.88, "renewalPrice": 12.98, "currency": "USD" },
      { "registrar": "Cloudflare", "registrationPrice": 9.15, "renewalPrice": 9.15, "currency": "USD" }
    ],
    "cheapest": { "registrar": "Namecheap", "registrationPrice": 8.88, "renewalPrice": 12.98, "currency": "USD" }
  },
  "aftermarket": {
    "isListed": true,
    "listings": [
      { "source": "Namecheap", "price": 5000, "currency": "USD", "listingType": "fixed" }
    ]
  }
}
```

### search_domains

Search for domain availability across multiple TLDs with pricing.

```json
{
  "keyword": "mybrand",
  "tlds": ["com", "io", "ai", "dev"],
  "include_aftermarket": true
}
```

**Response:**
```json
{
  "query": "mybrand",
  "tlds": ["com", "io", "ai", "dev"],
  "results": [
    {
      "domain": "mybrand.com",
      "tld": "com",
      "status": "taken",
      "pricing": { "cheapestRegistrar": "Namecheap", "registrationPrice": 8.88, "renewalPrice": 12.98, "currency": "USD" }
    },
    {
      "domain": "mybrand.io",
      "tld": "io",
      "status": "available",
      "pricing": { "cheapestRegistrar": "Porkbun", "registrationPrice": 25.99, "renewalPrice": 29.99, "currency": "USD" }
    }
  ],
  "totalResults": 4,
  "searchedAt": "2025-01-15T10:30:00Z"
}
```

### check_domain (Legacy)

Single domain availability check with parking detection.

```json
{
  "domain": "example.com",
  "verify_http": true
}
```

### check_bulk (Legacy)

Check multiple domains at once (max 50).

```json
{
  "domains": ["example1.com", "example2.io", "example3.net"],
  "verify_http": true
}
```

### get_tld_pricing

Get registration/renewal pricing for TLDs from multiple registrars.

```json
{
  "tld": "com"
}
```

### detect_parking

Detect if a domain is parked or for sale.

```json
{
  "domain": "example.com"
}
```

### search_auctions

Search for domain auctions by keyword on Namecheap marketplace. Requires `NAMECHEAP_AUCTIONS_TOKEN`.

**Note:** Only returns auction listings. Buy Now (fixed-price) listings are not available via API.

```json
{
  "query": "crypto",
  "tlds": ["com", "io"],
  "min_price": 1,
  "max_price": 100,
  "sort_by": "price",
  "max_results": 25
}
```

**Response:**
```json
{
  "query": "crypto",
  "filters": { "tlds": ["com", "io"], "maxPrice": 100, "sortBy": "price" },
  "totalResults": 25,
  "listings": [
    {
      "domain": "cryptoexample.com",
      "price": 15,
      "currency": "USD",
      "source": "Namecheap",
      "listingType": "auction",
      "listingUrl": "https://www.namecheap.com/market/buynow/cryptoexample.com",
      "endTime": "2024-01-20T16:00:00.000Z",
      "bidCount": 5,
      "startPrice": 1,
      "minBid": 16,
      "renewalPrice": 18.48,
      "metrics": { "backlinks": 150, "extensionsTaken": 3 }
    }
  ],
  "searchedAt": "2025-01-15T10:30:00Z"
}
```

### browse_auctions

Browse all domain auctions without a keyword. Requires `NAMECHEAP_AUCTIONS_TOKEN`.

**Note:** Only returns auction listings. Buy Now (fixed-price) listings are not available via API.

```json
{
  "tlds": ["com"],
  "min_price": 1,
  "max_price": 50,
  "sort_by": "ending_soon",
  "max_results": 50
}
```

**Response:** Same format as `search_auctions`.

## Providers

The server uses a modular provider architecture for extensibility.

### Built-in Providers

1. **Porkbun** (`porkbun`) - FREE default pricing provider ⭐
   - 896+ TLDs with pricing
   - Registration, renewal, transfer prices
   - Promo/coupon information
   - **No API key required!**

2. **TLD-List.com** (`tld-list`) - Multi-registrar pricing aggregation (optional)
   - 54+ registrars for price comparison
   - 3,495+ TLDs
   - Requires paid API key

3. **Namecheap Auctions** (`namecheap-auctions`) - Aftermarket auction listings
   - Search and browse domain auctions
   - Auction domains only (Buy Now/fixed-price listings are NOT available via API)
   - Domain metrics (backlinks, Ahrefs DR, Cloudflare ranking, estimated value)
   - Requires `NAMECHEAP_AUCTIONS_TOKEN` (separate from XML API)

### Adding Custom Providers

```typescript
import { ProviderRegistry, TldListProvider } from 'domain-availability-mcp';

// Custom pricing provider
class MyPricingProvider implements PricingProvider {
  readonly name = 'my-provider';
  readonly capabilities = { pricing: true, availability: false, aftermarket: false, bulkCheck: false };

  isConfigured() { return true; }

  async getTldPricing(tld: string) {
    // Your implementation
  }

  async getAllTldPricing() {
    // Your implementation
  }

  async getSupportedRegistrars() {
    // Your implementation
  }
}

// Register
const registry = new ProviderRegistry();
registry.registerPricingProvider(new MyPricingProvider());
```

## API Keys Setup

### TLD-List.com

1. Visit https://tld-list.com/api
2. Create an account and get your API key
3. Set `TLD_LIST_API_KEY` environment variable

### Namecheap

Requirements:
- $50+ account balance, OR
- 20+ domains in account, OR
- $50+ spent in last 2 years

Setup:
1. Log into Namecheap
2. Go to Profile > Tools > API Access
3. Enable API access
4. Whitelist your IP address
5. Copy your API key
6. Set all `NAMECHEAP_*` environment variables

## Domain Status Types

| Status | Description |
|--------|-------------|
| `available` | Domain can be registered at standard price |
| `taken` | Domain is registered and in active use |
| `parked` | Domain shows parking page (may be for sale) |
| `for_sale` | Domain is listed on aftermarket |
| `premium` | Available but at premium price |
| `unknown` | Could not determine status |

## Rate Limits

- **RDAP**: No rate limits (distributed protocol)
- **Porkbun**: No documented rate limits (be reasonable)
- **TLD-List.com**: 100 requests/day (free tier)
- **Namecheap**: 20 requests/minute, 50 domains/bulk request

## Pricing Data Comparison

| Provider | Cost | Registrars | TLDs | API Key |
|----------|------|------------|------|---------|
| Porkbun (default) | FREE | 1 (Porkbun) | 896 | Not needed |
| TLD-List.com | Paid | 54+ | 3,495 | Required |

**Note:** Porkbun pricing is from a single registrar but is competitive. Use TLD-List.com if you need multi-registrar comparison.

## License

MIT
