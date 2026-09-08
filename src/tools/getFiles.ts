import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError } from "../lib/toolUtils.js";

const GetFilesInputSchema = z.object({
  first: z.number().int().min(1).max(100).default(50),
  after: z.string().min(1).optional(),
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional Shopify file search query, for example 'filename:manual.pdf status:ready'",
    ),
  reverse: z.boolean().default(false),
});

type GetFilesInput = z.infer<typeof GetFilesInputSchema>;

let shopifyClient: GraphQLClient;

const getFiles = {
  name: "get-files",
  description:
    "Read Shopify Files metadata with type-specific image, video, model, and generic-file details. Does not alter files or themes.",
  schema: GetFilesInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetFilesInput) => {
    try {
      const query = gql`
        #graphql

        query GetFiles(
          $first: Int!
          $after: String
          $query: String
          $reverse: Boolean!
        ) {
          files(
            first: $first
            after: $after
            query: $query
            reverse: $reverse
          ) {
            edges {
              node {
                __typename
                id
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
                  imageOriginalSource: originalSource {
                    fileSize
                    url
                  }
                }
                ... on Video {
                  duration
                  filename
                  videoOriginalSource: originalSource {
                    format
                    height
                    mimeType
                    url
                    width
                  }
                  sources {
                    format
                    height
                    mimeType
                    url
                    width
                  }
                }
                ... on Model3d {
                  filename
                  modelOriginalSource: originalSource {
                    filesize
                    format
                    mimeType
                    url
                  }
                  sources {
                    filesize
                    format
                    mimeType
                    url
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              hasPreviousPage
              startCursor
              endCursor
            }
          }
        }
      `;

      const data = (await shopifyClient.request(query, {
        first: input.first,
        reverse: input.reverse,
        ...(input.after && { after: input.after }),
        ...(input.query && { query: input.query }),
      })) as {
        files: {
          edges: Array<{ node: Record<string, unknown> }>;
          pageInfo: Record<string, unknown>;
        };
      };

      return {
        files: data.files.edges.map((edge) => edge.node),
        pageInfo: data.files.pageInfo,
      };
    } catch (error) {
      handleToolError("fetch files", error);
    }
  },
};

export { getFiles };
