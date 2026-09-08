import { readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  delimiter,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { checkUserErrors, handleToolError } from "../lib/toolUtils.js";

const FileContentTypeSchema = z.enum([
  "IMAGE",
  "FILE",
  "VIDEO",
  "MODEL_3D",
]);

const FileUploadInputSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .refine(isAbsolute, "filePath must be an absolute path")
    .describe(
      "Absolute path to a local file beneath a SHOPIFY_FILE_UPLOAD_ROOTS staging directory",
    ),
  filename: z
    .string()
    .min(1)
    .optional()
    .describe("Shopify filename; defaults to the local basename"),
  mimeType: z.string().min(1).describe("File MIME type"),
  contentType: FileContentTypeSchema,
  alt: z.string().max(512).optional(),
  duplicateResolutionMode: z
    .enum(["APPEND_UUID", "RAISE_ERROR", "REPLACE"])
    .default("RAISE_ERROR"),
  dryRun: z.boolean().default(true),
  confirmation: z
    .literal("UPLOAD_FILE_TO_SHOPIFY")
    .optional()
    .describe("Required exact confirmation phrase when dryRun is false"),
});

type FileUploadInput = z.infer<typeof FileUploadInputSchema>;

type StagedUploadTarget = {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
};

let shopifyClient: GraphQLClient;

const UPLOAD_ROOTS_ENV = "SHOPIFY_FILE_UPLOAD_ROOTS";
const DENIED_PATH_SEGMENTS = new Set([
  ".aws",
  ".azure",
  ".config",
  ".docker",
  ".gnupg",
  ".kube",
  ".npm",
  ".pki",
  ".ssh",
  "auth",
  "config",
  "credentials",
  "creds",
  "secret",
  "secrets",
  "token",
  "tokens",
]);

const STAGED_UPLOADS_CREATE_MUTATION = gql`
  #graphql

  mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FILE_CREATE_MUTATION = gql`
  #graphql

  mutation FileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        __typename
        id
        alt
        createdAt
        updatedAt
        fileStatus
      }
      userErrors {
        code
        field
        message
      }
    }
  }
`;

const GET_FILES_BY_ID_QUERY = gql`
  #graphql

  query GetFilesById($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      id
      ... on File {
        alt
        createdAt
        updatedAt
        fileStatus
        fileErrors {
          code
          details
          message
        }
        preview {
          status
          image {
            id
            url
            altText
            width
            height
          }
        }
      }
      ... on GenericFile {
        mimeType
        originalFileSize
        url
      }
      ... on MediaImage {
        mimeType
        image {
          id
          url
          altText
          width
          height
        }
      }
      ... on Video {
        duration
        filename
      }
      ... on Model3d {
        filename
      }
    }
  }
