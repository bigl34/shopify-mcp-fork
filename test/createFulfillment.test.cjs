const path = require("path");
const { pathToFileURL } = require("url");

let createFulfillment;
let consoleErrorSpy;

function buildFindOrderResponse(order) {
  return {
    orders: {
      edges: order ? [{ node: order }] : []
    }
  };
}

function buildFulfillmentOrder({
  id,
  status = "OPEN",
  supportedActions = ["CREATE_FULFILLMENT"],
  lineItems = []
}) {
  return {
    id,
    status,
    supportedActions: supportedActions.map((action) => ({ action })),
    lineItems: {
      edges: lineItems.map((lineItem) => ({ node: lineItem }))
    }
  };
}

function buildLineItem({ id, sku, remainingQuantity, title = "Item" }) {
  return {
    id,
    remainingQuantity,
    lineItem: {
      sku,
      title
    }
  };
}

function buildOrder({ id, name, fulfillmentOrders }) {
  return {
    id,
    name,
    displayFulfillmentStatus: "UNFULFILLED",
    fulfillmentOrders: {
      edges: fulfillmentOrders.map((fulfillmentOrder) => ({
        node: fulfillmentOrder
      }))
    }
  };
}

function buildMutationSuccess({
  id = "gid://shopify/Fulfillment/1",
  status = "SUCCESS",
  trackingInfo = [{ company: "UPS", number: "TRACK-1", url: null }]
} = {}) {
  return {
    fulfillmentCreateV2: {
      fulfillment: { id, status, trackingInfo },
      userErrors: []
    }
  };
}

function createMockClient(...responses) {
  const queue = [...responses];
  const request = jest.fn(async (_query, variables) => {
    if (queue.length === 0) {
      throw new Error(
        `Unexpected request; no mocked response left for variables: ${JSON.stringify(variables)}`
      );
    }

    const next = queue.shift();
    if (next instanceof Error) {
      throw next;
    }
    if (typeof next === "function") {
      return next(_query, variables);
    }
    return next;
  });

  return { request };
}

beforeAll(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, "../dist/tools/createFulfillment.js")
  ).href;
  ({ createFulfillment } = await import(moduleUrl));
});

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

test("tries 4-digit order first, then 5-digit fallback", async () => {
  const fulfillmentOrder = buildFulfillmentOrder({
    id: "gid://shopify/FulfillmentOrder/101",
    lineItems: [buildLineItem({ id: "li-1", sku: "SKU-1", remainingQuantity: 1 })]
  });

  const order14891 = buildOrder({
    id: "gid://shopify/Order/14891",
    name: "#14891",
    fulfillmentOrders: [fulfillmentOrder]
  });

  const client = createMockClient(
    buildFindOrderResponse(null),
    buildFindOrderResponse(order14891),
    buildMutationSuccess()
  );
  createFulfillment.initialize(client);

  const result = await createFulfillment.execute({
    orderNumber: "1489",
    trackingNumber: "TRACK-1",
    trackingCompany: "UPS",
    notifyCustomer: false
  });

  expect(client.request).toHaveBeenCalledTimes(3);
  expect(client.request.mock.calls[0][1]).toEqual({ query: "name:1489" });
  expect(client.request.mock.calls[1][1]).toEqual({ query: "name:14891" });
  expect(result.orderName).toBe("#14891");
  expect(result.fulfillments).toHaveLength(1);
});

test("allocates partial line-item quantities across multiple fulfillment orders", async () => {
  const fo1 = buildFulfillmentOrder({
    id: "gid://shopify/FulfillmentOrder/201",
    lineItems: [buildLineItem({ id: "li-201", sku: "ALLOC-SKU", remainingQuantity: 1 })]
  });
  const fo2 = buildFulfillmentOrder({
    id: "gid://shopify/FulfillmentOrder/202",
    lineItems: [buildLineItem({ id: "li-202", sku: "ALLOC-SKU", remainingQuantity: 2 })]
  });

  const order = buildOrder({
    id: "gid://shopify/Order/201",
    name: "#12001",
    fulfillmentOrders: [fo1, fo2]
  });

  const client = createMockClient(
    buildFindOrderResponse(order),
    buildMutationSuccess({ id: "gid://shopify/Fulfillment/201" }),
    buildMutationSuccess({ id: "gid://shopify/Fulfillment/202" })
  );
  createFulfillment.initialize(client);

  const result = await createFulfillment.execute({
    orderNumber: "12001",
    trackingNumber: "TRACK-ALLOC",
    trackingCompany: "UPS",
    notifyCustomer: false,
    lineItems: [{ sku: "ALLOC-SKU", quantity: 3 }]
  });

  expect(client.request).toHaveBeenCalledTimes(3);

  const firstMutationVars = client.request.mock.calls[1][1];
  const secondMutationVars = client.request.mock.calls[2][1];

  expect(
    firstMutationVars.fulfillment.lineItemsByFulfillmentOrder[0]
      .fulfillmentOrderLineItems
  ).toEqual([{ id: "li-201", quantity: 1 }]);
  expect(
    secondMutationVars.fulfillment.lineItemsByFulfillmentOrder[0]
      .fulfillmentOrderLineItems
  ).toEqual([{ id: "li-202", quantity: 2 }]);

  expect(result.partial).toBe(true);
  expect(result.fulfillments).toHaveLength(2);
});

