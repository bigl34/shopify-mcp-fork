import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";

const UpdateReverseDeliveryShippingInputSchema = z.object({
  reverseDeliveryId: z.string().min(1).describe("Reverse delivery GID (gid://shopify/ReverseDelivery/...)"),
  trackingNumber: z.string().min(1).describe("New tracking number"),
  trackingCompany: z.string().default("UPS").describe("Carrier name"),
  trackingUrl: z.string().optional().describe("Tracking URL (auto-generated for UPS if omitted)"),
  labelUrl: z.string().optional().describe("URL of the return label image (PNG/PDF)"),
  notifyCustomer: z.boolean().default(false).describe("Send notification email to customer"),
});

type UpdateReverseDeliveryShippingInput = z.infer<typeof UpdateReverseDeliveryShippingInputSchema>;

let shopifyClient: GraphQLClient;

const REVERSE_DELIVERY_SHIPPING_UPDATE_MUTATION = gql`
  mutation reverseDeliveryShippingUpdate(
    $reverseDeliveryId: ID!
    $trackingInput: ReverseDeliveryTrackingInput
    $labelInput: ReverseDeliveryLabelInput
    $notifyCustomer: Boolean
  ) {
    reverseDeliveryShippingUpdate(
      reverseDeliveryId: $reverseDeliveryId
      trackingInput: $trackingInput
      labelInput: $labelInput
      notifyCustomer: $notifyCustomer
    ) {
      reverseDelivery {
        id
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

const updateReverseDeliveryShipping = {
  name: "update-reverse-delivery-shipping",
  description: "Update tracking/label on an existing reverse delivery",
  schema: UpdateReverseDeliveryShippingInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: UpdateReverseDeliveryShippingInput) => {
    try {
      const { reverseDeliveryId, trackingNumber, trackingCompany, trackingUrl, labelUrl, notifyCustomer } = input;

      // Build tracking URL if not provided
      let resolvedTrackingUrl = trackingUrl;
      if (!resolvedTrackingUrl && trackingCompany.toUpperCase() === "UPS") {
        resolvedTrackingUrl = `https://www.ups.com/track?tracknum=${trackingNumber}`;
      }

      const trackingInput: { number: string; carrier: string; url?: string } = {
        number: trackingNumber,
        carrier: trackingCompany,
      };
      if (resolvedTrackingUrl) {
        trackingInput.url = resolvedTrackingUrl;
      }

      const variables: Record<string, any> = {
        reverseDeliveryId,
        trackingInput,
        notifyCustomer,
      };

      if (labelUrl) {
        variables.labelInput = { fileUrl: labelUrl };
      }

      const result = (await shopifyClient.request(REVERSE_DELIVERY_SHIPPING_UPDATE_MUTATION, variables)) as {
        reverseDeliveryShippingUpdate: {
          reverseDelivery: any;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };

      const mutationResult = result.reverseDeliveryShippingUpdate;

      if (mutationResult.userErrors && mutationResult.userErrors.length > 0) {
        const errorMessages = mutationResult.userErrors
          .map((e) => `${e.field?.join(".") || "unknown"}: ${e.message}`)
          .join("; ");
        throw new Error(`Shopify API errors: ${errorMessages}`);
      }

      if (!mutationResult.reverseDelivery) {
        throw new Error("Reverse delivery update succeeded but no object was returned");
      }

      const deliverable = mutationResult.reverseDelivery.deliverable;
      const tracking = deliverable?.tracking;

      return {
        reverseDeliveryId: mutationResult.reverseDelivery.id,
        tracking: {
          number: tracking?.number || trackingNumber,
          company: tracking?.carrier?.name || trackingCompany,
          url: tracking?.url || resolvedTrackingUrl,
        },
      };
    } catch (error) {
      console.error("Error updating reverse delivery shipping:", error);
      throw new Error(
        `Failed to update reverse delivery shipping: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  },
};

export { updateReverseDeliveryShipping };
