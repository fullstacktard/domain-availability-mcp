import type { ParkingDetection, DomainStatus } from '../types.js';
import { PARKING_PATTERNS } from '../types.js';
import { fetchIPv4 } from '../utils/fetch.js';

// Price detection thresholds
const MIN_DOMAIN_PRICE = 50;        // Domains under $50 are likely unrelated prices
const MAX_DOMAIN_PRICE = 1_000_000; // $1M upper bound for domain prices
const MAX_RESPONSE_SIZE = 1024 * 1024; // 1MB max response size

export interface HttpVerificationResult {
  status: DomainStatus;
  parkingDetection?: ParkingDetection;
  httpStatus?: number;
  redirectUrl?: string;
}

/**
 * HTTP-based verification service for detecting parked domains
 */
export class HttpVerificationService {
  private timeout: number;

  // Block internal/private IP ranges to prevent SSRF
  private readonly blockedPatterns = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^169\.254\./,      // Link-local / cloud metadata
    /^0\./,
    /^\[::1\]/,
    /^::1$/,
    /^fc00:/i,
    /^fd00:/i,
    /^fe80:/i,          // Link-local IPv6
    /metadata\.google/i,
    /\.internal$/i,
  ];

  constructor(timeout: number = 10000) {
    this.timeout = timeout;
  }

  /**
   * Check if a domain is blocked (internal IP, metadata endpoint, etc.)
   */
  private isBlockedDomain(domain: string): boolean {
    return this.blockedPatterns.some(pattern => pattern.test(domain));
  }

  /**
   * Verify a domain via HTTP to detect parking
   */
  async verifyDomain(domain: string): Promise<HttpVerificationResult> {
    // SSRF protection: block internal IPs and metadata endpoints
    if (this.isBlockedDomain(domain)) {
      return { status: 'unknown' };
    }

    // Try HTTPS first, then HTTP
    let result = await this.tryFetch(`https://${domain}`);

    if (result.status === 'unknown') {
      // HTTPS failed, try HTTP
      result = await this.tryFetch(`http://${domain}`);
    }

    return result;
  }

  /**
   * Try to fetch a URL and analyze the response
   * Uses manual redirect handling to prevent SSRF via redirect
   */
  private async tryFetch(url: string, redirectCount = 0): Promise<HttpVerificationResult> {
    // Prevent infinite redirect loops
    const MAX_REDIRECTS = 5;
    if (redirectCount >= MAX_REDIRECTS) {
      return { status: 'unknown' };
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      // Use redirect: 'manual' to validate redirect destinations before following
      const response = await fetchIPv4(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'manual',  // SSRF protection: don't auto-follow redirects
        headers: {
          // Honest User-Agent identifying this tool
          'User-Agent': 'fst-domain-mcp/0.1.0 (domain-availability-checker)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });

      clearTimeout(timeoutId);

      // Handle redirects manually to prevent SSRF
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (location) {
          try {
            // Resolve relative URLs
            const redirectUrl = new URL(location, url);

            // SSRF protection: validate redirect destination
            if (this.isBlockedDomain(redirectUrl.hostname)) {
              return { status: 'unknown' };  // Block SSRF attempt via redirect
            }

            // Check if redirect is to a parking service
            const redirectParkingCheck = this.checkUrlForParking(redirectUrl.toString());
            if (redirectParkingCheck.isParked) {
              return {
                status: 'parked',
                parkingDetection: redirectParkingCheck,
                httpStatus: response.status,
                redirectUrl: redirectUrl.toString(),
              };
            }

            // Follow the validated redirect
            return this.tryFetch(redirectUrl.toString(), redirectCount + 1);
          } catch {
            return { status: 'unknown' };  // Invalid redirect URL
          }
        }
        return { status: 'unknown' };  // Redirect without Location header
      }

      // Analyze response content with size limit
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        const html = await this.readResponseWithLimit(response);
        if (html) {
          const parkingDetection = this.analyzeHtml(html);

          if (parkingDetection.isParked) {
            return {
              status: parkingDetection.broker ? 'for_sale' : 'parked',
              parkingDetection,
              httpStatus: response.status,
            };
          }
        }
      }

      // Has content, not detected as parked - likely a real website
      return {
        status: 'taken',
        httpStatus: response.status,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // DNS errors - domain may be available, but verify with registrar API
      if (
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('EAI_AGAIN') ||
        errorMessage.includes('getaddrinfo')
      ) {
        // Return unknown instead of available - registrar API is authoritative
        return { status: 'unknown' };
      }

      // IPv6 localhost connection refused specifically
      if (errorMessage.includes('ECONNREFUSED') && errorMessage.includes('::1')) {
        return { status: 'unknown' };
      }

      // Connection errors could be various things
      if (
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('ECONNRESET') ||
        errorMessage.includes('abort')
      ) {
        return { status: 'unknown' };
      }

      // SSL errors - domain exists but has SSL issues
      if (
        errorMessage.includes('SSL') ||
        errorMessage.includes('certificate') ||
        errorMessage.includes('CERT')
      ) {
        return { status: 'unknown' };
      }

      return { status: 'unknown' };
    }
  }

  /**
   * Read response body with size limit to prevent memory exhaustion
   */
  private async readResponseWithLimit(response: Response): Promise<string | null> {
    const reader = response.body?.getReader();
    if (!reader) return null;

    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        totalSize += value.length;
        if (totalSize > MAX_RESPONSE_SIZE) {
          reader.cancel();
          // Return what we have so far - enough for parking detection
          break;
        }

        chunks.push(value);
      }

      const concatenated = new Uint8Array(totalSize > MAX_RESPONSE_SIZE ? MAX_RESPONSE_SIZE : totalSize);
      let offset = 0;
      for (const chunk of chunks) {
        if (offset + chunk.length > concatenated.length) {
          concatenated.set(chunk.subarray(0, concatenated.length - offset), offset);
          break;
        }
        concatenated.set(chunk, offset);
        offset += chunk.length;
      }

      return new TextDecoder().decode(concatenated);
    } catch {
      return null;
    }
  }

  /**
   * Check if a URL belongs to a parking service
   */
  private checkUrlForParking(url: string): ParkingDetection {
    const urlLower = url.toLowerCase();
    const indicators: string[] = [];
    let broker: string | undefined;

    for (const [brokerName, patterns] of Object.entries(PARKING_PATTERNS.brokers)) {
      for (const pattern of patterns) {
        if (urlLower.includes(pattern.toLowerCase())) {
          broker = brokerName;
          indicators.push(`URL contains ${pattern}`);
        }
      }
    }

    return {
      isParked: indicators.length > 0,
      broker,
      indicators,
      confidence: indicators.length > 1 ? 'high' : 'medium',
    };
  }

  /**
   * Analyze HTML content for parking indicators
   */
  private analyzeHtml(html: string): ParkingDetection {
    const htmlLower = html.toLowerCase();
    const indicators: string[] = [];
    let broker: string | undefined;
    let estimatedPrice: string | undefined;

    // Check for broker patterns
    for (const [brokerName, patterns] of Object.entries(PARKING_PATTERNS.brokers)) {
      for (const pattern of patterns) {
        if (htmlLower.includes(pattern.toLowerCase())) {
          broker = brokerName;
          indicators.push(`Found "${pattern}" in page`);
        }
      }
    }

    // Check for parking indicators
    for (const indicator of PARKING_PATTERNS.indicators) {
      if (htmlLower.includes(indicator.toLowerCase())) {
        indicators.push(`Found "${indicator}"`);
      }
    }

    // Try to extract price
    const pricePatterns = [
      /\$[\d,]+(?:\.\d{2})?/g,
      /USD\s*[\d,]+(?:\.\d{2})?/gi,
      /€[\d,]+(?:\.\d{2})?/g,
      /EUR\s*[\d,]+(?:\.\d{2})?/gi,
    ];

    for (const pattern of pricePatterns) {
      const matches = html.match(pattern);
      if (matches && matches.length > 0) {
        // Look for prices that seem like domain prices
        for (const match of matches) {
          const numericValue = parseFloat(match.replace(/[^0-9.]/g, ''));
          if (numericValue >= MIN_DOMAIN_PRICE && numericValue <= MAX_DOMAIN_PRICE) {
            estimatedPrice = match;
            indicators.push(`Price detected: ${match}`);
            break;
          }
        }
      }
    }

    // Check for minimal content (parking pages often have little text)
    const textContent = html.replace(/<[^>]*>/g, '').trim();
    const wordCount = textContent.split(/\s+/).length;
    if (wordCount < 50 && indicators.length > 0) {
      indicators.push('Minimal page content');
    }

    // Determine confidence
    let confidence: 'high' | 'medium' | 'low' = 'low';
    if (broker && indicators.length >= 3) {
      confidence = 'high';
    } else if (indicators.length >= 2) {
      confidence = 'medium';
    }

    return {
      isParked: indicators.length >= 2 || broker !== undefined,
      broker,
      indicators,
      estimatedPrice,
      confidence,
    };
  }

  /**
   * Batch verify multiple domains
   */
  async verifyBulk(domains: string[]): Promise<Map<string, HttpVerificationResult>> {
    const results = new Map<string, HttpVerificationResult>();

    // Verify in parallel with concurrency limit
    const concurrency = 5;
    const chunks = this.chunkArray(domains, concurrency);

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(
        chunk.map(async domain => {
          const result = await this.verifyDomain(domain);
          return { domain, result };
        })
      );

      for (const { domain, result } of chunkResults) {
        results.set(domain, result);
      }

      // Small delay between chunks
      await this.delay(200);
    }

    return results;
  }

  /**
   * Chunk array into smaller arrays
   */
  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
