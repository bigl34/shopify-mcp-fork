const path = require("path");
const { pathToFileURL } = require("url");

let getOrderById;

function buildOrder(overrides = {}) {
  return {
    id: "gid://shopify/Order/123",
    name: "#123",
    createdAt: "2026-08-28T10:00:00Z",
    displayFinancialStatus: "PARTIALLY_REFUNDED",
    displayFulfillmentStatus: "FULFILLED",
    totalPriceSet: {
      shopMoney: { amount: "120.00", currencyCode: "GBP" },
    },
    subtotalPriceSet: {
      shopMoney: { amount: "100.00", currencyCode: "GBP" },
    },
    totalShippingPriceSet: {
      shopMoney: { amount: "10.00", currencyCode: "GBP" },
    },
    totalTaxSet: {
      shopMoney: { amount: "10.00", currencyCode: "GBP" },
    },
    customer: null,
    shippingAddress: null,
    billingAddress: null,
    lineItems: { edges: [] },
    tags: [],
    note: null,
    metafields: { edges: [] },
    fulfillments: [],
    fulfillmentOrders: { edges: [] },
    ...overrides,
  };
}

beforeAll(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, "../dist/tools/getOrderById.js"),
  ).href;
  ({ getOrderById } = await import(moduleUrl));
});

test("returns queried refunds and transactions in the formatted order wrapper", async () => {
  const refunds = [
    {
      id: "gid://shopify/Refund/456",
      createdAt: "2026-08-28T11:00:00Z",
      note: "Partial refund",
      totalRefundedSet: {
        shopMoney: { amount: "20.00", currencyCode: "GBP" },
      },
      refundLineItems: {
        edges: [
          {
            node: {
              lineItem: { title: "Replacement part", sku: "PART-1" },
              quantity: 1,
              subtotalSet: {
                shopMoney: { amount: "20.00", currencyCode: "GBP" },
              },
            },
          },
        ],
      },
    },
  ];
  const transactions = [
    {
      id: "gid://shopify/OrderTransaction/789",
      kind: "REFUND",
      status: "SUCCESS",
      amountSet: {
        shopMoney: { amount: "20.00", currencyCode: "GBP" },
      },
      gateway: "shopify_payments",
      formattedGateway: "Shopify Payments",
      createdAt: "2026-08-28T11:00:01Z",
    },
  ];
  const client = {
    request: jest.fn(async () => ({
      order: buildOrder({ refunds, transactions }),
    })),
  };
  getOrderById.initialize(client);

  const result = await getOrderById.execute({
    orderId: "gid://shopify/Order/123",
  });

  expect(client.request).toHaveBeenCalledTimes(1);
  expect(client.request.mock.calls[0][0]).toContain("refunds {");
  expect(client.request.mock.calls[0][0]).toContain("transactions(first: 20)");
  expect(client.request.mock.calls[0][1]).toEqual({
    id: "gid://shopify/Order/123",
  });
  expect(result).toMatchObject({
    order: {
      id: "gid://shopify/Order/123",
      financialStatus: "PARTIALLY_REFUNDED",
      fulfillmentStatus: "FULFILLED",
      refunds,
      transactions,
    },
  });
  expect(result.order.refunds).toEqual(refunds);
  expect(result.order.transactions).toEqual(transactions);
});

test("preserves empty refund and transaction collections", async () => {
  const client = {
    request: jest.fn(async () => ({
      order: buildOrder({ refunds: [], transactions: [] }),
    })),
  };
  getOrderById.initialize(client);

  const result = await getOrderById.execute({
    orderId: "gid://shopify/Order/123",
  });

  expect(result).toMatchObject({
    order: {
      refunds: [],
      transactions: [],
    },
  });
});
