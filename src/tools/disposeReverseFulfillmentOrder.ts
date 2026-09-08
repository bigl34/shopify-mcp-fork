import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { checkUserErrors, handleToolError } from "../lib/toolUtils.js";

const ReverseFulfillmentOrderDispositionInputSchema = z
  .object({
    reverseFulfillmentOrderLineItemId: z
      .string()
      .regex(
        /^gid:\/\/shopify\/ReverseFulfillmentOrderLineItem\/\d+$/,
        "reverseFulfillmentOrderLineItemId must be a ReverseFulfillmentOrderLineItem GID",
      ),
    quantity: z.number().int().positive(),
    dispositionType: z.enum([
      "MISSING",
      "NOT_RESTOCKED",
      "PROCESSING_REQUIRED",
      "RESTOCKED",
    ]),
    locationId: z
      .string()
      .regex(
        /^gid:\/\/shopify\/Location\/\d+$/,
        "locationId must be a Location GID",
      )
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (input.dispositionType === "RESTOCKED" && !input.locationId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "locationId is required when dispositionType is RESTOCKED",
        path: ["locationId"],
      });
    }
  });

const DisposeReverseFulfillmentOrderInputSchema = z.object({
  dispositionInputs: z
    .array(ReverseFulfillmentOrderDispositionInputSchema)
    .min(1)
    .max(250),
  dryRun: z.boolean().default(true),
  confirmation: z
    .literal("DISPOSE_REVERSE_FULFILLMENT_ORDER_ITEMS")
    .optional()
    .describe("Required exact confirmation phrase when dryRun is false"),
});

type DisposeReverseFulfillmentOrderInput = z.infer<
  typeof DisposeReverseFulfillmentOrderInputSchema
>;

let shopifyClient: GraphQLClient;

const disposeReverseFulfillmentOrder = {
  name: "reverse-fulfillment-order-dispose",
  description:
    "Irreversibly dispose reverse fulfillment order line-item quantities. Defaults to dry-run; execution requires the exact confirmation phrase.",
  schema: DisposeReverseFulfillmentOrderInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: DisposeReverseFulfillmentOrderInput) => {
    try {
      const totalQuantity = input.dispositionInputs.reduce(
        (sum, disposition) => sum + disposition.quantity,
        0,
      );

      if (input.dryRun) {
        return {
          dryRun: true,
          totalQuantity,
          wouldDispose: input.dispositionInputs,
          warning:
            "Dispositions are irreversible. If a reverse delivery exists, use reverseDeliveryDispose instead.",
        };
      }

      if (
        input.confirmation !==
        "DISPOSE_REVERSE_FULFILLMENT_ORDER_ITEMS"
      ) {
        throw new Error(
          "reverse-fulfillment-order-dispose requires confirmation='DISPOSE_REVERSE_FULFILLMENT_ORDER_ITEMS' when dryRun is false",
        );
      }

      const query = gql`
        #graphql

        mutation ReverseFulfillmentOrderDispose(
          $dispositionInputs: [ReverseFulfillmentOrderDisposeInput!]!
        ) {
          reverseFulfillmentOrderDispose(
            dispositionInputs: $dispositionInputs
          ) {
            reverseFulfillmentOrderLineItems {
              id
              totalQuantity
              dispositions {
                id
                quantity
                type
                location {
                  id
                  name
                }
              }
            }
            userErrors {
              code
              field
              message
            }
          }
        }
      `;

      const data = (await shopifyClient.request(query, {
        dispositionInputs: input.dispositionInputs,
      })) as {
        reverseFulfillmentOrderDispose: {
          reverseFulfillmentOrderLineItems: Array<Record<string, unknown>> | null;
          userErrors: Array<{
            field: string;
            message: string;
            code?: string;
          }>;
        };
      };

      checkUserErrors(
        data.reverseFulfillmentOrderDispose.userErrors,
        "dispose reverse fulfillment order line items",
      );

      return {
        dryRun: false,
        totalQuantity,
        disposedLineItems:
          data.reverseFulfillmentOrderDispose.reverseFulfillmentOrderLineItems ??
          [],
      };
    } catch (error) {
      handleToolError("dispose reverse fulfillment order line items", error);
    }
  },
};

export { disposeReverseFulfillmentOrder };
