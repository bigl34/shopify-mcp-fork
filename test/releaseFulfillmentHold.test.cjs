const path = require("path");
const { pathToFileURL } = require("url");

let releaseFulfillmentHold;
let consoleErrorSpy;

const VALID_GID = "gid://shopify/FulfillmentOrder/1234567890";

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
    return next;
  });

  return { request };
}

beforeAll(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, "../dist/tools/releaseFulfillmentHold.js")
  ).href;
  ({ releaseFulfillmentHold } = await import(moduleUrl));
});

beforeEach(() => {
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

test("returns a normalized snapshot with empty fulfillmentHolds on success", async () => {
  const client = createMockClient({
    fulfillmentOrderReleaseHold: {
      fulfillmentOrder: {
        id: VALID_GID,
        status: "OPEN",
        requestStatus: "UNSUBMITTED",
        fulfillmentHolds: []
      },
      userErrors: []
    }
  });
  releaseFulfillmentHold.initialize(client);

  const result = await releaseFulfillmentHold.execute({
    fulfillmentOrderId: VALID_GID
  });

  expect(client.request).toHaveBeenCalledTimes(1);
  expect(client.request.mock.calls[0][1]).toEqual({ id: VALID_GID });
  expect(result).toEqual({
    fulfillmentOrderId: VALID_GID,
    status: "OPEN",
    requestStatus: "UNSUBMITTED",
    fulfillmentHolds: []
  });
});

test("throws a descriptive error when Shopify returns userErrors", async () => {
  const client = createMockClient({
    fulfillmentOrderReleaseHold: {
      fulfillmentOrder: null,
      userErrors: [
        { field: "id", message: "Fulfillment order is not on hold" }
      ]
    }
  });
  releaseFulfillmentHold.initialize(client);

  await expect(
    releaseFulfillmentHold.execute({ fulfillmentOrderId: VALID_GID })
  ).rejects.toThrow(/release fulfillment hold/i);
});

test("rejects a fulfillmentOrderId that is not a FulfillmentOrder GID at the schema level", () => {
  expect(() =>
    releaseFulfillmentHold.schema.parse({ fulfillmentOrderId: "not-a-gid" })
  ).toThrow();

  expect(() =>
    releaseFulfillmentHold.schema.parse({
      fulfillmentOrderId: "gid://shopify/Order/123"
    })
  ).toThrow();

  expect(() =>
    releaseFulfillmentHold.schema.parse({ fulfillmentOrderId: VALID_GID })
  ).not.toThrow();
});
