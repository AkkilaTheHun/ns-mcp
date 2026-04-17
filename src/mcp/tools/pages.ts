import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { shopifyGraphQL, throwIfUserErrors, toText } from "../../shopify/client.js";

const PAGE_SUMMARY_FIELDS = `
  id
  title
  handle
  body
  isPublished
  publishedAt
  templateSuffix
  createdAt
  updatedAt
`;

const PAGE_FIELDS = `
  id
  title
  handle
  body
  isPublished
  publishedAt
  templateSuffix
  createdAt
  updatedAt
  metafields(first: 25) {
    edges {
      node {
        id
        namespace
        key
        value
        type
      }
    }
  }
`;

const BLOG_SUMMARY_FIELDS = `
  id
  title
  handle
  templateSuffix
  commentPolicy
  createdAt
  updatedAt
`;

const ARTICLE_SUMMARY_FIELDS = `
  id
  title
  handle
  body
  summary
  tags
  author { name }
  blog { id title }
  isPublished
  publishedAt
  createdAt
  updatedAt
  image { altText url }
`;

const ARTICLE_FIELDS = `
  id
  title
  handle
  body
  summary
  tags
  author { name }
  blog { id title }
  isPublished
  publishedAt
  templateSuffix
  createdAt
  updatedAt
  image { altText url }
`;

