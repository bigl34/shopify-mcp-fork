import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const CreateFulfillmentInputSchema = z.object({
  orderNumber: z.string().min(1),
  trackingNumber: z.string().min(1),
  trackingCompany: z.string().default("UPS"),
  trackingUrl: z.string().optional(),
  notifyCustomer: z.boolean().default(false),
  lineItems: z
    .array(
      z.object({
        sku: z.string().min(1),
        quantity: z.number().int().positive()
      })
    )
    .optional()
});

type CreateFulfillmentInput = z.infer<typeof CreateFulfillmentInputSchema>;

type FulfillmentOrderLineItemNode = {
  id: string;
  remainingQuantity: number;
  lineItem: {
    sku: string | null;
    title: string | null;
  } | null;
};

type FulfillmentOrderNode = {
  id: string;
  status: string;
  supportedActions: Array<{ action: string }>;
  lineItems: {
    edges: Array<{ node: FulfillmentOrderLineItemNode }>;
  };
};

type OrderNode = {
  id: string;
  name: string;
  displayFulfillmentStatus: string;
  fulfillmentOrders: {
    edges: Array<{ node: FulfillmentOrderNode }>;
  };
};

type FindOrderResponse = {
  orders: {
    edges: Array<{ node: OrderNode }>;
  };
};

type FulfillmentCreateResponse = {
  fulfillmentCreateV2: {
    fulfillment: {
      id: string;
      status: string;
      trackingInfo: Array<{
        company: string | null;
        number: string | null;
        url: string | null;
      }>;
    } | null;
    userErrors: Array<{
      field: string[] | null;
      message: string;
    }>;
  };
};

