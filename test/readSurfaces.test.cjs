const path = require("path");
const { pathToFileURL } = require("url");

let getProductEvents;
let getFiles;
let getShopSettings;
let getAppScopes;
let getWebPixel;
let getThemes;
let tools;

async function importTool(filename, exportName) {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, `../dist/tools/${filename}.js`),
  ).href;
  return (await import(moduleUrl))[exportName];
}

beforeAll(async () => {
  getProductEvents = await importTool(
    "getProductEvents",
    "getProductEvents",
  );
  getFiles = await importTool("getFiles", "getFiles");
  getShopSettings = await importTool("getShopSettings", "getShopSettings");
  getAppScopes = await importTool("getAppScopes", "getAppScopes");
  getWebPixel = await importTool("getWebPixel", "getWebPixel");
  getThemes = await importTool("getThemes", "getThemes");
  tools = await importTool("registry", "tools");
});

test("registry exposes the new read-only discovery tools", () => {
  const names = tools.map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining([
      "get-product-events",
      "get-files",
      "get-shop-settings",
      "get-app-scopes",
      "get-web-pixel",
      "get-themes",
    ]),
  );
});

test("get-product-events paginates and normalizes a numeric product ID", async () => {
  const pageInfo = {
    hasNextPage: true,
    hasPreviousPage: false,
    startCursor: "event-1",
    endCursor: "event-2",
  };
  const event = {
    __typename: "BasicEvent",
    id: "gid://shopify/BasicEvent/1",
    action: "update",
  };
  const client = {
    request: jest.fn(async () => ({
      product: {
        id: "gid://shopify/Product/10",
        title: "Product",
        events: { edges: [{ node: event }], pageInfo },
      },
    })),
  };
  getProductEvents.initialize(client);

  const result = await getProductEvents.execute({
    productId: "10",
    first: 25,
    after: "event-0",
    query: "action:update",
  });

  expect(client.request.mock.calls[0][1]).toEqual({
    id: "gid://shopify/Product/10",
    first: 25,
    after: "event-0",
    query: "action:update",
  });
  expect(result).toEqual({
    productId: "gid://shopify/Product/10",
    productTitle: "Product",
    events: [event],
    pageInfo,
  });
});

test("get-files returns type-specific nodes and cursor state", async () => {
  const pageInfo = {
    hasNextPage: false,
    hasPreviousPage: true,
    startCursor: "file-1",
    endCursor: "file-1",
  };
  const file = {
    __typename: "GenericFile",
    id: "gid://shopify/GenericFile/1",
    fileStatus: "READY",
    mimeType: "application/pdf",
  };
  const client = {
    request: jest.fn(async () => ({
      files: { edges: [{ node: file }], pageInfo },
    })),
  };
  getFiles.initialize(client);

  const result = await getFiles.execute({
    first: 10,
    after: "file-0",
    query: "filename:manual.pdf",
    reverse: true,
  });

  expect(client.request.mock.calls[0][1]).toEqual({
    first: 10,
    reverse: true,
    after: "file-0",
    query: "filename:manual.pdf",
  });
  expect(result).toEqual({ files: [file], pageInfo });
});

test("get-shop-settings returns the shop snapshot", async () => {
  const shop = {
    id: "gid://shopify/Shop/1",
    name: "Test shop",
    currencyCode: "GBP",
  };
  const client = { request: jest.fn(async () => ({ shop })) };
  getShopSettings.initialize(client);

  await expect(getShopSettings.execute({})).resolves.toEqual({ shop });
  expect(client.request).toHaveBeenCalledTimes(1);
});

test("get-app-scopes returns both details and convenient handles", async () => {
  const currentAppInstallation = {
    id: "gid://shopify/AppInstallation/1",
    app: { id: "gid://shopify/App/2", title: "Test app", handle: "test" },
    accessScopes: [
      { handle: "read_products", description: "Read products" },
      { handle: "read_files", description: "Read files" },
    ],
  };
  const client = {
    request: jest.fn(async () => ({ currentAppInstallation })),
  };
  getAppScopes.initialize(client);

  await expect(getAppScopes.execute({})).resolves.toEqual({
    appInstallation: currentAppInstallation,
    scopeHandles: ["read_products", "read_files"],
  });
});

test("get-web-pixel accepts an optional WebPixel GID", async () => {
  const webPixel = {
    id: "gid://shopify/WebPixel/1",
    settings: { accountId: "example" },
  };
  const client = { request: jest.fn(async () => ({ webPixel })) };
  getWebPixel.initialize(client);

  await expect(
    getWebPixel.execute({ id: webPixel.id }),
  ).resolves.toEqual({ webPixel });
  expect(client.request.mock.calls[0][1]).toEqual({ id: webPixel.id });
});

test("get-themes validates roles and returns metadata only", async () => {
  const pageInfo = {
    hasNextPage: false,
    hasPreviousPage: false,
    startCursor: "theme-1",
    endCursor: "theme-1",
  };
  const theme = {
    id: "gid://shopify/OnlineStoreTheme/1",
    name: "Live",
    role: "MAIN",
    prefix: "themes/1",
  };
  const client = {
    request: jest.fn(async () => ({
      themes: { edges: [{ node: theme }], pageInfo },
    })),
  };
  getThemes.initialize(client);

  const result = await getThemes.execute({
    first: 5,
    after: "theme-0",
    roles: ["MAIN"],
    names: ["Live"],
    reverse: false,
  });

  expect(client.request.mock.calls[0][1]).toEqual({
    first: 5,
    reverse: false,
    after: "theme-0",
    roles: ["MAIN"],
    names: ["Live"],
  });
  expect(result).toEqual({ themes: [theme], pageInfo });
  expect(client.request.mock.calls[0][0]).not.toContain("files(");
});
