const path = require("path");
const { pathToFileURL } = require("url");

let getProductVariantsDetailed;

beforeAll(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(
      __dirname,
      "../dist/tools/getProductVariantsDetailed.js",
    ),
  ).href;
  ({ getProductVariantsDetailed } = await import(moduleUrl));
});

test("forwards after and returns complete pageInfo", async () => {
  const pageInfo = {
    hasNextPage: true,
    hasPreviousPage: true,
    startCursor: "variant-start",
    endCursor: "variant-end",
  };
  const client = {
    request: jest.fn(async () => ({
      product: {
        id: "gid://shopify/Product/10",
        title: "Test product",
        variants: {
          edges: [
            {
              node: {
                id: "gid://shopify/ProductVariant/11",
                media: { edges: [] },
                metafields: { edges: [] },
              },
            },
          ],
          pageInfo,
        },
      },
    })),
  };
  getProductVariantsDetailed.initialize(client);

  const result = await getProductVariantsDetailed.execute({
    productId: "10",
    first: 25,
    after: "previous-page-end",
  });

  expect(client.request.mock.calls[0][1]).toEqual({
    id: "gid://shopify/Product/10",
    first: 25,
    after: "previous-page-end",
  });
  expect(client.request.mock.calls[0][0]).toContain(
    "variants(first: $first, after: $after)",
  );
  expect(result.pageInfo).toEqual(pageInfo);
  expect(result.variantsCount).toBe(1);
});
