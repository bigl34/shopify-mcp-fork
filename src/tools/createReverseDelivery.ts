import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";

const CreateReverseDeliveryInputSchema = z.object({
  returnId: z.string().min(1).describe("Return GID (gid://shopify/Return/...)"),
  trackingNumber: z.string().min(1).describe("Tracking number for the return shipment"),
  trackingCompany: z.string().default("UPS").describe("Carrier name"),
  trackingUrl: z.string().optional().describe("Tracking URL (auto-generated for UPS if omitted)"),
  labelUrl: z.string().optional().describe("URL of the return label image (PNG/PDF) for Shopify to ingest"),
});

type CreateReverseDeliveryInput = z.infer<typeof CreateReverseDeliveryInputSchema>;

// Uses a separate client with 2024-07 API version
let shopifyClient: GraphQLClient;

const GET_RETURN_LINE_ITEMS_QUERY = gql`
  query GetReturnLineItems($returnId: ID!) {
    return(id: $returnId) {
      id
      status
      returnLineItems(first: 50) {
        edges {
          node {
            id
            quantity
            fulfillmentLineItem {
              id
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
`;

const REVERSE_DELIVERY_CREATE_MUTATION = gql`
  mutation reverseDeliveryCreateWithShipping($input: ReverseDeliveryCreateWithShippingInput!) {
    reverseDeliveryCreateWithShipping(input: $input) {
      reverseDelivery {
        id
        label {
          fileUrl
        }
        deliverable {
          ... on ReverseDeliveryShippingDeliverable {
            tracking {
              number
              carrier {
                name
              }
              url
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const createReverseDelivery = {
  name: "create-reverse-delivery",
  description: "Attach return shipping/tracking to a Shopify return",
  schema: CreateReverseDeliveryInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: CreateReverseDeliveryInput) => {
    try {
      const { returnId, trackingNumber, trackingCompany, trackingUrl, labelUrl } = input;

      // Step 1: Get the return line items to build the delivery
      const returnData = (await shopifyClient.request(GET_RETURN_LINE_ITEMS_QUERY, {
        returnId,
      })) as {
        return: {
          id: string;
          status: string;
          returnLineItems: { edges: Array<{ node: any }> };
        } | null;
      };

      if (!returnData.return) {
        throw new Error(`Return ${returnId} not found`);
      }

      const returnObj = returnData.return;
      const returnLineItems = returnObj.returnLineItems.edges.map((e) => e.node);

      if (returnLineItems.length === 0) {
        throw new Error(`Return ${returnId} has no line items`);
      }

      // Step 2: Build tracking URL if not provided
      let resolvedTrackingUrl = trackingUrl;
      if (!resolvedTrackingUrl && trackingCompany.toUpperCase() === "UPS") {
        resolvedTrackingUrl = `https://www.ups.com/track?tracknum=${trackingNumber}`;
      }

      // Step 3: Build reverse delivery line items (all return line items)
      const reverseDeliveryLineItems = returnLineItems.map((rli: any) => ({
        returnLineItemId: rli.id,
        quantity: rli.quantity,
      }));

      // Step 4: Create the reverse delivery with shipping
      const trackingInput: { number: string; carrier: string; url?: string } = {
        number: trackingNumber,
        carrier: trackingCompany,
      };
      if (resolvedTrackingUrl) {
        trackingInput.url = resolvedTrackingUrl;
      }

      const variables = {
        input: {
          returnId,
          reverseDeliveryLineItems,
          trackingInput,
          ...(labelUrl ? { labelInput: { fileUrl: labelUrl } } : {}),
        },
      };

      const result = (await shopifyClient.request(REVERSE_DELIVERY_CREATE_MUTATION, variables)) as {
        reverseDeliveryCreateWithShipping: {
          reverseDelivery: any;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };

      const mutationResult = result.reverseDeliveryCreateWithShipping;

      if (mutationResult.userErrors && mutationResult.userErrors.length > 0) {
        const errorMessages = mutationResult.userErrors
          .map((e) => `${e.field?.join(".") || "unknown"}: ${e.message}`)
          .join("; ");
        throw new Error(`Shopify API errors: ${errorMessages}`);
      }

      if (!mutationResult.reverseDelivery) {
        throw new Error("Reverse delivery creation succeeded but no object was returned");
      }

      return {
        reverseDeliveryId: mutationResult.reverseDelivery.id,
        returnId,
        tracking: {
          number: trackingNumber,
          company: trackingCompany,
          url: resolvedTrackingUrl,
        },
        labelFileUrl: mutationResult.reverseDelivery.label?.fileUrl || null,
        lineItemCount: reverseDeliveryLineItems.length,
      };
    } catch (error) {
      console.error("Error creating reverse delivery:", error);
      throw new Error(
        `Failed to create reverse delivery: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  },
};

export { createReverseDelivery };
