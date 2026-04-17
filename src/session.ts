/**
 * Per-session state. Maps MCP session IDs to their selected shop domain.
 * This allows each connected client to independently select which store to operate on.
 */
const sessionShops = new Map<string, string>();

export function getSessionShop(sessionId: string): string | undefined {
  return sessionShops.get(sessionId);
}

export function setSessionShop(sessionId: string, shopDomain: string): void {
  sessionShops.set(sessionId, shopDomain);
}

export function clearSession(sessionId: string): void {
  sessionShops.delete(sessionId);
}
