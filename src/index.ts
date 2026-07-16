#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import { GraphQLClient } from "graphql-request";
import minimist from "minimist";
import { z } from "zod";

import { createRetryingFetch } from "./lib/retryingFetch.js";
import { ShopifyAuth } from "./lib/shopifyAuth.js";
import { tools } from "./tools/registry.js";
import { createReverseDelivery } from "./tools/createReverseDelivery.js";
import { updateReverseDeliveryShipping } from "./tools/updateReverseDeliveryShipping.js";

// Parse command line arguments
const argv = minimist(process.argv.slice(2));

// Load environment variables from .env file (if it exists)
dotenv.config();

/**
 * Startup self-check: warn (to stderr only — stdout is the MCP protocol channel)
 * if any TypeScript source file is newer than its compiled JS in dist. `dist/`
 * is gitignored, so an edited-but-uncompiled `src` leaves NO git trace and the
 * running tools silently diverge from the source. This guard makes that drift
 * visible at every startup. Non-fatal. No-op when `src/` is absent (e.g. a
 * published npm package that ships only dist).
 *
 * This prevents edited TypeScript sources from being served through stale
 * compiled output when a local build has not been refreshed.
 */
function warnIfBuildStale(): void {
  try {
    const distDir = dirname(fileURLToPath(import.meta.url));
    const srcDir = join(distDir, "..", "src");
    const srcTreeExists = existsSync(srcDir);
    if (!srcTreeExists) {
      return;
    }

    const staleFiles: string[] = [];

    const collectStaleUnder = (dir: string): void => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          collectStaleUnder(srcPath);
          continue;
        }

        const isCompilableSource =
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".d.ts") &&
          !entry.name.endsWith(".test.ts");
        if (!isCompilableSource) {
          continue;
        }

        const relativeSourcePath = relative(srcDir, srcPath);
        const expectedJsRelative = relativeSourcePath.replace(/\.ts$/, ".js");
        const expectedJsPath = join(distDir, expectedJsRelative);

        const compiledJsMissing = !existsSync(expectedJsPath);
        if (compiledJsMissing) {
          staleFiles.push(`${relativeSourcePath} (no compiled .js)`);
          continue;
        }

        const sourceModifiedMs = statSync(srcPath).mtimeMs;
        const compiledModifiedMs = statSync(expectedJsPath).mtimeMs;
        const sourceIsNewer = sourceModifiedMs > compiledModifiedMs;
        if (sourceIsNewer) {
          staleFiles.push(relativeSourcePath);
        }
      }
    };

    collectStaleUnder(srcDir);

    if (staleFiles.length === 0) {
      return;
    }

    const projectRoot = join(distDir, "..");
    const separator = "=".repeat(72);
    console.error(separator);
    console.error("[shopify-mcp] WARNING: compiled dist is STALE — src is newer than dist.");
    console.error("[shopify-mcp] The running tools may NOT match the edited source. Rebuild with:");
    console.error(`[shopify-mcp]   cd ${projectRoot} && npm run build`);
    console.error("[shopify-mcp] Stale file(s):");
    for (const staleFile of staleFiles) {
      console.error(`[shopify-mcp]   - ${staleFile}`);
    }
    console.error(separator);
  } catch {
    // A self-check must never break server startup.
  }
}

warnIfBuildStale();

// Define environment variables - from command line or .env file
const SHOPIFY_ACCESS_TOKEN =
  argv.accessToken || process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_CLIENT_ID =
  argv.clientId || process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET =
  argv.clientSecret || process.env.SHOPIFY_CLIENT_SECRET;
const MYSHOPIFY_DOMAIN = argv.domain || process.env.MYSHOPIFY_DOMAIN;

const useClientCredentials = !!(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET);

// Store in process.env for backwards compatibility
process.env.MYSHOPIFY_DOMAIN = MYSHOPIFY_DOMAIN;

// Validate required environment variables
if (!SHOPIFY_ACCESS_TOKEN && !useClientCredentials) {
  console.error("Error: Authentication credentials are required.");
  console.error("");
  console.error("Option 1 — Static access token (legacy apps):");
  console.error("  --accessToken=shpat_xxxxx");
  console.error("");
  console.error("Option 2 — Client credentials (Dev Dashboard apps, Jan 2026+):");
  console.error("  --clientId=your_client_id --clientSecret=your_client_secret");
  process.exit(1);
}

