/**
 * IPv4-safe fetch wrapper
 *
 * Works around Node.js fetch() issues in Docker containers where IPv6 connections
 * fail or timeout. Uses undici with explicit IPv4 lookup configuration.
 */
import { Agent, fetch as undiciFetch, type RequestInit } from 'undici';

// Create an agent that forces IPv4 connections
const ipv4Agent = new Agent({
  connect: {
    // Force IPv4 only - fixes Docker/WSL2 IPv6 connection issues
    family: 4,
    // Increase timeout for slow APIs like Porkbun
    timeout: 60000,
  },
});

/**
 * Fetch wrapper that enforces IPv4 connections.
 * Drop-in replacement for global fetch() with same signature.
 */
export async function fetchIPv4(
  url: string | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await undiciFetch(url, {
    ...init,
    dispatcher: ipv4Agent,
  });

  // Cast to standard Response type for compatibility
  return response as unknown as Response;
}

/**
 * Re-export for convenience
 */
export { fetchIPv4 as fetch };
