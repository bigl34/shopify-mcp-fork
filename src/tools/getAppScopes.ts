import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError } from "../lib/toolUtils.js";

const GetAppScopesInputSchema = z.object({});
type GetAppScopesInput = z.infer<typeof GetAppScopesInputSchema>;

let shopifyClient: GraphQLClient;

const getAppScopes = {
  name: "get-app-scopes",
  description:
    "Read the access scopes currently granted to the authenticated Shopify app.",
  schema: GetAppScopesInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (_input: GetAppScopesInput) => {
    try {
      const query = gql`
        #graphql

        query GetAppScopes {
          currentAppInstallation {
            id
            app {
              id
              title
              handle
            }
            accessScopes {
              handle
              description
            }
          }
        }
      `;

      const data = (await shopifyClient.request(query)) as {
        currentAppInstallation: {
          id: string;
          app: Record<string, unknown>;
          accessScopes: Array<{ handle: string; description: string }>;
        };
      };

      return {
        appInstallation: data.currentAppInstallation,
        scopeHandles: data.currentAppInstallation.accessScopes.map(
          (scope) => scope.handle,
        ),
      };
    } catch (error) {
      handleToolError("fetch app scopes", error);
    }
  },
};

export { getAppScopes };