if (!MYSHOPIFY_DOMAIN) {
  console.error("Error: MYSHOPIFY_DOMAIN is required.");
  console.error("Please provide it via command line argument or .env file.");
  console.error("  Command line: --domain=your-store.myshopify.com");
  process.exit(1);
}

// Resolve access token (client credentials or static)
let accessToken: string;
let auth: ShopifyAuth | null = null;

if (useClientCredentials) {
  auth = new ShopifyAuth({
    clientId: SHOPIFY_CLIENT_ID!,
    clientSecret: SHOPIFY_CLIENT_SECRET!,
    shopDomain: MYSHOPIFY_DOMAIN,
  });
  accessToken = await auth.initialize();
} else {
  accessToken = SHOPIFY_ACCESS_TOKEN!;
}

process.env.SHOPIFY_ACCESS_TOKEN = accessToken;

// Create Shopify GraphQL client
const API_VERSION = argv.apiVersion || process.env.SHOPIFY_API_VERSION || "2026-01";

// Wrap the platform fetch with transient-fault retries. Shopify's Cloudflare
// edge intermittently returns an app-level 404 for valid requests from this
// host; the same request succeeds on retry. Without this, a single transient
// 404 fails the whole tool call. See lib/retryingFetch.ts for the full rationale.
const retryingFetch = createRetryingFetch(globalThis.fetch, {
  label: "shopify-mcp"
});

const shopifyClient = new GraphQLClient(
  `https://${MYSHOPIFY_DOMAIN}/admin/api/${API_VERSION}/graphql.json`,
  {
    fetch: retryingFetch,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json"
    }
  }
);

// Let the auth manager hot-swap the token header on refresh
if (auth) {
  auth.setGraphQLClient(shopifyClient);
}

// Create a separate client with 2024-07 API version for newer mutations
// (reverseDeliveryCreateWithShipping requires 2024-01+)
const shopifyClient202407 = new GraphQLClient(
  `https://${MYSHOPIFY_DOMAIN}/admin/api/2024-07/graphql.json`,
  {
    fetch: retryingFetch,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json"
    }
  }
);

// Initialize all registry tools with the shared GraphQL client
for (const tool of tools) {
  tool.initialize(shopifyClient);
}

// Initialize createReverseDelivery with the 2024-07 client (needs newer API)
createReverseDelivery.initialize(shopifyClient202407);
updateReverseDeliveryShipping.initialize(shopifyClient202407);

// Set up MCP server
const server = new McpServer({
  name: "shopify",
  version: "1.0.0",
  description:
    "MCP Server for Shopify API, enabling interaction with store data through GraphQL API"
});

// Register all registry tools with the MCP server
for (const tool of tools) {
  server.tool(
    tool.name,
    tool.schema.shape,
    async (args) => {
      const result = await tool.execute(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    }
  );
}

// Register createReverseDelivery separately (uses 2024-07 API client)
server.tool(
  createReverseDelivery.name,
  createReverseDelivery.schema.shape,
  async (args) => {
    const result = await createReverseDelivery.execute(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  }
);

// Add the updateReverseDeliveryShipping tool
server.tool(
  "update-reverse-delivery-shipping",
  {
    reverseDeliveryId: z.string().min(1).describe("Reverse delivery GID (gid://shopify/ReverseDelivery/...)"),
    trackingNumber: z.string().min(1).describe("New tracking number"),
    trackingCompany: z.string().default("UPS").describe("Carrier name"),
    trackingUrl: z.string().optional().describe("Tracking URL (auto-generated for UPS if omitted)"),
    labelUrl: z.string().optional().describe("URL of the return label image (PNG/PDF)"),
    notifyCustomer: z.boolean().default(false).describe("Send notification email to customer"),
  },
  async (args) => {
    const result = await updateReverseDeliveryShipping.execute(args);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }]
    };
  }
);

// Start the server
const transport = new StdioServerTransport();
server
  .connect(transport)
  .then(() => {})
  .catch((error: unknown) => {
    console.error("Failed to start Shopify MCP Server:", error);
  });
