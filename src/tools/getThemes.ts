import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError } from "../lib/toolUtils.js";

const ThemeRoleSchema = z.enum([
  "MAIN",
  "UNPUBLISHED",
  "DEMO",
  "DEVELOPMENT",
  "ARCHIVED",
  "LOCKED",
]);

const GetThemesInputSchema = z.object({
  first: z.number().int().min(1).max(100).default(50),
  after: z.string().min(1).optional(),
  roles: z.array(ThemeRoleSchema).min(1).optional(),
  names: z.array(z.string().min(1)).min(1).optional(),
  reverse: z.boolean().default(false),
});

type GetThemesInput = z.infer<typeof GetThemesInputSchema>;

let shopifyClient: GraphQLClient;

const getThemes = {
  name: "get-themes",
  description:
    "Read online-store theme metadata only. This tool never reads, changes, publishes, or uploads theme files or assets.",
  schema: GetThemesInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetThemesInput) => {
    try {
      const query = gql`
        #graphql

        query GetThemes(
          $first: Int!
          $after: String
          $roles: [ThemeRole!]
          $names: [String!]
          $reverse: Boolean!
        ) {
          themes(
            first: $first
            after: $after
            roles: $roles
            names: $names
            reverse: $reverse
          ) {
            edges {
              node {
                id
                name
                role
                prefix
                createdAt
                updatedAt
                processing
                processingFailed
                themeStoreId
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
        ...(input.roles && { roles: input.roles }),
        ...(input.names && { names: input.names }),
      })) as {
        themes: {
          edges: Array<{ node: Record<string, unknown> }>;
          pageInfo: Record<string, unknown>;
        };
      };

      return {
        themes: data.themes.edges.map((edge) => edge.node),
        pageInfo: data.themes.pageInfo,
      };
    } catch (error) {
      handleToolError("fetch themes", error);
    }
  },
};

export { getThemes };
