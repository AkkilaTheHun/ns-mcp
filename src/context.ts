import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  sessionId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function getCurrentSessionId(): string | undefined {
  return requestContext.getStore()?.sessionId;
}
