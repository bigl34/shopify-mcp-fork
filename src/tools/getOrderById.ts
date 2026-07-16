import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError, edgesToNodes } from "../lib/toolUtils.js";
import { formatLineItems, formatOrderSummary } from "../lib/formatters.js";

// Input schema for getOrderById
const GetOrderByIdInputSchema = z.object({
  orderId: z.string().min(1)
});

type GetOrderByIdInput = z.infer<typeof GetOrderByIdInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const getOrderById = {
  name: "get-order-by-id",
  description: "Get a specific order by ID",
  schema: GetOrderByIdInputSchema,

  // Add initialize method to set up the GraphQL client
  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetOrderByIdInput) => {
    try {
      const { orderId } = input;

      // Smart lookup: detect format and resolve to GID
      let resolvedId: string;
      const trimmed = orderId.trim();

      if (trimmed.startsWith("gid://")) {
        // Already a full GID
        resolvedId = trimmed;
      } else if (/^#?\d{1,9}$/.test(trimmed)) {
        // Short number or #number — treat as order name, query by name
        const orderName = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
        const nameQuery = gql`
          #graphql

          query FindOrderByName($query: String!) {
            orders(first: 1, query: $query) {
              edges {
                node {
                  id
                }
              }
            }
          }
        `;
        const nameData = (await shopifyClient.request(nameQuery, {
          query: `name:${orderName}`,
        })) as { orders: { edges: Array<{ node: { id: string } }> } };

        if (nameData.orders.edges.length === 0) {
          throw new Error(`Order with name ${orderName} not found`);
        }
        resolvedId = nameData.orders.edges[0].node.id;
      } else if (/^\d+$/.test(trimmed)) {
        // Long numeric ID — convert to GID
        resolvedId = `gid://shopify/Order/${trimmed}`;
      } else {
        // Unknown format — try as-is
        resolvedId = trimmed;
      }

      const query = gql`
        #graphql

        query GetOrderById($id: ID!) {
          order(id: $id) {
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
              defaultEmailAddress {
                emailAddress
              }
              defaultPhoneNumber {
                phoneNumber
              }
            }
            shippingAddress {
              name
              firstName
              lastName
              company
              address1
              address2
              city
              provinceCode
              zip
              country
              countryCodeV2
              phone
            }
            lineItems(first: 20) {
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
            billingAddress {
              address1
              address2
              city
              provinceCode
              zip
              country
              company
              phone
              firstName
              lastName
            }
            cancelReason
            cancelledAt
            updatedAt
            returnStatus
            processedAt
            poNumber
            discountCodes
            currentTotalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            metafields(first: 20) {
              edges {
                node {
                  id
                  namespace
                  key
                  value
                  type
                }
              }
            }
            fulfillments {
              id
              status
              displayStatus
              createdAt
              estimatedDeliveryAt
              trackingInfo {
                company
                number
                url
              }
            }
            totalDiscountsSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            discountCodes
            cancelledAt
            closedAt
            updatedAt
            refunds {
              id
              createdAt
              note
              totalRefundedSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              refundLineItems(first: 20) {
                edges {
                  node {
                    lineItem {
                      title
                      sku
                    }
                    quantity
                    subtotalSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
              }
            }
            returns(first: 5) {
              edges {
                node {
                  id
                  status
                }
              }
            }
            transactions(first: 20) {
              id
              kind
              status
              amountSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              gateway
              formattedGateway
              createdAt
            }
            fulfillmentOrders(first: 10) {
              edges {
                node {
                  id
                  status
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
      `;

      const variables = {
        id: resolvedId
      };

      const data = (await shopifyClient.request(query, variables)) as {
        order: any;
      };

      if (!data.order) {
        throw new Error(`Order with ID ${orderId} not found`);
      }

      // Extract and format order data
      const order = data.order;

      const base = formatOrderSummary(order);

      // Format fulfillments (our custom addition, not in upstream's formatOrderSummary)
      const fulfillments = (order.fulfillments || []).map((fulfillment: any) => ({
        id: fulfillment.id,
        status: fulfillment.status,
        displayStatus: fulfillment.displayStatus,
        createdAt: fulfillment.createdAt,
        estimatedDeliveryAt: fulfillment.estimatedDeliveryAt,
        trackingInfo: (fulfillment.trackingInfo || []).map((tracking: any) => ({
          company: tracking.company,
          number: tracking.number,
          url: tracking.url
        }))
      }));

      // Format fulfillment orders (our custom addition for fulfillment workflow support)
      const fulfillmentOrders = (order.fulfillmentOrders?.edges || []).map((foEdge: any) => {
        const fo = foEdge.node;
        return {
          id: fo.id,
          status: fo.status,
          lineItems: (fo.lineItems?.edges || []).map((liEdge: any) => {
            const li = liEdge.node;
            return {
              id: li.id,
              remainingQuantity: li.remainingQuantity,
              sku: li.lineItem?.sku,
              title: li.lineItem?.title,
            };
          }),
        };
      });
      const formattedOrder = {
        ...base,
        customer: order.customer
          ? {
              ...base.customer,
              phone: order.customer.defaultPhoneNumber?.phoneNumber || null,
            }
          : null,
        billingAddress: order.billingAddress,
        cancelReason: order.cancelReason,
        cancelledAt: order.cancelledAt,
        updatedAt: order.updatedAt,
        returnStatus: order.returnStatus,
        processedAt: order.processedAt,
        poNumber: order.poNumber,
        discountCodes: order.discountCodes,
        currentTotalPrice: order.currentTotalPriceSet?.shopMoney,
        metafields: edgesToNodes(order.metafields),
        fulfillments,
        fulfillmentOrders
      };

      return { order: formattedOrder };
    } catch (error) {
      handleToolError("fetch order", error);
    }
  }
};

export { getOrderById };
