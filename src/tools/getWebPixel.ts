import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError } from "../lib/toolUtils.js";

const GetWebPixelInputSchema = z.object({
  id: z
    .string()
    .regex(
      /^gid:\/\/shopify\/WebPixel\/\d+$/,
      "id must be a WebPixel GID",
    )
    .optional(),
});

type GetWebPixelInput = z.infer<typeof GetWebPixelInputSchema>;

let shopifyClient: GraphQLClient;

const getWebPixel = {
  name: "get-web-pixel",
  description:
    "Read the authenticated app's web pixel registration and settings, optionally by WebPixel GID.",
  schema: GetWebPixelInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetWebPixelInput) => {
    try {
      const query = gql`
        #graphql

        query GetWebPixel($id: ID) {
          webPixel(id: $id) {
            id
            settings
          }
        }
      `;

      const data = (await shopifyClient.request(query, {
        ...(input.id && { id: input.id }),
      })) as {
        webPixel: { id: string; settings: unknown } | null;
      };

      return { webPixel: data.webPixel };
    } catch (error) {
      handleToolError("fetch web pixel", error);
    }
  },
};

export { getWebPixel };
