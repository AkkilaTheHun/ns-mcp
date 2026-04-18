import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getAnalyticsClient, getGoogleAuth } from "../google/auth.js";
import { google } from "googleapis";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
function text(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function fail(msg: string): ToolResult {
  return { content: [{ type: "text", text: msg }], isError: true };
}

// ============================================================
// GOOGLE ANALYTICS (GA4 Data API)
// ============================================================

export function registerAnalyticsGateway(server: McpServer): void {
  server.tool(
    "google_analytics",
    `Google Analytics (GA4). Actions:
- list_properties: List accessible GA4 properties
- run_report: Run a report (params: propertyId, startDate, endDate, metrics[], dimensions?[], limit?)
- get_realtime: Get realtime data (params: propertyId, metrics[], dimensions?[])

Common metrics: sessions, totalUsers, newUsers, activeUsers, screenPageViews, conversions, eventCount, averageSessionDuration, bounceRate, engagementRate
Common dimensions: date, country, city, deviceCategory, sessionSource, sessionMedium, pagePath, pageTitle, landingPage, browser`,
    {
      action: z.enum(["list_properties", "run_report", "get_realtime"]),
      propertyId: z.string().optional().describe("GA4 property ID (e.g. '123456789')"),
      startDate: z.string().optional().describe("Start date (YYYY-MM-DD, or 'today', '7daysAgo', '30daysAgo')"),
      endDate: z.string().optional().describe("End date (YYYY-MM-DD, or 'today', 'yesterday')"),
      metrics: z.array(z.string()).optional().describe("Metrics to fetch"),
      dimensions: z.array(z.string()).optional().describe("Dimensions to group by"),
      limit: z.number().optional().describe("Max rows (default 100)"),
      orderBy: z.string().optional().describe("Metric or dimension name to sort by"),
      descending: z.boolean().optional().describe("Sort descending (default true)"),
    },
    async ({ action, propertyId, startDate, endDate, metrics, dimensions, limit, orderBy, descending }) => {
      try {
        if (action === "list_properties") {
          const auth = getGoogleAuth();
          const analyticsAdmin = google.analyticsadmin({ version: "v1beta", auth });
          const res = await analyticsAdmin.properties.list({
            filter: "parent:accounts/-",
            pageSize: 50,
          });
          const properties = (res.data.properties ?? []).map(p => ({
            propertyId: p.name?.replace("properties/", ""),
            displayName: p.displayName,
            timeZone: p.timeZone,
            currencyCode: p.currencyCode,
            industryCategory: p.industryCategory,
            createTime: p.createTime,
          }));
          return properties.length ? text(properties) : fail("No GA4 properties accessible by this service account.");
        }

        if (action === "run_report") {
          if (!propertyId) return fail("propertyId required");
          if (!startDate || !endDate) return fail("startDate and endDate required");
          if (!metrics?.length) return fail("At least one metric required");

          const client = getAnalyticsClient();
          const [response] = await client.runReport({
            property: `properties/${propertyId}`,
            dateRanges: [{ startDate, endDate }],
            metrics: metrics.map(name => ({ name })),
            dimensions: dimensions?.map(name => ({ name })),
            limit: limit ?? 100,
            orderBys: orderBy ? [{
              metric: metrics.includes(orderBy) ? { metricName: orderBy } : undefined,
              dimension: !metrics.includes(orderBy) ? { dimensionName: orderBy } : undefined,
              desc: descending ?? true,
            }] : undefined,
          });

          const dimHeaders = response.dimensionHeaders?.map(h => h.name) ?? [];
          const metHeaders = response.metricHeaders?.map(h => h.name) ?? [];
          const rows = (response.rows ?? []).map(row => {
            const obj: Record<string, string> = {};
            row.dimensionValues?.forEach((v, i) => { obj[dimHeaders[i]!] = v.value ?? ""; });
            row.metricValues?.forEach((v, i) => { obj[metHeaders[i]!] = v.value ?? ""; });
            return obj;
          });

          return text({
            rowCount: response.rowCount,
            rows,
            totals: response.totals?.map(row => {
              const obj: Record<string, string> = {};
              row.metricValues?.forEach((v, i) => { obj[metHeaders[i]!] = v.value ?? ""; });
              return obj;
            }),
          });
        }

        if (action === "get_realtime") {
          if (!propertyId) return fail("propertyId required");
          if (!metrics?.length) return fail("At least one metric required");

          const client = getAnalyticsClient();
          const [response] = await client.runRealtimeReport({
            property: `properties/${propertyId}`,
            metrics: metrics.map(name => ({ name })),
            dimensions: dimensions?.map(name => ({ name })),
            limit: limit ?? 100,
          });

          const dimHeaders = response.dimensionHeaders?.map(h => h.name) ?? [];
          const metHeaders = response.metricHeaders?.map(h => h.name) ?? [];
          const rows = (response.rows ?? []).map(row => {
            const obj: Record<string, string> = {};
            row.dimensionValues?.forEach((v, i) => { obj[dimHeaders[i]!] = v.value ?? ""; });
            row.metricValues?.forEach((v, i) => { obj[metHeaders[i]!] = v.value ?? ""; });
            return obj;
          });

          return text({ rowCount: response.rowCount, rows });
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Google Analytics error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}

// ============================================================
// GOOGLE SEARCH CONSOLE
// ============================================================

export function registerSearchConsoleGateway(server: McpServer): void {
  server.tool(
    "google_search_console",
    `Google Search Console. Actions:
- list_sites: List verified sites/properties
- query: Search performance data (params: siteUrl, startDate, endDate, dimensions?[], type?, rowLimit?)
- inspect_url: Inspect a URL's index status (params: siteUrl, inspectionUrl)
- list_sitemaps: List sitemaps (params: siteUrl)

dimensions: query, page, country, device, date, searchAppearance
type: web, image, video, news, discover, googleNews`,
    {
      action: z.enum(["list_sites", "query", "inspect_url", "list_sitemaps"]),
      siteUrl: z.string().optional().describe("Site URL (e.g. 'https://nailstuff.ca' or 'sc-domain:nailstuff.ca')"),
      startDate: z.string().optional().describe("Start date (YYYY-MM-DD)"),
      endDate: z.string().optional().describe("End date (YYYY-MM-DD)"),
      dimensions: z.array(z.string()).optional().describe("Dimensions to group by"),
      type: z.string().optional().describe("Search type filter"),
      rowLimit: z.number().optional().describe("Max rows (default 100, max 25000)"),
      inspectionUrl: z.string().optional().describe("Full URL to inspect"),
      dimensionFilterGroups: z.array(z.object({
        dimension: z.string(),
        operator: z.string().optional(),
        expression: z.string(),
      })).optional().describe("Filters (e.g. [{dimension:'page',operator:'contains',expression:'/products/'}])"),
    },
    async ({ action, siteUrl, startDate, endDate, dimensions, type, rowLimit, inspectionUrl, dimensionFilterGroups }) => {
      try {
        const auth = getGoogleAuth();
        const searchconsole = google.searchconsole({ version: "v1", auth });

        if (action === "list_sites") {
          const res = await searchconsole.sites.list();
          const sites = (res.data.siteEntry ?? []).map(s => ({
            siteUrl: s.siteUrl,
            permissionLevel: s.permissionLevel,
          }));
          return sites.length ? text(sites) : fail("No sites accessible by this service account. Add ns-datafeed@ns-datafeed.iam.gserviceaccount.com as a user in Search Console.");
        }

        if (action === "query") {
          if (!siteUrl) return fail("siteUrl required");
          if (!startDate || !endDate) return fail("startDate and endDate required");

          const res = await searchconsole.searchanalytics.query({
            siteUrl,
            requestBody: {
              startDate,
              endDate,
              dimensions: dimensions ?? ["query"],
              type: type ?? "web",
              rowLimit: rowLimit ?? 100,
              dimensionFilterGroups: dimensionFilterGroups?.length ? [{
                filters: dimensionFilterGroups.map(f => ({
                  dimension: f.dimension,
                  operator: f.operator ?? "contains",
                  expression: f.expression,
                })),
              }] : undefined,
            },
          });

          const rows = (res.data.rows ?? []).map(row => ({
            keys: row.keys,
            clicks: row.clicks,
            impressions: row.impressions,
            ctr: row.ctr ? (row.ctr * 100).toFixed(2) + "%" : undefined,
            position: row.position?.toFixed(1),
          }));

          return text({
            rowCount: rows.length,
            rows,
            responseAggregationType: res.data.responseAggregationType,
          });
        }

        if (action === "inspect_url") {
          if (!siteUrl || !inspectionUrl) return fail("siteUrl and inspectionUrl required");

          const res = await searchconsole.urlInspection.index.inspect({
            requestBody: {
              inspectionUrl,
              siteUrl,
            },
          });

          const result = res.data.inspectionResult;
          return text({
            indexStatus: result?.indexStatusResult,
            mobileUsability: result?.mobileUsabilityResult,
            richResults: result?.richResultsResult,
          });
        }

        if (action === "list_sitemaps") {
          if (!siteUrl) return fail("siteUrl required");
          const res = await searchconsole.sitemaps.list({ siteUrl });
          const sitemaps = (res.data.sitemap ?? []).map(s => ({
            path: s.path,
            lastSubmitted: s.lastSubmitted,
            lastDownloaded: s.lastDownloaded,
            isPending: s.isPending,
            warnings: s.warnings,
            errors: s.errors,
            contents: s.contents,
          }));
          return text(sitemaps);
        }

        return fail(`Unknown action: ${action}`);
      } catch (err) {
        return fail(`Search Console error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
