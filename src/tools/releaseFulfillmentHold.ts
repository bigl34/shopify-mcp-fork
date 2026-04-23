import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { checkUserErrors, handleToolError } from "../lib/toolUtils.js";

const ReleaseFulfillmentHoldInputSchema = z.object({
  fulfillmentOrderId: z
    .string()
    .regex(
      /^gid:\/\/shopify\/FulfillmentOrder\/\d+$/,
      "fulfillmentOrderId must be a FulfillmentOrder GID (gid://shopify/FulfillmentOrder/<id>)"
    )
    .describe("The fulfillment order GID whose hold should be released"),
});

type ReleaseFulfillmentHoldInput = z.infer<typeof ReleaseFulfillmentHoldInputSchema>;

interface FulfillmentHold {
  id: string;
  reason: string;
  reasonNotes: string | null;
}

interface FulfillmentOrderReleaseHoldResponse {
  fulfillmentOrderReleaseHold: {
    fulfillmentOrder: {
      id: string;
      status: string;
      requestStatus: string;
      fulfillmentHolds: FulfillmentHold[];
    } | null;
    userErrors: Array<{ field: string | string[]; message: string }>;
  };
}

let shopifyClient: GraphQLClient;

const releaseFulfillmentHold = {
  name: "release-fulfillment-hold",
  description:
    "Release a hold on a fulfillment order (e.g. an INCORRECT_ADDRESS auto-hold set by the OrderEditing app). Returns the post-release snapshot so callers can verify `fulfillmentHolds` is empty.",
  schema: ReleaseFulfillmentHoldInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: ReleaseFulfillmentHoldInput) => {
    try {
      const query = gql`
        #graphql

        mutation fulfillmentOrderReleaseHold($id: ID!) {
          fulfillmentOrderReleaseHold(id: $id) {
            fulfillmentOrder {
              id
              status
              requestStatus
              fulfillmentHolds {
                id
                reason
                reasonNotes
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const data = (await shopifyClient.request(query, {
        id: input.fulfillmentOrderId,
      })) as FulfillmentOrderReleaseHoldResponse;

      checkUserErrors(
        data.fulfillmentOrderReleaseHold.userErrors as {
          field: string;
          message: string;
        }[],
        "release fulfillment hold"
      );

      const fo = data.fulfillmentOrderReleaseHold.fulfillmentOrder;
      if (!fo) {
        throw new Error(
          "release fulfillment hold returned no fulfillmentOrder payload"
        );
      }

      return {
        fulfillmentOrderId: fo.id,
        status: fo.status,
        requestStatus: fo.requestStatus,
        fulfillmentHolds: fo.fulfillmentHolds,
      };
    } catch (error) {
      handleToolError("release fulfillment hold", error);
    }
  },
};

export { releaseFulfillmentHold };