export function registerPageTools(server: McpServer): void {
  // --- List Pages ---
  server.tool(
    "list_pages",
    "List online store pages with optional filtering, sorting, and pagination.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of pages to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      query: z.string().optional().describe("Search query (e.g. 'title:About', 'published_status:published')"),
      sortKey: z.enum(["ID", "TITLE", "UPDATED_AT", "PUBLISHED_AT", "RELEVANCE"]).default("UPDATED_AT"),
      reverse: z.boolean().default(false),
    },
    async ({ first, after, query, sortKey, reverse }) => {
      const res = await shopifyGraphQL<{ pages: unknown }>(`
        query Pages($first: Int!, $after: String, $query: String, $sortKey: PageSortKeys!, $reverse: Boolean!) {
          pages(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              cursor
              node { ${PAGE_SUMMARY_FIELDS} }
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

  // --- Get Page ---
  server.tool(
    "get_page",
    "Get full details of a single online store page by ID.",
    {
      id: z.string().describe("Page GID (e.g. gid://shopify/Page/123)"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL(`
        query GetPage($id: ID!) {
          page(id: $id) { ${PAGE_FIELDS} }
        }
      `, { id });

      return { content: [{ type: "text" as const, text: toText(res.data) }] };
    },
  );

  // --- Create Page ---
  server.tool(
    "create_page",
    "Create a new online store page.",
    {
      title: z.string().describe("Page title"),
      body: z.string().optional().describe("Page body HTML content"),
      handle: z.string().optional().describe("URL handle"),
      isPublished: z.boolean().optional().describe("Whether the page is published"),
      templateSuffix: z.string().optional().describe("Template suffix for the page"),
      metafields: z.array(z.object({
        namespace: z.string(),
        key: z.string(),
        value: z.string(),
        type: z.string(),
      })).optional(),
    },
    async ({ title, body, handle, isPublished, templateSuffix, metafields }) => {
      const page: Record<string, unknown> = { title };
      if (body !== undefined) page.body = body;
      if (handle !== undefined) page.handle = handle;
      if (isPublished !== undefined) page.isPublished = isPublished;
      if (templateSuffix !== undefined) page.templateSuffix = templateSuffix;
      if (metafields !== undefined) page.metafields = metafields;

      const res = await shopifyGraphQL<{
        pageCreate: { page: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation PageCreate($page: PageCreateInput!) {
          pageCreate(page: $page) {
            page { ${PAGE_SUMMARY_FIELDS} }
            userErrors { code field message }
          }
        }
      `, { page });

      throwIfUserErrors(res.data?.pageCreate?.userErrors, "pageCreate");
      return { content: [{ type: "text" as const, text: toText(res.data?.pageCreate?.page) }] };
    },
  );

  // --- Update Page ---
  server.tool(
    "update_page",
    "Update an existing online store page.",
    {
      id: z.string().describe("Page GID"),
      title: z.string().optional(),
      body: z.string().optional().describe("Page body HTML content"),
      handle: z.string().optional(),
      isPublished: z.boolean().optional(),
      templateSuffix: z.string().optional(),
    },
    async ({ id, ...fields }) => {
      const page: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) page[k] = v;
      }

      const res = await shopifyGraphQL<{
        pageUpdate: { page: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation PageUpdate($id: ID!, $page: PageUpdateInput!) {
          pageUpdate(id: $id, page: $page) {
            page { ${PAGE_SUMMARY_FIELDS} }
            userErrors { code field message }
          }
        }
      `, { id, page });

      throwIfUserErrors(res.data?.pageUpdate?.userErrors, "pageUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.pageUpdate?.page) }] };
    },
  );

  // --- Delete Page ---
  server.tool(
    "delete_page",
    "Delete an online store page.",
    {
      id: z.string().describe("Page GID to delete"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        pageDelete: { deletedPageId: string; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation PageDelete($id: ID!) {
          pageDelete(id: $id) {
            deletedPageId
            userErrors { code field message }
          }
        }
      `, { id });

      throwIfUserErrors(res.data?.pageDelete?.userErrors, "pageDelete");
      return { content: [{ type: "text" as const, text: `Page ${res.data?.pageDelete?.deletedPageId} deleted.` }] };
    },
  );

  // --- List Blogs ---
  server.tool(
    "list_blogs",
    "List blogs with optional filtering, sorting, and pagination.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of blogs to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      query: z.string().optional().describe("Search query (e.g. 'title:News')"),
      sortKey: z.enum(["ID", "TITLE", "RELEVANCE"]).default("ID"),
      reverse: z.boolean().default(false),
    },
    async ({ first, after, query, sortKey, reverse }) => {
      const res = await shopifyGraphQL<{ blogs: unknown }>(`
        query Blogs($first: Int!, $after: String, $query: String, $sortKey: BlogSortKeys!, $reverse: Boolean!) {
          blogs(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              cursor
              node { ${BLOG_SUMMARY_FIELDS} }
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

  // --- List Articles ---
  server.tool(
    "list_articles",
    "List blog articles with optional filtering, sorting, and pagination.",
    {
      first: z.number().min(1).max(250).default(50).describe("Number of articles to return"),
      after: z.string().optional().describe("Cursor for pagination"),
      query: z.string().optional().describe("Search query (e.g. 'blog_title:News', 'tag:featured', 'author:John')"),
      sortKey: z.enum(["ID", "TITLE", "UPDATED_AT", "PUBLISHED_AT", "AUTHOR", "BLOG_TITLE", "RELEVANCE"]).default("UPDATED_AT"),
      reverse: z.boolean().default(false),
    },
    async ({ first, after, query, sortKey, reverse }) => {
      const res = await shopifyGraphQL<{ articles: unknown }>(`
        query Articles($first: Int!, $after: String, $query: String, $sortKey: ArticleSortKeys!, $reverse: Boolean!) {
          articles(first: $first, after: $after, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              cursor
              node { ${ARTICLE_SUMMARY_FIELDS} }
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

  // --- Create Article ---
  server.tool(
    "create_article",
    "Create a new blog article.",
    {
      blogId: z.string().describe("Blog GID the article belongs to (e.g. gid://shopify/Blog/123)"),
      title: z.string().describe("Article title"),
      body: z.string().optional().describe("Article body HTML"),
      summary: z.string().optional().describe("Article summary/excerpt"),
      handle: z.string().optional().describe("URL handle"),
      author: z.object({ name: z.string() }).optional().describe("Author info"),
      tags: z.array(z.string()).optional().describe("Tags"),
      isPublished: z.boolean().optional().describe("Whether the article is published"),
      publishDate: z.string().optional().describe("ISO 8601 publish date"),
      image: z.object({
        altText: z.string().optional(),
        url: z.string().describe("Image URL"),
      }).optional().describe("Article image"),
    },
    async ({ blogId, title, body, summary, handle, author, tags, isPublished, publishDate, image }) => {
      const article: Record<string, unknown> = { blogId, title };
      if (body !== undefined) article.body = body;
      if (summary !== undefined) article.summary = summary;
      if (handle !== undefined) article.handle = handle;
      if (author !== undefined) article.author = author;
      if (tags !== undefined) article.tags = tags;
      if (isPublished !== undefined) article.isPublished = isPublished;
      if (publishDate !== undefined) article.publishDate = publishDate;
      if (image !== undefined) article.image = image;

      const res = await shopifyGraphQL<{
        articleCreate: { article: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation ArticleCreate($article: ArticleCreateInput!) {
          articleCreate(article: $article) {
            article { ${ARTICLE_FIELDS} }
            userErrors { code field message }
          }
        }
      `, { article });

      throwIfUserErrors(res.data?.articleCreate?.userErrors, "articleCreate");
      return { content: [{ type: "text" as const, text: toText(res.data?.articleCreate?.article) }] };
    },
  );

  // --- Update Article ---
  server.tool(
    "update_article",
    "Update an existing blog article.",
    {
      id: z.string().describe("Article GID"),
      title: z.string().optional(),
      body: z.string().optional().describe("Article body HTML"),
      summary: z.string().optional(),
      handle: z.string().optional(),
      author: z.object({ name: z.string() }).optional(),
      tags: z.array(z.string()).optional(),
      isPublished: z.boolean().optional(),
      publishDate: z.string().optional().describe("ISO 8601 publish date"),
      image: z.object({
        altText: z.string().optional(),
        url: z.string().describe("Image URL"),
      }).optional(),
      redirectNewHandle: z.boolean().optional().describe("Create redirect from old handle to new"),
    },
    async ({ id, redirectNewHandle, ...fields }) => {
      const article: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(fields)) {
        if (v !== undefined) article[k] = v;
      }
      if (redirectNewHandle !== undefined) article.redirectNewHandle = redirectNewHandle;

      const res = await shopifyGraphQL<{
        articleUpdate: { article: unknown; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation ArticleUpdate($id: ID!, $article: ArticleUpdateInput!) {
          articleUpdate(id: $id, article: $article) {
            article { ${ARTICLE_FIELDS} }
            userErrors { code field message }
          }
        }
      `, { id, article });

      throwIfUserErrors(res.data?.articleUpdate?.userErrors, "articleUpdate");
      return { content: [{ type: "text" as const, text: toText(res.data?.articleUpdate?.article) }] };
    },
  );

  // --- Delete Article ---
  server.tool(
    "delete_article",
    "Delete a blog article.",
    {
      id: z.string().describe("Article GID to delete"),
    },
    async ({ id }) => {
      const res = await shopifyGraphQL<{
        articleDelete: { deletedArticleId: string; userErrors: Array<{ field: string[]; message: string }> };
      }>(`
        mutation ArticleDelete($id: ID!) {
          articleDelete(id: $id) {
            deletedArticleId
            userErrors { code field message }
          }
        }
      `, { id });

      throwIfUserErrors(res.data?.articleDelete?.userErrors, "articleDelete");
      return { content: [{ type: "text" as const, text: `Article ${res.data?.articleDelete?.deletedArticleId} deleted.` }] };
    },
  );
}
