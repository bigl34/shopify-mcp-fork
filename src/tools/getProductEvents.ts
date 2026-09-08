import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError } from "../lib/toolUtils.js";

const GetProductEventsInputSchema = z.object({
  productId: z.string().min(1).describe("Product GID or numeric product ID"),
  first: z.number().int().min(1).max(100).default(50),
  after: z.string().min(1).optional(),
  query: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional event query, for example 'action:update created_at:>2026-01-01'",
    ),
});

type GetProductEventsInput = z.infer<typeof GetProductEventsInputSchema>;

let shopifyClient: GraphQLClient;

const getProductEvents = {
  name: "get-product-events",
  description:
    "Read the retained timeline events for a product with cursor pagination and optional Shopify event search syntax.",
  schema: GetProductEventsInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetProductEventsInput) => {
    try {
      const productId = input.productId.startsWith("gid://")
        ? input.productId
        : `gid://shopify/Product/${input.productId}`;

      const query = gql`
        #graphql

        query GetProductEvents(
          $id: ID!
          $first: Int!
          $after: String
          $query: String
        ) {
          product(id: $id) {
            id
            title
            events(first: $first, after: $after, query: $query) {
              edges {
                node {
                  __typename
                  id
                  action
                  appTitle
                  attributeToApp
                  attributeToUser
                  createdAt
                  criticalAlert
                  message
                  ... on BasicEvent {
                    additionalContent
                    additionalData
                    arguments
                    actor: author
                    hasAdditionalContent
                    secondaryMessage
                    subjectId
                    subjectType
                  }
                  ... on CommentEvent {
                    canDelete
                    canEdit
                    edited
                    rawMessage
                    commentAuthor: author {
                      id
                      name
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
        }
      `;

      const data = (await shopifyClient.request(query, {
        id: productId,
        first: input.first,
        ...(input.after && { after: input.after }),
        ...(input.query && { query: input.query }),
      })) as {
        product: {
          id: string;
          title: string;
          events: {
            edges: Array<{ node: Record<string, unknown> }>;
            pageInfo: Record<string, unknown>;
          };
        } | null;
      };

      if (!data.product) {
        throw new Error(`Product not found: ${productId}`);
      }

      return {
        productId: data.product.id,
        productTitle: data.product.title,
        events: data.product.events.edges.map((edge) => edge.node),
        pageInfo: data.product.events.pageInfo,
      };
    } catch (error) {
      handleToolError("fetch product events", error);
    }
  },
};

export { getProductEvents };