`;

function stagedResourceFor(
  contentType: z.infer<typeof FileContentTypeSchema>,
): "IMAGE" | "FILE" | "VIDEO" | "MODEL_3D" {
  return contentType;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) &&
      relativePath !== ".." &&
      !isAbsolute(relativePath))
  );
}

function hasDeniedPathSegment(candidate: string): boolean {
  return resolve(candidate)
    .split(sep)
    .filter(Boolean)
    .some((segment) => {
      const normalized = segment.toLowerCase();
      return (
        normalized.startsWith(".env") ||
        DENIED_PATH_SEGMENTS.has(normalized)
      );
    });
}

function configuredUploadRoots(): string[] {
  const rawRoots = process.env[UPLOAD_ROOTS_ENV];
  if (!rawRoots) {
    throw new Error(
      `local file uploads are disabled; configure ${UPLOAD_ROOTS_ENV} with one or more absolute staging directories`,
    );
  }

  const roots = rawRoots
    .split(delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
  if (roots.length === 0 || roots.some((root) => !isAbsolute(root))) {
    throw new Error(
      `${UPLOAD_ROOTS_ENV} must contain one or more absolute staging directories`,
    );
  }

  return roots.map((root) => resolve(root));
}

async function authorizeUploadPath(filePath: string): Promise<string> {
  const requestedPath = resolve(filePath);
  if (hasDeniedPathSegment(requestedPath)) {
    throw new Error("filePath is not allowed for local file upload");
  }

  const configuredRoots = configuredUploadRoots();
  const candidateRoots = configuredRoots.filter((root) =>
    isPathWithin(root, requestedPath),
  );
  if (candidateRoots.length === 0) {
    throw new Error("filePath is not allowed for local file upload");
  }

  let canonicalPath: string;
  let canonicalRoots: string[];
  try {
    [canonicalPath, ...canonicalRoots] = await Promise.all([
      realpath(requestedPath),
      ...candidateRoots.map((root) => realpath(root)),
    ]);
  } catch {
    throw new Error(
      "filePath is unavailable or the local upload staging configuration is invalid",
    );
  }
  if (
    hasDeniedPathSegment(canonicalPath) ||
    !canonicalRoots.some((root) => isPathWithin(root, canonicalPath))
  ) {
    throw new Error("filePath is not allowed for local file upload");
  }

  return canonicalPath;
}

async function uploadToStagedTarget(
  target: StagedUploadTarget,
  file: Uint8Array,
  filename: string,
  mimeType: string,
): Promise<void> {
  const form = new FormData();
  for (const parameter of target.parameters) {
    form.append(parameter.name, parameter.value);
  }
  form.append("file", new Blob([file], { type: mimeType }), filename);

  const response = await fetch(target.url, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(
      `staged file upload failed with HTTP ${response.status} ${response.statusText}`,
    );
  }
}

const fileUpload = {
  name: "file-upload",
  description:
    "Upload one local file to Shopify Files through a staged upload and fileCreate. Defaults to dry-run and requires exact confirmation for execution. Never touches theme assets.",
  schema: FileUploadInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: FileUploadInput) => {
    try {
      const authorizedFilePath = await authorizeUploadPath(input.filePath);
      const fileInfo = await stat(authorizedFilePath);
      if (!fileInfo.isFile()) {
        throw new Error("filePath is not a regular file");
      }

      const filename = input.filename ?? basename(authorizedFilePath);
      const stagedUploadInput = {
        filename,
        mimeType: input.mimeType,
        httpMethod: "POST",
        resource: stagedResourceFor(input.contentType),
        fileSize: String(fileInfo.size),
      };
      const createInput = {
        originalSource: "<staged resource URL>",
        filename,
        contentType: input.contentType,
        duplicateResolutionMode: input.duplicateResolutionMode,
        ...(input.alt !== undefined && { alt: input.alt }),
      };

      if (input.dryRun) {
        return {
          dryRun: true,
          file: {
            filePath: input.filePath,
            filename,
            size: fileInfo.size,
            mimeType: input.mimeType,
            contentType: input.contentType,
          },
          stagedUploadInput,
          wouldCreate: createInput,
        };
      }

      if (input.confirmation !== "UPLOAD_FILE_TO_SHOPIFY") {
        throw new Error(
          "file-upload requires confirmation='UPLOAD_FILE_TO_SHOPIFY' when dryRun is false",
        );
      }

      // Read the already-authorized canonical path before any network request.
      // This keeps path validation adjacent to the only local-content read and
      // prevents a staged target being created for an unreadable local file.
      const file = await readFile(authorizedFilePath);

      const stagedData = (await shopifyClient.request(
        STAGED_UPLOADS_CREATE_MUTATION,
        { input: [stagedUploadInput] },
      )) as {
        stagedUploadsCreate: {
          stagedTargets: StagedUploadTarget[] | null;
          userErrors: Array<{ field: string; message: string }>;
        };
      };

      checkUserErrors(
        stagedData.stagedUploadsCreate.userErrors,
        "create staged file upload",
      );
      const stagedTarget = stagedData.stagedUploadsCreate.stagedTargets?.[0];
      if (!stagedTarget) {
        throw new Error("stagedUploadsCreate returned no upload target");
      }

      await uploadToStagedTarget(
        stagedTarget,
        file,
        filename,
        input.mimeType,
      );

      const finalCreateInput = {
        ...createInput,
        originalSource: stagedTarget.resourceUrl,
      };
      const createData = (await shopifyClient.request(FILE_CREATE_MUTATION, {
        files: [finalCreateInput],
      })) as {
        fileCreate: {
          files: Array<{
            id: string;
            [key: string]: unknown;
          }> | null;
          userErrors: Array<{
            field: string;
            message: string;
            code?: string;
          }>;
        };
      };

      checkUserErrors(createData.fileCreate.userErrors, "create Shopify file");
      const createdFiles = createData.fileCreate.files ?? [];
      if (createdFiles.length === 0) {
        throw new Error("fileCreate returned no file records");
      }

      const readbackData = (await shopifyClient.request(GET_FILES_BY_ID_QUERY, {
        ids: createdFiles.map((createdFile) => createdFile.id),
      })) as {
        nodes: Array<Record<string, unknown> | null>;
      };

      return {
        dryRun: false,
        stagedUpload: {
          filename,
          size: fileInfo.size,
          mimeType: input.mimeType,
          contentType: input.contentType,
        },
        createdFiles,
        readbackFiles: readbackData.nodes.filter(
          (node): node is Record<string, unknown> => node !== null,
        ),
      };
    } catch (error) {
      handleToolError("upload file", error);
    }
  },
};

export { fileUpload };
