import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";

// Input schema for updateFulfillmentTracking
// Accepts both singular (trackingNumber) and plural (trackingNumbers) for convenience
const UpdateFulfillmentTrackingInputSchema = z.object({
  fulfillmentId: z.string().min(1).describe("The fulfillment ID (gid://shopify/Fulfillment/...)"),
  trackingNumber: z.string().optional().describe("Single tracking number (convenience alias)"),
  trackingNumbers: z.array(z.string()).optional().describe("Tracking number(s) for the shipment"),
  trackingUrl: z.string().optional().describe("Single tracking URL (convenience alias)"),
  trackingUrls: z.array(z.string()).optional().describe("Tracking URL(s) - if omitted, Shopify auto-generates from carrier"),
  trackingCompany: z.string().optional().describe("Carrier name (e.g., 'UPS', 'Royal Mail', 'DPD')"),
  notifyCustomer: z.boolean().default(false).describe("Whether to send tracking notification email to customer")
});

type UpdateFulfillmentTrackingInput = z.infer<typeof UpdateFulfillmentTrackingInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const updateFulfillmentTracking = {
  name: "update-fulfillment-tracking",
  description: "Update tracking information for an existing fulfillment",
  schema: UpdateFulfillmentTrackingInputSchema,

  // Add initialize method to set up the GraphQL client
  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: UpdateFulfillmentTrackingInput) => {
    try {
      const { fulfillmentId, trackingNumber, trackingNumbers, trackingUrl, trackingUrls, trackingCompany, notifyCustomer } = input;

      // Merge singular and plural tracking numbers
      const allTrackingNumbers: string[] = [];
      if (trackingNumber) allTrackingNumbers.push(trackingNumber);
      if (trackingNumbers) allTrackingNumbers.push(...trackingNumbers);

      // Merge singular and plural tracking URLs
      const allTrackingUrls: string[] = [];
      if (trackingUrl) allTrackingUrls.push(trackingUrl);
      if (trackingUrls) allTrackingUrls.push(...trackingUrls);

      // Build tracking info input
      // Use fulfillmentTrackingInfoUpdate mutation (NOT fulfillmentUpdate)
      const mutation = gql`
        mutation fulfillmentTrackingInfoUpdate($fulfillmentId: ID!, $trackingInfoInput: FulfillmentTrackingInput!, $notifyCustomer: Boolean) {
          fulfillmentTrackingInfoUpdate(
            fulfillmentId: $fulfillmentId
            trackingInfoInput: $trackingInfoInput
            notifyCustomer: $notifyCustomer
          ) {
            fulfillment {
              id
              status
              displayStatus
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

      // Build tracking info input object
      const trackingInfoInput: {
        numbers?: string[];
        urls?: string[];
        company?: string;
      } = {};

      if (allTrackingNumbers.length > 0) {
        trackingInfoInput.numbers = allTrackingNumbers;
      }
      if (allTrackingUrls.length > 0) {
        trackingInfoInput.urls = allTrackingUrls;
      }
      if (trackingCompany) {
        trackingInfoInput.company = trackingCompany;
      }

      const variables = {
        fulfillmentId,
        trackingInfoInput,
        notifyCustomer
      };

      const data = (await shopifyClient.request(mutation, variables)) as {
        fulfillmentTrackingInfoUpdate: {
          fulfillment: any;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };

      const result = data.fulfillmentTrackingInfoUpdate;

      // Check for user errors
      if (result.userErrors && result.userErrors.length > 0) {
        const errorMessages = result.userErrors
          .map((e) => `${e.field?.join(".") || "unknown"}: ${e.message}`)
          .join("; ");
        throw new Error(`Shopify API errors: ${errorMessages}`);
      }

      if (!result.fulfillment) {
        throw new Error(`Failed to update fulfillment tracking for ${fulfillmentId}`);
      }

      // Format the response
      const fulfillment = result.fulfillment;
      return {
        fulfillment: {
          id: fulfillment.id,
          status: fulfillment.status,
          displayStatus: fulfillment.displayStatus,
          trackingInfo: (fulfillment.trackingInfo || []).map((tracking: any) => ({
            company: tracking.company,
            number: tracking.number,
            url: tracking.url
          }))
        },
        notificationSent: notifyCustomer
      };
    } catch (error) {
      console.error("Error updating fulfillment tracking:", error);
      throw new Error(
        `Failed to update fulfillment tracking: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
};

export { updateFulfillmentTracking };
