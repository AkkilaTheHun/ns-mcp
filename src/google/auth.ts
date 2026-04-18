import { GoogleAuth } from "googleapis-common";
import { BetaAnalyticsDataClient } from "@google-analytics/data";

let cachedAuth: GoogleAuth | undefined;
let cachedAnalyticsClient: BetaAnalyticsDataClient | undefined;

function getServiceAccountKey(): Record<string, string> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY env var not set");
  return JSON.parse(raw) as Record<string, string>;
}

export function getGoogleAuth(): GoogleAuth {
  if (!cachedAuth) {
    const credentials = getServiceAccountKey();
    cachedAuth = new GoogleAuth({
      credentials,
      scopes: [
        "https://www.googleapis.com/auth/analytics.readonly",
        "https://www.googleapis.com/auth/webmasters.readonly",
      ],
    });
  }
  return cachedAuth;
}

export function getAnalyticsClient(): BetaAnalyticsDataClient {
  if (!cachedAnalyticsClient) {
    const credentials = getServiceAccountKey();
    cachedAnalyticsClient = new BetaAnalyticsDataClient({ credentials });
  }
  return cachedAnalyticsClient;
}