function normalizeOrderCandidates(orderNumber: string): string[] {
  const raw = orderNumber.trim();
  const cleaned = raw
    .replace(/^#/, "")
    .replace(/^FWS[-_]?/i, "");
  const digits = cleaned.match(/\d+/)?.[0] ?? "";

  const candidates = new Set<string>();

  if (digits) {
    candidates.add(digits);

    // Legacy order references in this workspace often map 4-digit -> 5-digit by appending 1.
    if (/^\d{4}$/.test(digits)) {
      candidates.add(`${digits}1`);
    }
  }

  return Array.from(candidates);
}

function extractOrderDigits(orderName: string): string {
  const match = orderName.match(/\d+/g);
  return match ? match.join("") : "";
}

const createFulfillment = {
  name: "create-fulfillment",
  description: "Create fulfillment with tracking for an order",
  schema: CreateFulfillmentInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: CreateFulfillmentInput) => {
    try {
      const {
        orderNumber,
        trackingNumber,
        trackingCompany,
        trackingUrl,
        notifyCustomer,
        lineItems
      } = input;

      const candidates = normalizeOrderCandidates(orderNumber);
      if (candidates.length === 0) {
        throw new Error(`Invalid order number: ${orderNumber}`);
      }

      const findOrderQuery = gql`
        query FindOrderForFulfillment($query: String!) {
          orders(first: 5, sortKey: PROCESSED_AT, reverse: true, query: $query) {
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
                      supportedActions {
                        action
                      }
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

      let selectedOrder: OrderNode | null = null;
      const attemptedQueries: string[] = [];

      for (const candidate of candidates) {
        const queryFilter = `name:${candidate}`;
        attemptedQueries.push(queryFilter);

        const data = (await shopifyClient.request(findOrderQuery, {
          query: queryFilter
        })) as FindOrderResponse;

        const orders = data.orders.edges.map((edge) => edge.node);
        const matchedOrder =
          orders.find((order) => extractOrderDigits(order.name) === candidate) ??
          null;

        if (matchedOrder) {
          selectedOrder = matchedOrder;
          break;
        }

        if (!selectedOrder && orders.length === 1) {
          selectedOrder = orders[0];
          break;
        }
      }

      if (!selectedOrder) {
        throw new Error(
          `Order ${orderNumber} not found. Tried queries: ${attemptedQueries.join(", ")}`
        );
      }

      const fulfillmentOrders =
        selectedOrder.fulfillmentOrders?.edges?.map((edge) => edge.node) ?? [];

      if (fulfillmentOrders.length === 0) {
        return {
          orderId: selectedOrder.id,
          orderName: selectedOrder.name,
          alreadyFulfilled: true,
          message: "Order already fulfilled"
        };
      }

      const eligibleFulfillmentOrders: FulfillmentOrderNode[] = [];
      const blockingMessages: string[] = [];

      for (const fulfillmentOrder of fulfillmentOrders) {
        const actions =
          fulfillmentOrder.supportedActions?.map((action) => action.action) ?? [];

        if (actions.includes("CREATE_FULFILLMENT")) {
          eligibleFulfillmentOrders.push(fulfillmentOrder);
          continue;
        }

        if (fulfillmentOrder.status === "ON_HOLD") {
          blockingMessages.push(
            `Fulfillment order ${fulfillmentOrder.id} is on hold (release hold in Shopify first)`
          );
          continue;
        }

        if (fulfillmentOrder.status === "SCHEDULED") {
          blockingMessages.push(
            `Fulfillment order ${fulfillmentOrder.id} is scheduled and not yet eligible`
          );
        }
      }

      if (eligibleFulfillmentOrders.length === 0) {
        if (blockingMessages.length > 0) {
          return {
            orderId: selectedOrder.id,
            orderName: selectedOrder.name,
            alreadyFulfilled: false,
            blocked: true,
            message: blockingMessages.join("; "),
            blockingReasons: blockingMessages
          };
        }

        return {
          orderId: selectedOrder.id,
          orderName: selectedOrder.name,
          alreadyFulfilled: true,
          message: "Order already fulfilled"
        };
      }

      const autoTrackingUrl =
        !trackingUrl && trackingCompany.toUpperCase() === "UPS"
          ? `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}`
          : undefined;

      const effectiveTrackingUrl = trackingUrl ?? autoTrackingUrl;

      const allocations = new Map<
        string,
        Array<{ id: string; quantity: number; sku: string }>
      >();
      const consumedByLineItemId = new Map<string, number>();

      if (lineItems && lineItems.length > 0) {
        for (const requestedItem of lineItems) {
          let remainingRequested = requestedItem.quantity;

          for (const fulfillmentOrder of eligibleFulfillmentOrders) {
            if (remainingRequested <= 0) {
              break;
            }

            const orderLineItems =
              fulfillmentOrder.lineItems?.edges?.map((edge) => edge.node) ?? [];

            for (const lineItem of orderLineItems) {
              if (remainingRequested <= 0) {
                break;
              }

              const sku = lineItem.lineItem?.sku;
              if (!sku || sku !== requestedItem.sku) {
                continue;
              }

              const previouslyConsumed =
                consumedByLineItemId.get(lineItem.id) ?? 0;
              const available = Math.max(
                0,
                Number(lineItem.remainingQuantity) - previouslyConsumed
              );

              if (available <= 0) {
                continue;
              }

              const quantityToAllocate = Math.min(available, remainingRequested);
              if (quantityToAllocate <= 0) {
                continue;
              }

              consumedByLineItemId.set(
                lineItem.id,
                previouslyConsumed + quantityToAllocate
              );

              if (!allocations.has(fulfillmentOrder.id)) {
                allocations.set(fulfillmentOrder.id, []);
              }

              allocations.get(fulfillmentOrder.id)!.push({
                id: lineItem.id,
                quantity: quantityToAllocate,
                sku
              });

              remainingRequested -= quantityToAllocate;
            }
          }

          if (remainingRequested > 0) {
            throw new Error(
              `Requested quantity exceeds fulfillable inventory for SKU ${requestedItem.sku} (missing ${remainingRequested})`
            );
          }
        }
      }

      const fulfillmentMutation = gql`
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

      const createdFulfillments: Array<{
        fulfillmentOrderId: string;
        id: string;
        status: string;
        trackingInfo: Array<{
          company: string | null;
          number: string | null;
          url: string | null;
        }>;
      }> = [];

      for (const fulfillmentOrder of eligibleFulfillmentOrders) {
        const specificLineItems = allocations.get(fulfillmentOrder.id) ?? [];

        // If specific line items were requested, skip fulfillment orders that have no allocated lines.
        if (lineItems && lineItems.length > 0 && specificLineItems.length === 0) {
          continue;
        }

        const lineItemsByFulfillmentOrder: Array<{
          fulfillmentOrderId: string;
          fulfillmentOrderLineItems?: Array<{ id: string; quantity: number }>;
        }> = [
          {
            fulfillmentOrderId: fulfillmentOrder.id,
            ...(lineItems && lineItems.length > 0
              ? {
                  fulfillmentOrderLineItems: specificLineItems.map((item) => ({
                    id: item.id,
                    quantity: item.quantity
                  }))
                }
              : {})
          }
        ];

        const trackingInfo: {
          company: string;
          number: string;
          url?: string;
        } = {
          company: trackingCompany,
          number: trackingNumber
        };

        if (effectiveTrackingUrl) {
          trackingInfo.url = effectiveTrackingUrl;
        }

        const mutationVariables = {
          fulfillment: {
            lineItemsByFulfillmentOrder,
            trackingInfo,
            notifyCustomer
          }
        };

        const mutationResponse = (await shopifyClient.request(
          fulfillmentMutation,
          mutationVariables
        )) as FulfillmentCreateResponse;

        const userErrors = mutationResponse.fulfillmentCreateV2.userErrors ?? [];
        if (userErrors.length > 0) {
          const errorText = userErrors
            .map((error) => {
              const field =
                Array.isArray(error.field) && error.field.length > 0
                  ? `${error.field.join(".")}: `
                  : "";
              return `${field}${error.message}`;
            })
            .join(", ");
          throw new Error(`Shopify fulfillmentCreateV2 error: ${errorText}`);
        }

        const fulfillment = mutationResponse.fulfillmentCreateV2.fulfillment;
        if (fulfillment) {
          createdFulfillments.push({
            fulfillmentOrderId: fulfillmentOrder.id,
            id: fulfillment.id,
            status: fulfillment.status,
            trackingInfo: fulfillment.trackingInfo ?? []
          });
        }
      }

      if (createdFulfillments.length === 0) {
        throw new Error(
          "No fulfillment was created. Check selected line items and fulfillment order eligibility."
        );
      }

      return {
        orderId: selectedOrder.id,
        orderName: selectedOrder.name,
        notificationSent: notifyCustomer,
        partial: !!lineItems && lineItems.length > 0,
        fulfillments: createdFulfillments
      };
    } catch (error) {
      console.error("Error creating fulfillment:", error);
      throw new Error(
        `Failed to create fulfillment: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
};

export { createFulfillment };
