import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { checkUserErrors, handleToolError } from "../lib/toolUtils.js";

const SetInventoryQuantitiesInputSchema = z.object({
  idempotencyKey: z
    .string()
    .min(1)
    .max(255)
    .describe("Unique key for this logical inventory write; retries must reuse the same key"),
  reason: z.string().describe("Reason for the quantity change (e.g. 'correction', 'cycle_count_available', 'received')"),
  name: z.enum(["available", "on_hand"]).describe("Which quantity to set: 'available' or 'on_hand'"),
  referenceDocumentUri: z
    .string()
    .url()
    .optional()
    .describe("Optional source-document URI for the inventory audit trail"),
  quantities: z
    .array(
      z.object({
        inventoryItemId: z.string().describe("Inventory item GID"),
        locationId: z.string().describe("Location GID"),
        quantity: z.number().int().describe("Absolute quantity to set"),
        changeFromQuantity: z
          .number()
          .int()
          .describe("Expected current quantity for Shopify compare-and-set"),
      })
    )
    .min(1)
    .describe("Quantities to set for each inventory item at each location"),
});

type SetInventoryQuantitiesInput = z.infer<typeof SetInventoryQuantitiesInputSchema>;

let shopifyClient: GraphQLClient;

const setInventoryQuantities = {
  name: "inventory-set-quantities",
  description:
    "Idempotently set absolute inventory quantities with compare-and-set safety. Reuse the idempotency key when retrying the same logical write.",
  schema: SetInventoryQuantitiesInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: SetInventoryQuantitiesInput) => {
    try {
      const query = gql`
        #graphql

        mutation inventorySetQuantities(
          $input: InventorySetQuantitiesInput!
          $idempotencyKey: String!
        ) {
          inventorySetQuantities(input: $input)
            @idempotent(key: $idempotencyKey) {
            inventoryAdjustmentGroup {
              createdAt
              reason
              referenceDocumentUri
              changes {
                name
                delta
                quantityAfterChange
                item {
                  id
                  sku
                }
                location {
                  id
                  name
                }
              }
            }
            userErrors {
              field
              message
              code
            }
          }
        }
      `;

      const data = (await shopifyClient.request(query, {
        idempotencyKey: input.idempotencyKey,
        input: {
          reason: input.reason,
          name: input.name,
          ...(input.referenceDocumentUri && {
            referenceDocumentUri: input.referenceDocumentUri,
          }),
          quantities: input.quantities,
        },
      })) as {
        inventorySetQuantities: {
          inventoryAdjustmentGroup: any;
          userErrors: Array<{ field: string; message: string; code: string }>;
        };
      };

      checkUserErrors(data.inventorySetQuantities.userErrors, "set inventory quantities");

      return {
        idempotencyKey: input.idempotencyKey,
        adjustmentGroup: data.inventorySetQuantities.inventoryAdjustmentGroup,
      };
    } catch (error) {
      handleToolError("set inventory quantities", error);
    }
  },
};

export { setInventoryQuantities };