test("returns blocked result when fulfillment orders are on hold/scheduled", async () => {
  const blockedOrder = buildOrder({
    id: "gid://shopify/Order/300",
    name: "#13000",
    fulfillmentOrders: [
      buildFulfillmentOrder({
        id: "gid://shopify/FulfillmentOrder/301",
        status: "ON_HOLD",
        supportedActions: [],
        lineItems: []
      }),
      buildFulfillmentOrder({
        id: "gid://shopify/FulfillmentOrder/302",
        status: "SCHEDULED",
        supportedActions: [],
        lineItems: []
      })
    ]
  });

  const client = createMockClient(buildFindOrderResponse(blockedOrder));
  createFulfillment.initialize(client);

  const result = await createFulfillment.execute({
    orderNumber: "13000",
    trackingNumber: "TRACK-BLOCK",
    trackingCompany: "UPS",
    notifyCustomer: false
  });

  expect(client.request).toHaveBeenCalledTimes(1);
  expect(result.blocked).toBe(true);
  expect(result.blockingReasons).toHaveLength(2);
  expect(result.message).toContain("on hold");
  expect(result.message).toContain("scheduled");
});

test("throws when requested line-item quantity exceeds remaining fulfillable quantity", async () => {
  const order = buildOrder({
    id: "gid://shopify/Order/400",
    name: "#14000",
    fulfillmentOrders: [
      buildFulfillmentOrder({
        id: "gid://shopify/FulfillmentOrder/401",
        lineItems: [buildLineItem({ id: "li-401", sku: "SKU-OVER", remainingQuantity: 1 })]
      })
    ]
  });

  const client = createMockClient(buildFindOrderResponse(order));
  createFulfillment.initialize(client);

  await expect(
    createFulfillment.execute({
      orderNumber: "14000",
      trackingNumber: "TRACK-OVER",
      trackingCompany: "UPS",
      notifyCustomer: false,
      lineItems: [{ sku: "SKU-OVER", quantity: 2 }]
    })
  ).rejects.toThrow(
    "Failed to create fulfillment: Requested quantity exceeds fulfillable inventory for SKU SKU-OVER (missing 1)"
  );

  expect(client.request).toHaveBeenCalledTimes(1);
});

test("auto-generates UPS tracking URL when omitted", async () => {
  const order = buildOrder({
    id: "gid://shopify/Order/500",
    name: "#15000",
    fulfillmentOrders: [
      buildFulfillmentOrder({
        id: "gid://shopify/FulfillmentOrder/501",
        lineItems: [buildLineItem({ id: "li-501", sku: "SKU-UPS", remainingQuantity: 1 })]
      })
    ]
  });

  const client = createMockClient(buildFindOrderResponse(order), buildMutationSuccess());
  createFulfillment.initialize(client);

  await createFulfillment.execute({
    orderNumber: "15000",
    trackingNumber: "1Z 123/ABC",
    trackingCompany: "UPS",
    notifyCustomer: false
  });

  const mutationVars = client.request.mock.calls[1][1];
  expect(mutationVars.fulfillment.trackingInfo.url).toBe(
    "https://www.ups.com/track?tracknum=1Z%20123%2FABC"
  );
});

test("returns already fulfilled when order has no fulfillment orders", async () => {
  const order = buildOrder({
    id: "gid://shopify/Order/600",
    name: "#16000",
    fulfillmentOrders: []
  });

  const client = createMockClient(buildFindOrderResponse(order));
  createFulfillment.initialize(client);

  const result = await createFulfillment.execute({
    orderNumber: "16000",
    trackingNumber: "TRACK-DONE",
    trackingCompany: "UPS",
    notifyCustomer: false
  });

  expect(client.request).toHaveBeenCalledTimes(1);
  expect(result.alreadyFulfilled).toBe(true);
  expect(result.message).toBe("Order already fulfilled");
});

test("surfaces Shopify userErrors from fulfillment mutation", async () => {
  const order = buildOrder({
    id: "gid://shopify/Order/700",
    name: "#17000",
    fulfillmentOrders: [
      buildFulfillmentOrder({
        id: "gid://shopify/FulfillmentOrder/701",
        lineItems: [buildLineItem({ id: "li-701", sku: "SKU-ERR", remainingQuantity: 1 })]
      })
    ]
  });

  const mutationWithError = {
    fulfillmentCreateV2: {
      fulfillment: null,
      userErrors: [
        {
          field: ["trackingInfo", "number"],
          message: "Tracking number is invalid"
        }
      ]
    }
  };

  const client = createMockClient(buildFindOrderResponse(order), mutationWithError);
  createFulfillment.initialize(client);

  await expect(
    createFulfillment.execute({
      orderNumber: "17000",
      trackingNumber: "BAD",
      trackingCompany: "UPS",
      notifyCustomer: false
    })
  ).rejects.toThrow(
    "Failed to create fulfillment: Shopify fulfillmentCreateV2 error: trackingInfo.number: Tracking number is invalid"
  );
});
