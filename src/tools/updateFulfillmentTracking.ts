import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const UpdateFulfillmentTrackingInputSchema = z.object({
  fulfillmentId: z.string().min(1),
  trackingNumber: z.string().min(1),
  trackingCompany: z.string().optional(),
  trackingUrl: z.string().optional(),
  notifyCustomer: z.boolean().default(false)
});

type UpdateFulfillmentTrackingInput = z.infer<
  typeof UpdateFulfillmentTrackingInputSchema
>;

type TrackingInfo = {
  company: string | null;
  number: string | null;
  url: string | null;
};

type MutationUserError = {
  field: string[] | null;
  message: string;
};

type FulfillmentNode = {
  id: string;
  status: string;
  trackingInfo: TrackingInfo[] | null;
};

type FulfillmentTrackingUpdatePayload = {
  fulfillment: FulfillmentNode | null;
  userErrors: MutationUserError[];
};

type FulfillmentTrackingInfoUpdateResponse = {
  fulfillmentTrackingInfoUpdate: FulfillmentTrackingUpdatePayload;
};

type FulfillmentTrackingInfoUpdateV2Response = {
  fulfillmentTrackingInfoUpdateV2: FulfillmentTrackingUpdatePayload;
};

function formatUserErrors(errors: MutationUserError[]): string {
  return errors
    .map((error) => {
      const field =
        Array.isArray(error.field) && error.field.length > 0
          ? `${error.field.join(".")}: `
          : "";
      return `${field}${error.message}`;
    })
    .join(", ");
}

function isSchemaCompatibilityError(error: unknown): boolean {
  const responseErrors = (error as { response?: { errors?: Array<{ message?: string }> } })
    ?.response?.errors;

  const allMessages: string[] = [];
  if (error instanceof Error && error.message) {
    allMessages.push(error.message);
  }
  if (Array.isArray(responseErrors)) {
    allMessages.push(
      ...responseErrors
        .map((entry) => entry?.message)
        .filter((message): message is string => typeof message === "string")
    );
  }

  if (allMessages.length === 0) {
    return false;
  }

  return allMessages.some((message) => {
    return (
      message.includes("Cannot query field") ||
      message.includes("Unknown argument") ||
      message.includes("Unknown type") ||
      message.includes("isn't defined") ||
      message.includes("is not defined")
    );
  });
}

const updateFulfillmentTracking = {
  name: "update-fulfillment-tracking",
  description: "Update tracking number on an existing fulfillment",
  schema: UpdateFulfillmentTrackingInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: UpdateFulfillmentTrackingInput) => {
    try {
      const {
        fulfillmentId,
        trackingNumber,
        trackingCompany,
        trackingUrl,
        notifyCustomer
      } = input;

      const trackingInfoInput: {
        number: string;
        numbers: string[];
        company?: string;
        url?: string;
        urls?: string[];
      } = {
        number: trackingNumber,
        numbers: [trackingNumber]
      };

      if (trackingCompany) {
        trackingInfoInput.company = trackingCompany;
      }

      if (trackingUrl) {
        trackingInfoInput.url = trackingUrl;
        trackingInfoInput.urls = [trackingUrl];
      }

      const mutationVariables = {
        fulfillmentId,
        trackingInfoInput,
        notifyCustomer
      };

      const primaryMutation = gql`
        mutation fulfillmentTrackingInfoUpdate(
          $fulfillmentId: ID!
          $trackingInfoInput: FulfillmentTrackingInput!
          $notifyCustomer: Boolean
        ) {
          fulfillmentTrackingInfoUpdate(
            fulfillmentId: $fulfillmentId
            trackingInfoInput: $trackingInfoInput
            notifyCustomer: $notifyCustomer
          ) {
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

      const fallbackMutation = gql`
        mutation fulfillmentTrackingInfoUpdateV2(
          $fulfillmentId: ID!
          $trackingInfoInput: FulfillmentTrackingInput!
          $notifyCustomer: Boolean
        ) {
          fulfillmentTrackingInfoUpdateV2(
            fulfillmentId: $fulfillmentId
            trackingInfoInput: $trackingInfoInput
            notifyCustomer: $notifyCustomer
          ) {
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

      let payload: FulfillmentTrackingUpdatePayload;

      try {
        const primaryData = (await shopifyClient.request(
          primaryMutation,
          mutationVariables
        )) as FulfillmentTrackingInfoUpdateResponse;
        payload = primaryData.fulfillmentTrackingInfoUpdate;
      } catch (primaryError) {
        if (!isSchemaCompatibilityError(primaryError)) {
          throw primaryError;
        }

        const fallbackData = (await shopifyClient.request(
          fallbackMutation,
          mutationVariables
        )) as FulfillmentTrackingInfoUpdateV2Response;
        payload = fallbackData.fulfillmentTrackingInfoUpdateV2;
      }

      if (!payload) {
        throw new Error("No payload returned from fulfillment tracking mutation");
      }

      const userErrors = payload.userErrors ?? [];
      if (userErrors.length > 0) {
        throw new Error(
          `Shopify fulfillment tracking update error: ${formatUserErrors(userErrors)}`
        );
      }

      if (!payload.fulfillment) {
        throw new Error("No fulfillment returned from fulfillment tracking mutation");
      }

      return {
        fulfillment: {
          id: payload.fulfillment.id,
          status: payload.fulfillment.status,
          trackingInfo: payload.fulfillment.trackingInfo ?? []
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
