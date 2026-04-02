import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";

const ReturnReasonEnum = z.enum([
  "DEFECTIVE",
  "WRONG_ITEM",
  "STYLE",
  "SIZE_TOO_SMALL",
  "SIZE_TOO_LARGE",
  "UNWANTED",
  "OTHER",
  "UNKNOWN",
  "COLOR",
]);

const CreateReturnInputSchema = z.object({
  orderNumber: z.string().min(1).describe("Order number (e.g., '14901' or '#14901')"),
  lineItems: z.array(z.object({
    sku: z.string().describe("SKU of the item to return"),
    quantity: z.number().int().positive().describe("Quantity to return"),
  })).optional().describe("Specific items to return (omit to return all returnable items)"),
  returnReason: ReturnReasonEnum.default("OTHER").describe("Reason for return"),
  notifyCustomer: z.boolean().default(false).describe("Send notification email to customer"),
});

type CreateReturnInput = z.infer<typeof CreateReturnInputSchema>;

let shopifyClient: GraphQLClient;

const FIND_ORDER_FOR_RETURN_QUERY = gql`
  query FindOrderForReturn($query: String!) {
    orders(first: 3, sortKey: PROCESSED_AT, reverse: true, query: $query) {
      edges {
        node {
          id
          name
          displayFulfillmentStatus
          fulfillments(first: 10) {
            id
            status
            fulfillmentLineItems(first: 50) {
              edges {
                node {
                  id
                  quantity
                  originalTotalSet {
                    shopMoney { amount currencyCode }
                  }
                  lineItem {
                    sku
                    title
                    quantity
                    currentQuantity
                  }
                }
              }
            }
          }
          returns(first: 10) {
            edges {
              node {
                id
                status
                returnLineItems(first: 50) {
                  edges {
                    node {
                      quantity
                      fulfillmentLineItem {
                        id
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

const RETURN_CREATE_MUTATION = gql`
  mutation returnCreate($returnInput: ReturnInput!) {
    returnCreate(returnInput: $returnInput) {
      return {
        id
        name
        status
        returnLineItems(first: 20) {
          edges {
            node {
              id
              quantity
              returnReason
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
      userErrors {
        field
        message
      }
    }
  }
`;

const createReturn = {
  name: "create-return",
  description: "Create a return for a fulfilled Shopify order",
  schema: CreateReturnInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: CreateReturnInput) => {
    try {
      const { orderNumber, lineItems, returnReason, notifyCustomer } = input;

      // Step 1: Normalize order number and find the order
      const cleanNumber = orderNumber.replace(/^#?\D*/i, "") || orderNumber.replace(/^#/, "");
      const queryStr = `name:#${cleanNumber}`;

      const data = (await shopifyClient.request(FIND_ORDER_FOR_RETURN_QUERY, { query: queryStr })) as {
        orders: { edges: Array<{ node: any }> };
      };

      if (!data.orders.edges.length) {
        throw new Error(`Order #${cleanNumber} not found`);
      }

      // Match order name ending with the clean number (handles any store prefix)
      const orderNode = data.orders.edges.find(
        (e) => e.node.name.endsWith(cleanNumber)
      )?.node || data.orders.edges[0].node;

      // Step 2: Collect all fulfilled line items
      const fulfillments = orderNode.fulfillments || [];
      if (fulfillments.length === 0) {
        throw new Error(`Order ${orderNode.name} has no fulfillments — cannot create a return`);
      }

      // Build a map of fulfillment line items with returnable quantities
      interface ReturnableItem {
        fulfillmentLineItemId: string;
        sku: string;
        title: string;
        fulfilledQuantity: number;
        alreadyReturnedQuantity: number;
        returnableQuantity: number;
      }

      const returnableItems: ReturnableItem[] = [];

      // Collect already-returned quantities from existing returns
      const returnedQuantityMap = new Map<string, number>(); // fulfillmentLineItemId → returned qty
      const existingReturns = orderNode.returns?.edges || [];
      for (const returnEdge of existingReturns) {
        const ret = returnEdge.node;
        if (ret.status === "CANCELED" || ret.status === "CANCELLED") continue;
        for (const rliEdge of (ret.returnLineItems?.edges || [])) {
          const rli = rliEdge.node;
          const fliId = rli.fulfillmentLineItem?.id;
          if (fliId) {
            returnedQuantityMap.set(fliId, (returnedQuantityMap.get(fliId) || 0) + rli.quantity);
          }
        }
      }

      for (const fulfillment of fulfillments) {
        if (fulfillment.status !== "SUCCESS") continue;
        for (const fliEdge of (fulfillment.fulfillmentLineItems?.edges || [])) {
          const fli = fliEdge.node;
          const alreadyReturned = returnedQuantityMap.get(fli.id) || 0;
          const returnableQty = fli.quantity - alreadyReturned;

          if (returnableQty > 0) {
            returnableItems.push({
              fulfillmentLineItemId: fli.id,
              sku: fli.lineItem?.sku || "",
              title: fli.lineItem?.title || "Unknown",
              fulfilledQuantity: fli.quantity,
              alreadyReturnedQuantity: alreadyReturned,
              returnableQuantity: returnableQty,
            });
          }
        }
      }

      if (returnableItems.length === 0) {
        return {
          alreadyReturned: true,
          message: "All fulfilled items have already been returned",
          orderName: orderNode.name,
        };
      }

      // Step 3: Determine which items to return
      interface ReturnLineItemInput {
        fulfillmentLineItemId: string;
        quantity: number;
        returnReason: string;
      }

      const returnLineItems: ReturnLineItemInput[] = [];

      if (lineItems && lineItems.length > 0) {
        // Specific items requested — match by SKU
        for (const requested of lineItems) {
          const match = returnableItems.find((item) => item.sku === requested.sku);
          if (!match) {
            const availableSkus = returnableItems.map((i) => i.sku).filter(Boolean).join(", ");
            throw new Error(
              `SKU "${requested.sku}" not found in returnable items. Available: ${availableSkus || "none"}`
            );
          }
          if (requested.quantity > match.returnableQuantity) {
            throw new Error(
              `Requested quantity ${requested.quantity} for SKU "${requested.sku}" exceeds returnable quantity ${match.returnableQuantity}` +
              (match.alreadyReturnedQuantity > 0 ? ` (${match.alreadyReturnedQuantity} already returned)` : "")
            );
          }
          returnLineItems.push({
            fulfillmentLineItemId: match.fulfillmentLineItemId,
            quantity: requested.quantity,
            returnReason,
          });
        }
      } else {
        // Return all returnable items
        for (const item of returnableItems) {
          returnLineItems.push({
            fulfillmentLineItemId: item.fulfillmentLineItemId,
            quantity: item.returnableQuantity,
            returnReason,
          });
        }
      }

      // Step 4: Create the return
      const variables = {
        returnInput: {
          orderId: orderNode.id,
          returnLineItems,
          notifyCustomer,
        },
      };

      const result = (await shopifyClient.request(RETURN_CREATE_MUTATION, variables)) as {
        returnCreate: {
          return: any;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      };

      const mutationResult = result.returnCreate;

      if (mutationResult.userErrors && mutationResult.userErrors.length > 0) {
        const errorMessages = mutationResult.userErrors
          .map((e) => `${e.field?.join(".") || "unknown"}: ${e.message}`)
          .join("; ");
        throw new Error(`Shopify API errors: ${errorMessages}`);
      }

      if (!mutationResult.return) {
        throw new Error("Return creation succeeded but no return object was returned");
      }

      const returnObj = mutationResult.return;
      const returnedItems = (returnObj.returnLineItems?.edges || []).map((e: any) => ({
        id: e.node.id,
        quantity: e.node.quantity,
        returnReason: e.node.returnReason,
        sku: e.node.fulfillmentLineItem?.lineItem?.sku || "",
        title: e.node.fulfillmentLineItem?.lineItem?.title || "",
      }));

      return {
        returnId: returnObj.id,
        returnName: returnObj.name,
        status: returnObj.status,
        orderName: orderNode.name,
        notificationSent: notifyCustomer,
        returnedItems,
        itemCount: returnedItems.length,
        partial: lineItems !== undefined && lineItems.length > 0,
      };
    } catch (error) {
      console.error("Error creating return:", error);
      throw new Error(
        `Failed to create return: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  },
};

export { createReturn };
