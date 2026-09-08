const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

let fileUpload;
let originalFetch;
let originalUploadRoots;

const LOCAL_FILE = __filename;

function createQueuedClient(...responses) {
  const queue = [...responses];
  return {
    request: jest.fn(async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) throw new Error("Unexpected GraphQL request");
      return next;
    }),
  };
}

beforeAll(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(__dirname, "../dist/tools/fileUpload.js"),
  ).href;
  ({ fileUpload } = await import(moduleUrl));
  originalFetch = global.fetch;
  originalUploadRoots = process.env.SHOPIFY_FILE_UPLOAD_ROOTS;
  process.env.SHOPIFY_FILE_UPLOAD_ROOTS = __dirname;
});

afterEach(() => {
  global.fetch = originalFetch;
  process.env.SHOPIFY_FILE_UPLOAD_ROOTS = __dirname;
});

afterAll(() => {
  if (originalUploadRoots === undefined) {
    delete process.env.SHOPIFY_FILE_UPLOAD_ROOTS;
  } else {
    process.env.SHOPIFY_FILE_UPLOAD_ROOTS = originalUploadRoots;
  }
});

test("dry-run inspects the local file without network or GraphQL", async () => {
  const client = { request: jest.fn() };
  fileUpload.initialize(client);
  global.fetch = jest.fn();

  const result = await fileUpload.execute({
    filePath: LOCAL_FILE,
    mimeType: "text/javascript",
    contentType: "FILE",
    duplicateResolutionMode: "RAISE_ERROR",
    dryRun: true,
  });

  expect(client.request).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    dryRun: true,
    file: {
      filePath: LOCAL_FILE,
      filename: path.basename(LOCAL_FILE),
      mimeType: "text/javascript",
      contentType: "FILE",
    },
    stagedUploadInput: {
      httpMethod: "POST",
      resource: "FILE",
    },
  });
});

test("allows a file inside an explicitly configured staging root", async () => {
  const stagingRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "shopify-file-upload-"),
  );
  const stagedFile = path.join(stagingRoot, "product-manual.txt");
  fs.writeFileSync(stagedFile, "safe staged content", { mode: 0o600 });
  process.env.SHOPIFY_FILE_UPLOAD_ROOTS = stagingRoot;

  try {
    const client = { request: jest.fn() };
    fileUpload.initialize(client);
    global.fetch = jest.fn();

    const result = await fileUpload.execute({
      filePath: stagedFile,
      mimeType: "text/plain",
      contentType: "FILE",
      duplicateResolutionMode: "RAISE_ERROR",
      dryRun: true,
    });

    expect(result).toMatchObject({
      dryRun: true,
      file: {
        filePath: stagedFile,
        filename: "product-manual.txt",
        size: 19,
      },
    });
    expect(client.request).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
});

test.each([
  ["/etc/passwd", "outside the configured staging root"],
  [path.join(__dirname, "creds", "shopify-token.txt"), "a credentials path"],
  [path.join(__dirname, ".env.production"), "an environment file"],
])("rejects %s when it is %s without leaking the path", async (filePath) => {
  const client = { request: jest.fn() };
  fileUpload.initialize(client);
  global.fetch = jest.fn();

  let rejection;
  try {
    await fileUpload.execute({
      filePath,
      mimeType: "text/plain",
      contentType: "FILE",
      duplicateResolutionMode: "RAISE_ERROR",
      dryRun: true,
    });
  } catch (error) {
    rejection = error;
  }

  expect(rejection).toBeInstanceOf(Error);
  expect(rejection.message).toMatch(/not allowed/i);
  expect(rejection.message).not.toContain(filePath);
  expect(client.request).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});

test("fails closed when no upload staging roots are configured", async () => {
  delete process.env.SHOPIFY_FILE_UPLOAD_ROOTS;
  const client = { request: jest.fn() };
  fileUpload.initialize(client);
  global.fetch = jest.fn();

  await expect(
    fileUpload.execute({
      filePath: LOCAL_FILE,
      mimeType: "text/javascript",
      contentType: "FILE",
      duplicateResolutionMode: "RAISE_ERROR",
      dryRun: true,
    }),
  ).rejects.toThrow(/uploads are disabled/i);

  expect(client.request).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});

test("rejects execution without exact confirmation before any network call", async () => {
  const client = { request: jest.fn() };
  fileUpload.initialize(client);
  global.fetch = jest.fn();

  await expect(
    fileUpload.execute({
      filePath: LOCAL_FILE,
      mimeType: "text/javascript",
      contentType: "FILE",
      duplicateResolutionMode: "RAISE_ERROR",
      dryRun: false,
    }),
  ).rejects.toThrow(/requires confirmation/i);

  expect(client.request).not.toHaveBeenCalled();
  expect(global.fetch).not.toHaveBeenCalled();
});

