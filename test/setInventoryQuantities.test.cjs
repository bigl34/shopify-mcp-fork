const path = require("path");
const { pathToFileURL } = require("url");

let setInventoryQuantities;

function createMockClient(response) {
  return {
    request: jest.fn(async () => response),
  };
}

beforeAll(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, "../dist/tools/setInventoryQuantities.js"),
  ).href;
  ({ setInventoryQuantities } = await import(moduleUrl));
});

test("requires an idempotency key and current quantity for every write", () => {
  const base = {
    reason: "correction",
    name: "available",
    quantities: [
      {
        inventoryItemId: "gid://shopify/InventoryItem/1",
        locationId: "gid://shopify/Location/2",
        quantity: 7,
      },
    ],
  };

  expect(() => setInventoryQuantities.schema.parse(base)).toThrow();
  expect(() =>
    setInventoryQuantities.schema.parse({
      ...base,
      idempotencyKey: "inventory-job-1",
    }),
  ).toThrow();
  expect(() =>
    setInventoryQuantities.schema.parse({
      ...base,
      idempotencyKey: "inventory-job-1",
      quantities: [{ ...base.quantities[0], changeFromQuantity: 6 }],
    }),
  ).not.toThrow();
});

test("uses @idempotent and forwards changeFromQuantity", async () => {
  const adjustmentGroup = {
    createdAt: "2026-08-04T10:00:00Z",
    reason: "correction",
    referenceDocumentUri: "gid://warehouse/CycleCount/42",
    changes: [{ name: "available", delta: 1, quantityAfterChange: 7 }],
  };
  const client = createMockClient({
    inventorySetQuantities: {
      inventoryAdjustmentGroup: adjustmentGroup,
      userErrors: [],
    },
  });
  setInventoryQuantities.initialize(client);

  const result = await setInventoryQuantities.execute({
    idempotencyKey: "inventory-job-1",
    reason: "correction",
    name: "available",
    referenceDocumentUri: "gid://warehouse/CycleCount/42",
    quantities: [
      {
        inventoryItemId: "gid://shopify/InventoryItem/1",
        locationId: "gid://shopify/Location/2",
        quantity: 7,
        changeFromQuantity: 6,
      },
    ],
  });

  expect(client.request).toHaveBeenCalledTimes(1);
  const [query, variables] = client.request.mock.calls[0];
  expect(query).toContain("@idempotent(key: $idempotencyKey)");
  expect(variables).toEqual({
    idempotencyKey: "inventory-job-1",
    input: {
      reason: "correction",
      name: "available",
      referenceDocumentUri: "gid://warehouse/CycleCount/42",
      quantities: [
        {
          inventoryItemId: "gid://shopify/InventoryItem/1",
          locationId: "gid://shopify/Location/2",
          quantity: 7,
          changeFromQuantity: 6,
        },
      ],
    },
  });
  expect(result).toEqual({
    idempotencyKey: "inventory-job-1",
    adjustmentGroup,
  });
});

test("surfaces Shopify compare-and-set user errors", async () => {
  const client = createMockClient({
    inventorySetQuantities: {
      inventoryAdjustmentGroup: null,
      userErrors: [
        {
          field: "quantities.0.changeFromQuantity",
          message: "The quantity changed",
          code: "COMPARE_QUANTITY_STALE",
        },
      ],
    },
  });
  setInventoryQuantities.initialize(client);

  await expect(
    setInventoryQuantities.execute({
      idempotencyKey: "inventory-job-2",
      reason: "correction",
      name: "available",
      quantities: [
        {
          inventoryItemId: "gid://shopify/InventoryItem/1",
          locationId: "gid://shopify/Location/2",
          quantity: 7,
          changeFromQuantity: 6,
        },
      ],
    }),
  ).rejects.toThrow(/quantity changed/i);
});
