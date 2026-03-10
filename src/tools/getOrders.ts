import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";

// Input schema for getOrders
const GetOrdersInputSchema = z.object({
  status: z.enum(["any", "open", "closed", "cancelled"]).default("any"),
  limit: z.number().default(10),
  sortKey: z.enum(["CREATED_AT", "UPDATED_AT", "TOTAL_PRICE", "ID", "CUSTOMER_NAME"]).default("CREATED_AT"),
  reverse: z.boolean().default(true)  // true = newest first (descending)
});

type GetOrdersInput = z.infer<typeof GetOrdersInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const getOrders = {
  name: "get-orders",
  description: "Get orders with optional filtering by status",
  schema: GetOrdersInputSchema,

  // Add initialize method to set up the GraphQL client
  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetOrdersInput) => {
    try {
      const { status, limit, sortKey, reverse } = input;

      // Build query filters
      let queryFilter = "";
      if (status !== "any") {
        queryFilter = `status:${status}`;
      }

      const query = gql`
        query GetOrders($first: Int!, $query: String, $sortKey: OrderSortKeys, $reverse: Boolean) {
          orders(first: $first, query: $query, sortKey: $sortKey, reverse: $reverse) {
            edges {
              node {
                id
                name
                createdAt
                displayFinancialStatus
                displayFulfillmentStatus
                totalPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                subtotalPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                totalShippingPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                totalTaxSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                customer {
                  id
                  firstName
                  lastName
                  email
                }
                shippingAddress {
                  address1
                  address2
                  city
                  provinceCode
                  zip
                  country
                  phone
                }
                lineItems(first: 10) {
                  edges {
                    node {
                      id
                      title
                      quantity
                      originalTotalSet {
                        shopMoney {
                          amount
                          currencyCode
                        }
                      }
                      variant {
                        id
                        title
                        sku
                      }
                    }
                  }
                }
                tags
                note
                fulfillments(first: 5) {
                  id
                  status
                  displayStatus
                  createdAt
                  trackingInfo {
                    company
                    number
                    url
                  }
                }
              }
            }
          }
        }
      `;

      const variables = {
        first: limit,
        query: queryFilter || undefined,
        sortKey,
        reverse
      };

      const data = (await shopifyClient.request(query, variables)) as {
        orders: any;
      };

      // Extract and format order data
      const orders = data.orders.edges.map((edge: any) => {
        const order = edge.node;

        // Format line items
        const lineItems = order.lineItems.edges.map((lineItemEdge: any) => {
          const lineItem = lineItemEdge.node;
          return {
            id: lineItem.id,
            title: lineItem.title,
            quantity: lineItem.quantity,
            originalTotal: lineItem.originalTotalSet.shopMoney,
            variant: lineItem.variant
              ? {
                  id: lineItem.variant.id,
                  title: lineItem.variant.title,
                  sku: lineItem.variant.sku
                }
              : null
          };
        });

        // Format fulfillments
        const fulfillments = (order.fulfillments || []).map((fulfillment: any) => ({
          id: fulfillment.id,
          status: fulfillment.status,
          displayStatus: fulfillment.displayStatus,
          createdAt: fulfillment.createdAt,
          trackingInfo: (fulfillment.trackingInfo || []).map((tracking: any) => ({
            company: tracking.company,
            number: tracking.number,
            url: tracking.url
          }))
        }));

        return {
          id: order.id,
          name: order.name,
          createdAt: order.createdAt,
          financialStatus: order.displayFinancialStatus,
          fulfillmentStatus: order.displayFulfillmentStatus,
          totalPrice: order.totalPriceSet.shopMoney,
          subtotalPrice: order.subtotalPriceSet.shopMoney,
          totalShippingPrice: order.totalShippingPriceSet.shopMoney,
          totalTax: order.totalTaxSet.shopMoney,
          customer: order.customer
            ? {
                id: order.customer.id,
                firstName: order.customer.firstName,
                lastName: order.customer.lastName,
                email: order.customer.email
              }
            : null,
          shippingAddress: order.shippingAddress,
          lineItems,
          tags: order.tags,
          note: order.note,
          fulfillments
        };
      });

      return { orders };
    } catch (error) {
      console.error("Error fetching orders:", error);
      throw new Error(
        `Failed to fetch orders: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
};

export { getOrders };
