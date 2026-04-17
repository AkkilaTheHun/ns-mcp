import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors, toText } from "../../shopify/client.js";

export function registerRedirectTools(server: McpServer): void {
  // --- List URL Redirects ---
  server.tool(
    "list_redirects",
    "List URL redirects with optional filtering and pagination.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of redirects to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      query: z.string().optional().describe("Filter query (e.g. 'path:/old-page', 'target:/new-page')"),
      sortKey: z.enum(["ID", "PATH"]).default("ID"),
      reverse: z.boolean().default(false),
    },
    async ({ first, after, query, sortKey, reverse }) => {
      const res = await shopifyGraphQL<{ urlRedirects: unknown }>(`
        query UrlRedirects($first: Int!, $after: String, $query: String, $sortKey: UrlRedirectSortKeys!, $reverse: Boolean!) {
          urlRedirects(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              cursor
              node {
                id
                path
                target
              }
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              endCursor
              startCursor
            }
          }
        }
      `, { first, after, query, sortKey, reverse });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Get URL Redirect ---
  server.tool(
    "get_redirect",
    "Get a single URL redirect by ID.",
    {
      id: z.string().describe("UrlRedirect GID"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{ urlRedirect: unknown }>(`
        query UrlRedirect($id: ID!) {
          urlRedirect(id: $id) {
            id
            path
            target
          }
        }
      `, { id });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Create URL Redirect ---
  server.tool(
    "create_redirect",
    "Create a URL redirect. Maps an old path to a new target URL.",
    {
      path: z.string().describe("The old path to redirect from (e.g. '/old-page')"),
      target: z.string().describe("The target to redirect to (e.g. '/new-page' or full URL)"),
    },
    async ({ path, target }) => {
      const res = await shopifyGraphQL<{
        urlRedirectCreate: {
          urlRedirect: unknown;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation UrlRedirectCreate($urlRedirect: UrlRedirectInput!) {
          urlRedirectCreate(urlRedirect: $urlRedirect) {
            urlRedirect {
              id
              path
              target
            }
            userErrors { field message }
          }
        }
      `, { urlRedirect: { path, target } });

      throwIfUserErrors(res.data?.urlRedirectCreate?.userErrors, "urlRedirectCreate");
      return { content: [{ type: "text" as const, text: toText(res.data?.urlRedirectCreate?.urlRedirect) }] };
    },
  );

  // --- Update URL Redirect ---
  server.tool(
    "update_redirect",
    "Update an existing URL redirect's path and/or target.",
    {
      id: z.string().describe("UrlRedirect GID"),
      path: z.string().optional().describe("New old path"),
      target: z.string().optional().describe("New target URL"),
    },
    async ({ id, path, target }) => {
      const urlRedirect: Record<string, string> = {};
      if (path) urlRedirect.path = path;
      if (target) urlRedirect.target = target;

      const res = await shopifyGraphQL<{
        urlRedirectUpdate: {
          urlRedirect: unknown;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation UrlRedirectUpdate($id: ID!, $urlRedirect: UrlRedirectInput!) {
          urlRedirectUpdate(id: $id, urlRedirect: $urlRedirect) {
            urlRedirect {
              id
              path
              target
            }
            userErrors { field message }
          }
        }
      `, { id, urlRedirect });

      throwIfUserErrors(res.data?.urlRedirectUpdate?.userErrors, "urlRedirectUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.urlRedirectUpdate?.urlRedirect) }] };
    },
  );

  // --- Delete URL Redirect ---
  server.tool(
    "delete_redirect",
    "Delete a URL redirect by ID.",
    {
      id: z.string().describe("UrlRedirect GID to delete"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        urlRedirectDelete: {
          deletedUrlRedirectId: string;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation UrlRedirectDelete($id: ID!) {
          urlRedirectDelete(id: $id) {
            deletedUrlRedirectId
            userErrors { field message }
          }
        }
      `, { id });

      throwIfUserErrors(res.data?.urlRedirectDelete?.userErrors, "urlRedirectDelete");
      return { content: [{ type: "text" as const, text: `Redirect ${res.data?.urlRedirectDelete?.deletedUrlRedirectId} deleted.` }] };
    },
  );

  // --- Bulk Create URL Redirects ---
  server.tool(
    "bulk_create_redirects",
    "Create multiple URL redirects at once. Processes them sequentially.",
    {
      redirects: z.array(z.object({
        path: z.string().describe("Old path"),
        target: z.string().describe("Target URL"),
      })).describe("Array of redirects to create"),
    },
    async ({ redirects }) => {
      const results: Array<{ path: string; target: string; id?: string; error?: string }> = [];

      for (const redirect of redirects) {
        try {
          const res = await shopifyGraphQL<{
            urlRedirectCreate: {
              urlRedirect: { id: string; path: string; target: string } | null;
              userErrors: Array<{ field: string[]; message: string }>;
            };
          }>(`
            mutation UrlRedirectCreate($urlRedirect: UrlRedirectInput!) {
              urlRedirectCreate(urlRedirect: $urlRedirect) {
                urlRedirect { id path target }
                userErrors { field message }
              }
            }
          `, { urlRedirect: redirect });

          const errors = res.data?.urlRedirectCreate?.userErrors;
          if (errors && errors.length > 0) {
            results.push({ ...redirect, error: errors.map((e) => e.message).join(", ") });
          } else {
            results.push({ ...redirect, id: res.data?.urlRedirectCreate?.urlRedirect?.id });
          }
        } catch (err) {
          results.push({ ...redirect, error: String(err) });
        }
      }

      return { content: [{ type: "text" as const, text: toText(results) }] };
    },
  );

  // --- Bulk Delete URL Redirects by Search ---
  server.tool(
    "bulk_delete_redirects",
    "Bulk delete URL redirects matching a search query.",
    {
      search: z.string().describe("Search query to match redirects for deletion (e.g. 'path:/old-prefix*')"),
    },
    async ({ search }) => {
      const res = await shopifyGraphQL<{
        urlRedirectBulkDeleteBySearch: {
          job: { id: string; done: boolean } | null;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(`
        mutation UrlRedirectBulkDeleteBySearch($search: String!) {
          urlRedirectBulkDeleteBySearch(search: $search) {
            job {
              id
              done
            }
            userErrors { field message }
          }
        }
      `, { search });

      throwIfUserErrors(res.data?.urlRedirectBulkDeleteBySearch?.userErrors, "urlRedirectBulkDeleteBySearch");
      return { content: [{ type: "text" as const, text: toText(res.data?.urlRedirectBulkDeleteBySearch?.job) }] };
    },
  );
}