test("stages, uploads, creates, and reads back the file", async () => {
  const stagedTarget = {
    url: "https://staged.example.test/upload",
    resourceUrl: "https://staged.example.test/resource/file.js",
    parameters: [{ name: "key", value: "uploads/file.js" }],
  };
  const createdFile = {
    __typename: "GenericFile",
    id: "gid://shopify/GenericFile/10",
    alt: "Test file",
    createdAt: "2026-08-04T10:00:00Z",
    updatedAt: "2026-08-04T10:00:00Z",
    fileStatus: "PROCESSING",
  };
  const readbackFile = {
    ...createdFile,
    fileStatus: "READY",
    mimeType: "text/javascript",
    originalFileSize: 123,
    url: "https://cdn.shopify.com/file.js",
  };
  const client = createQueuedClient(
    {
      stagedUploadsCreate: {
        stagedTargets: [stagedTarget],
        userErrors: [],
      },
    },
    {
      fileCreate: {
        files: [createdFile],
        userErrors: [],
      },
    },
    { nodes: [readbackFile] },
  );
  fileUpload.initialize(client);
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 204,
    statusText: "No Content",
  }));

  const result = await fileUpload.execute({
    filePath: LOCAL_FILE,
    filename: "file.js",
    mimeType: "text/javascript",
    contentType: "FILE",
    alt: "Test file",
    duplicateResolutionMode: "RAISE_ERROR",
    dryRun: false,
    confirmation: "UPLOAD_FILE_TO_SHOPIFY",
  });

  expect(client.request).toHaveBeenCalledTimes(3);
  expect(client.request.mock.calls[0][1].input[0]).toMatchObject({
    filename: "file.js",
    mimeType: "text/javascript",
    httpMethod: "POST",
    resource: "FILE",
  });
  expect(global.fetch).toHaveBeenCalledTimes(1);
  expect(global.fetch.mock.calls[0][0]).toBe(stagedTarget.url);
  expect(client.request.mock.calls[1][1]).toEqual({
    files: [
      {
        originalSource: stagedTarget.resourceUrl,
        filename: "file.js",
        contentType: "FILE",
        duplicateResolutionMode: "RAISE_ERROR",
        alt: "Test file",
      },
    ],
  });
  expect(client.request.mock.calls[2][1]).toEqual({
    ids: [createdFile.id],
  });
  expect(result).toMatchObject({
    dryRun: false,
    createdFiles: [createdFile],
    readbackFiles: [readbackFile],
  });
});

test("stops on stagedUploadsCreate user errors", async () => {
  const client = createQueuedClient({
    stagedUploadsCreate: {
      stagedTargets: null,
      userErrors: [{ field: "input.0.mimeType", message: "Unsupported type" }],
    },
  });
  fileUpload.initialize(client);
  global.fetch = jest.fn();

  await expect(
    fileUpload.execute({
      filePath: LOCAL_FILE,
      mimeType: "application/x-unknown",
      contentType: "FILE",
      duplicateResolutionMode: "RAISE_ERROR",
      dryRun: false,
      confirmation: "UPLOAD_FILE_TO_SHOPIFY",
    }),
  ).rejects.toThrow(/unsupported type/i);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(client.request).toHaveBeenCalledTimes(1);
});

test("stops when the staged HTTP upload fails", async () => {
  const client = createQueuedClient({
    stagedUploadsCreate: {
      stagedTargets: [
        {
          url: "https://staged.example.test/upload",
          resourceUrl: "https://staged.example.test/resource/file.js",
          parameters: [],
        },
      ],
      userErrors: [],
    },
  });
  fileUpload.initialize(client);
  global.fetch = jest.fn(async () => ({
    ok: false,
    status: 403,
    statusText: "Forbidden",
  }));

  await expect(
    fileUpload.execute({
      filePath: LOCAL_FILE,
      mimeType: "text/javascript",
      contentType: "FILE",
      duplicateResolutionMode: "RAISE_ERROR",
      dryRun: false,
      confirmation: "UPLOAD_FILE_TO_SHOPIFY",
    }),
  ).rejects.toThrow(/HTTP 403 Forbidden/i);
  expect(client.request).toHaveBeenCalledTimes(1);
});

test("stops on fileCreate user errors without readback", async () => {
  const client = createQueuedClient(
    {
      stagedUploadsCreate: {
        stagedTargets: [
          {
            url: "https://staged.example.test/upload",
            resourceUrl: "https://staged.example.test/resource/file.js",
            parameters: [],
          },
        ],
        userErrors: [],
      },
    },
    {
      fileCreate: {
        files: null,
        userErrors: [
          {
            field: "files.0.filename",
            message: "Filename already exists",
            code: "FILENAME_ALREADY_EXISTS",
          },
        ],
      },
    },
  );
  fileUpload.initialize(client);
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 204,
    statusText: "No Content",
  }));

  await expect(
    fileUpload.execute({
      filePath: LOCAL_FILE,
      filename: "file.js",
      mimeType: "text/javascript",
      contentType: "FILE",
      duplicateResolutionMode: "RAISE_ERROR",
      dryRun: false,
      confirmation: "UPLOAD_FILE_TO_SHOPIFY",
    }),
  ).rejects.toThrow(/filename already exists/i);
  expect(client.request).toHaveBeenCalledTimes(2);
});
