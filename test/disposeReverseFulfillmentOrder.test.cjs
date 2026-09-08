const path = require("path");
const { pathToFileURL } = require("url");

let disposeReverseFulfillmentOrder;

const LINE_ITEM_ID =
  "gid://shopify/ReverseFulfillmentOrderLineItem/100";
const LOCATION_ID = "gid://shopify/Location/200";

beforeAll(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(
      __dirname,
      "../dist/tools/disposeReverseFulfillmentOrder.js",
    ),
  ).href;
  ({ disposeReverseFulfillmentOrder } = await import(moduleUrl));
});

test("dry-run is the default and performs no Shopify request", async () => {
  const client = { request: jest.fn() };
  disposeReverseFulfillmentOrder.initialize(client);

  const result = await disposeReverseFulfillmentOrder.execute({
    dispositionInputs: [
      {
        reverseFulfillmentOrderLineItemId: LINE_ITEM_ID,
        quantity: 2,
        dispositionType: "NOT_RESTOCKED",
      },
    ],
    dryRun: true,
  });

  expect(client.request).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    dryRun: true,
    totalQuantity: 2,
  });
});

test("requires the exact confirmation before execution", async () => {
  const client = { request: jest.fn() };
  disposeReverseFulfillmentOrder.initialize(client);

  await expect(
    disposeReverseFulfillmentOrder.execute({
      dispositionInputs: [
        {
          reverseFulfillmentOrderLineItemId: LINE_ITEM_ID,
          quantity: 1,
          dispositionType: "MISSING",
        },
      ],
      dryRun: false,
    }),
  ).rejects.toThrow(/requires confirmation/i);
  expect(client.request).not.toHaveBeenCalled();
});

test("RESTOCKED dispositions require a location", () => {
  expect(() =>
    disposeReverseFulfillmentOrder.schema.parse({
      dispositionInputs: [
        {
          reverseFulfillmentOrderLineItemId: LINE_ITEM_ID,
          quantity: 1,
          dispositionType: "RESTOCKED",
        },
      ],
    }),
  ).toThrow(/locationId/i);

  expect(() =>
    disposeReverseFulfillmentOrder.schema.parse({
      dispositionInputs: [
        {
          reverseFulfillmentOrderLineItemId: LINE_ITEM_ID,
          quantity: 1,
          dispositionType: "RESTOCKED",
          locationId: LOCATION_ID,
        },
      ],
    }),
  ).not.toThrow();
});

test("uses the 2026-01 PROCESSING_REQUIRED disposition enum", () => {
  const base = {
    reverseFulfillmentOrderLineItemId: LINE_ITEM_ID,
    quantity: 1,
  };

  expect(() =>
    disposeReverseFulfillmentOrder.schema.parse({
      dispositionInputs: [
        { ...base, dispositionType: "PROCESSING_REQUIRED" },
      ],
    }),
  ).not.toThrow();
  expect(() =>
    disposeReverseFulfillmentOrder.schema.parse({
      dispositionInputs: [{ ...base, dispositionType: "PROCESSING" }],
    }),
  ).toThrow();
});

test("executes the mutation only after confirmation", async () => {
  const disposedLineItems = [
    {
      id: LINE_ITEM_ID,
      totalQuantity: 1,
      dispositions: [
        {
          id: "gid://shopify/ReverseFulfillmentOrderDisposition/300",
          quantity: 1,
          type: "RESTOCKED",
          location: { id: LOCATION_ID, name: "Warehouse" },
        },
      ],
    },
  ];
  const client = {
    request: jest.fn(async () => ({
      reverseFulfillmentOrderDispose: {
        reverseFulfillmentOrderLineItems: disposedLineItems,
        userErrors: [],
      },
    })),
  };
  disposeReverseFulfillmentOrder.initialize(client);
  const dispositionInputs = [
    {
      reverseFulfillmentOrderLineItemId: LINE_ITEM_ID,
      quantity: 1,
      dispositionType: "RESTOCKED",
      locationId: LOCATION_ID,
    },
  ];

  const result = await disposeReverseFulfillmentOrder.execute({
    dispositionInputs,
    dryRun: false,
    confirmation: "DISPOSE_REVERSE_FULFILLMENT_ORDER_ITEMS",
  });

  expect(client.request).toHaveBeenCalledTimes(1);
  expect(client.request.mock.calls[0][1]).toEqual({ dispositionInputs });
  expect(result).toEqual({
    dryRun: false,
    totalQuantity: 1,
    disposedLineItems,
  });
});

test("surfaces Shopify disposal errors", async () => {
  const client = {
    request: jest.fn(async () => ({
      reverseFulfillmentOrderDispose: {
        reverseFulfillmentOrderLineItems: null,
        userErrors: [
          { field: "dispositionInputs.0.quantity", message: "Too many units" },
        ],
      },
    })),
  };
  disposeReverseFulfillmentOrder.initialize(client);

  await expect(
    disposeReverseFulfillmentOrder.execute({
      dispositionInputs: [
        {
          reverseFulfillmentOrderLineItemId: LINE_ITEM_ID,
          quantity: 99,
          dispositionType: "MISSING",
        },
      ],
      dryRun: false,
      confirmation: "DISPOSE_REVERSE_FULFILLMENT_ORDER_ITEMS",
    }),
  ).rejects.toThrow(/too many units/i);
});
