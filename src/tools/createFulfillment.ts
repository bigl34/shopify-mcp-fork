import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";

// Input schema for createFulfillment
const CreateFulfillmentInputSchema = z.object({
  orderNumber: z.string().min(1).describe("Order number (e.g., '1234' or '#1234')"),
  trackingNumber: z.string().min(1).describe("Tracking number"),
  trackingCompany: z.string().default("UPS").describe("Carrier name"),
  trackingUrl: z.string().optional().describe("Tracking URL (auto-generated for UPS if omitted)"),
  notifyCustomer: z.boolean().default(false).describe("Send notification email to customer"),
  lineItems: z.array(z.object({
    sku: z.string().describe("SKU of the item to fulfill"),
    quantity: z.number().int().positive().describe("Quantity to fulfill"),
  })).optional().describe("Specific items to fulfill (omit to fulfill all remaining items)"),
});

type CreateFulfillmentInput = z.infer<typeof CreateFulfillmentInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const FIND_ORDER_QUERY = gql`
  query FindOrderForFulfillment($query: String!) {
    orders(first: 3, sortKey: PROCESSED_AT, reverse: true, query: $query) {
      edges {
        node {
          id
          name
          displayFulfillmentStatus
          fulfillmentOrders(first: 10) {
            edges {
              node {
                id
                status
                supportedActions { action }
                lineItems(first: 50) {
                  edges {
                    node {
                      id
                      remainingQuantity
                      lineItem {
                        sku
                        title
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = gql`
  mutation fulfillmentCreateV2($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
        trackingInfo {
          company
          number
          url
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const createFulfillment = {
  name: "create-fulfillment",
  description: "Create a fulfillment with tracking for a Shopify order",
  schema: CreateFulfillmentInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: CreateFulfillmentInput) => {
    try {
      const { orderNumber, trackingNumber, trackingCompany, trackingUrl, notifyCustomer, lineItems } = input;

      // Step 1: Normalize order number and find the order
      const cleanNumber = orderNumber.replace(/^#?\D*/i, "") || orderNumber.replace(/^#/, "");
      const queryStr = `name:#${cleanNumber}`;

      const data = (await shopifyClient.request(FIND_ORDER_QUERY, { query: queryStr })) as {
        orders: { edges: Array<{ node: any }> };
      };

      if (!data.orders.edges.length) {
        throw new Error(`Order #${cleanNumber} not found`);
      }

      // Match order name ending with the clean number (handles any store prefix)
      const orderNode = data.orders.edges.find(
        (e) => e.node.name.endsWith(cleanNumber)
      )?.node || data.orders.edges[0].node;

      // Step 2: Filter fulfillment orders to eligible ones
      const fulfillmentOrders = orderNode.fulfillmentOrders.edges.map((e: any) => e.node);
      const skippedReasons: string[] = [];
      const eligible: any[] = [];

      for (const fo of fulfillmentOrders) {
        const actions = (fo.supportedActions || []).map((a: any) => a.action);
        if (actions.includes("CREATE_FULFILLMENT")) {
          eligible.push(fo);
        } else if (fo.status === "ON_HOLD") {
          skippedReasons.push(`Fulfillment order ${fo.id} is on hold — release hold in Shopify first`);
        } else if (fo.status === "SCHEDULED") {
          skippedReasons.push(`Fulfillment order ${fo.id} is scheduled — not yet eligible`);
        }
        // CLOSED/CANCELLED — skip silently
      }

      if (eligible.length === 0) {
        return {
          alreadyFulfilled: true,
          message: skippedReasons.length > 0
            ? `No eligible fulfillment orders. ${skippedReasons.join(". ")}`
            : "Order already fulfilled",
          orderName: orderNode.name,
        };
      }

      // Step 3: Build tracking info
      let resolvedTrackingUrl = trackingUrl;
      if (!resolvedTrackingUrl && trackingCompany.toUpperCase() === "UPS") {
        resolvedTrackingUrl = `https://www.ups.com/track?tracknum=${trackingNumber}`;
      }

      const trackingInfo: { company: string; number: string; url?: string } = {
        company: trackingCompany,
        number: trackingNumber,
      };
      if (resolvedTrackingUrl) {
        trackingInfo.url = resolvedTrackingUrl;
      }

      // Step 4: Create fulfillment for each eligible fulfillment order
      const fulfillments: any[] = [];
      let isPartial = false;

      for (const fo of eligible) {
        const foLineItems = fo.lineItems.edges.map((e: any) => e.node);

        // Build the fulfillment order entry
        const entry: any = {
          fulfillmentOrderId: fo.id,
        };

        if (lineItems && lineItems.length > 0) {
          // Specific items requested — match by SKU
          const matchedLineItems: Array<{ id: string; quantity: number }> = [];

          for (const requested of lineItems) {
            const foItem = foLineItems.find(
              (item: any) => item.lineItem?.sku === requested.sku
            );
            if (!foItem) continue; // SKU not in this fulfillment order — try next FO
            if (requested.quantity > foItem.remainingQuantity) {
              throw new Error(
                `Requested quantity ${requested.quantity} for SKU ${requested.sku} exceeds remaining quantity ${foItem.remainingQuantity}`
              );
            }
            matchedLineItems.push({
              id: foItem.id,
              quantity: requested.quantity,
            });
          }

          if (matchedLineItems.length === 0) continue; // No matching items in this FO

          entry.fulfillmentOrderLineItems = matchedLineItems;
          isPartial = true;
        }
        // If lineItems omitted → omit fulfillmentOrderLineItems (fulfills all remaining)

        const variables = {
          fulfillment: {
            lineItemsByFulfillmentOrder: [entry],
            trackingInfo,
            notifyCustomer,
          },
        };

        const result = (await shopifyClient.request(FULFILLMENT_CREATE_MUTATION, variables)) as {
          fulfillmentCreateV2: {
            fulfillment: any;
            userErrors: Array<{ field: string[]; message: string }>;
          };
        };

        const mutationResult = result.fulfillmentCreateV2;

        if (mutationResult.userErrors && mutationResult.userErrors.length > 0) {
          const errorMessages = mutationResult.userErrors
            .map((e) => `${e.field?.join(".") || "unknown"}: ${e.message}`)
            .join("; ");
          throw new Error(`Shopify API errors: ${errorMessages}`);
        }

        if (mutationResult.fulfillment) {
          fulfillments.push({
            id: mutationResult.fulfillment.id,
            status: mutationResult.fulfillment.status,
            trackingInfo: (mutationResult.fulfillment.trackingInfo || []).map((t: any) => ({
              company: t.company,
              number: t.number,
              url: t.url,
            })),
          });
        }
      }

      if (fulfillments.length === 0) {
        // lineItems were specified but none matched any eligible FO
        if (lineItems && lineItems.length > 0) {
          const requestedSkus = lineItems.map((i) => i.sku).join(", ");
          throw new Error(`No matching items found for SKUs: ${requestedSkus}`);
        }
        return {
          alreadyFulfilled: true,
          message: "No items to fulfill",
          orderName: orderNode.name,
        };
      }

      return {
        fulfillments,
        orderName: orderNode.name,
        notificationSent: notifyCustomer,
        partial: isPartial,
      };
    } catch (error) {
      console.error("Error creating fulfillment:", error);
      throw new Error(
        `Failed to create fulfillment: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  },
};

export { createFulfillment };
