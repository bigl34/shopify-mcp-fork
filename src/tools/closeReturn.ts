import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";

// Initialized in index.ts with the shared GraphQL client.
let shopifyClient: GraphQLClient;

const CloseReturnInputSchema = z.object({
  returnId: z.string().min(1),
  // dryRun reports what would happen (after the state preflight) without
  // issuing the returnClose mutation. The CLI wrapper defaults this to true
  // and only sets it false on an explicit, id-matched --confirm.
  dryRun: z.boolean().default(false),
});

type CloseReturnInput = z.infer<typeof CloseReturnInputSchema>;

// State-machine preflight query: fetch the return and its current status.
const RETURN_STATUS_QUERY = gql`
  query ReturnStatus($id: ID!) {
    return(id: $id) {
      id
      name
      status
      order {
        id
        name
      }
    }
  }
`;

const RETURN_CLOSE_MUTATION = gql`
  mutation returnClose($id: ID!) {
    returnClose(id: $id) {
      return {
        id
        name
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

type ReturnNode = {
  id: string;
  name: string | null;
  status: string;
  order: { id: string; name: string | null } | null;
};

type ReturnCloseResponse = {
  returnClose: {
    return: { id: string; name: string | null; status: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

const closeReturn = {
  name: "close-return",
  description:
    "Close an OPEN Shopify return (returnClose mutation). Runs a state " +
    "preflight first and refuses any return not in OPEN status. With " +
    "dryRun=true it reports what would happen without mutating anything.",
  schema: CloseReturnInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: CloseReturnInput) => {
    const { returnId, dryRun } = input;

    // State-machine preflight — fetch the return and verify it is OPEN.
    // returnClose only transitions an OPEN return to CLOSED; refusing any
    // other state here gives a clear error instead of an opaque userError.
    const statusData = (await shopifyClient.request(RETURN_STATUS_QUERY, {
      id: returnId,
    })) as { return: ReturnNode | null };

    const returnNode = statusData.return;
    if (!returnNode) {
      throw new Error(`close-return: no return found for id ${returnId}`);
    }

    if (returnNode.status !== "OPEN") {
      throw new Error(
        `close-return: return ${returnId} has status '${returnNode.status}', ` +
        `not 'OPEN' — only an OPEN return can be closed`
      );
    }

    if (dryRun) {
      return {
        dryRun: true,
        wouldClose: {
          id: returnNode.id,
          name: returnNode.name,
          status: returnNode.status,
          order: returnNode.order,
        },
      };
    }

    const result = (await shopifyClient.request(RETURN_CLOSE_MUTATION, {
      id: returnId,
    })) as ReturnCloseResponse;

    const payload = result.returnClose;
    const userErrors = payload?.userErrors ?? [];
    if (userErrors.length > 0) {
      const formatted = userErrors
        .map((e) => `${(e.field ?? []).join(".")}: ${e.message}`)
        .join(", ");
      throw new Error(`close-return: Shopify returned errors: ${formatted}`);
    }

    if (!payload?.return) {
      throw new Error("close-return: returnClose returned no return record");
    }

    return {
      dryRun: false,
      closed: payload.return,
    };
  },
};

export { closeReturn };
