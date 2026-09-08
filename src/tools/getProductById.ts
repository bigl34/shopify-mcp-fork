import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError } from "../lib/toolUtils.js";

// Input schema for getProductById
const GetProductByIdInputSchema = z.object({
  productId: z.string().min(1),
  variantsFirst: z.number().int().min(1).max(100).default(20),
  variantsAfter: z.string().min(1).optional(),
  metafieldsFirst: z.number().int().min(1).max(100).default(25),
});

type GetProductByIdInput = z.infer<typeof GetProductByIdInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

const getProductById = {
  name: "get-product-by-id",
  description:
    "Get a product with rich catalog, media, variant, collection, SEO, category, and metafield data. Variant results support cursor pagination.",
  schema: GetProductByIdInputSchema,

  // Add initialize method to set up the GraphQL client
  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetProductByIdInput) => {
    try {
      const { productId } = input;

      const query = gql`
        #graphql

        query GetProductById(
          $id: ID!
          $variantsFirst: Int!
          $variantsAfter: String
          $metafieldsFirst: Int!
        ) {
          product(id: $id) {
            id
            legacyResourceId
            title
            description
            handle
            status
            createdAt
            updatedAt
            publishedAt
            totalInventory
            tracksInventory
            hasOnlyDefaultVariant
            hasOutOfStockVariants
            isGiftCard
            requiresSellingPlan
            templateSuffix
            onlineStoreUrl
            onlineStorePreviewUrl
            category {
              id
              name
              fullName
            }
            variantsCount {
              count
            }
            mediaCount {
              count
            }
            priceRangeV2 {
              minVariantPrice {
                amount
                currencyCode
              }
              maxVariantPrice {
                amount
                currencyCode
              }
            }
            media(first: 5) {
              edges {
                node {
                  __typename
                  id
                  alt
                  mediaContentType
                  status
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
                  ... on MediaImage {
                    createdAt
                    updatedAt
                    image {
                      id
                      url
                      altText
                      width
                      height
                    }
                  }
                }
              }
            }
            variants(first: $variantsFirst, after: $variantsAfter) {
              edges {
                node {
                  id
                  title
                  displayName
                  price
                  compareAtPrice
                  inventoryQuantity
                  sku
                  barcode
                  availableForSale
                  taxable
                  createdAt
                  updatedAt
                  image {
                    id
                    url
                    altText
                    width
                    height
                  }
                  selectedOptions {
                    name
                    value
                  }
                  inventoryItem {
                    id
                    tracked
                    requiresShipping
                    unitCost {
                      amount
                      currencyCode
                    }
                    measurement {
                      weight {
                        unit
                        value
                      }
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
            collections(first: 5) {
              edges {
                node {
                  id
                  title
                }
              }
            }
            tags
            vendor
            productType
            descriptionHtml
            seo {
              title
              description
            }
            metafields(first: $metafieldsFirst) {
              edges {
                node {
                  id
                  namespace
                  key
                  value
                  type
                  createdAt
                  updatedAt
                }
              }
              pageInfo {
                hasNextPage
                hasPreviousPage
                startCursor
                endCursor
              }
            }
            options {
              id
              name
              position
              optionValues {
                id
                name
              }
            }
          }
        }
      `;

      const variables = {
        id: productId,
        variantsFirst: input.variantsFirst,
        ...(input.variantsAfter && { variantsAfter: input.variantsAfter }),
        metafieldsFirst: input.metafieldsFirst,
      };

      const data = (await shopifyClient.request(query, variables)) as {
        product: any;
      };

      if (!data.product) {
        throw new Error(`Product with ID ${productId} not found`);
      }

      // Format product data
      const product = data.product;

      // Format variants
      const variants = product.variants.edges.map((variantEdge: any) => ({
        id: variantEdge.node.id,
        title: variantEdge.node.title,
        displayName: variantEdge.node.displayName,
        price: variantEdge.node.price,
        compareAtPrice: variantEdge.node.compareAtPrice,
        inventoryQuantity: variantEdge.node.inventoryQuantity,
        sku: variantEdge.node.sku,
        barcode: variantEdge.node.barcode,
        availableForSale: variantEdge.node.availableForSale,
        taxable: variantEdge.node.taxable,
        createdAt: variantEdge.node.createdAt,
        updatedAt: variantEdge.node.updatedAt,
        image: variantEdge.node.image,
        inventoryItem: variantEdge.node.inventoryItem,
        options: variantEdge.node.selectedOptions,
      }));

      // Format images from media
      const images = product.media.edges
        .filter((mediaEdge: any) => mediaEdge.node.image)
        .map((mediaEdge: any) => ({
          id: mediaEdge.node.id,
          url: mediaEdge.node.image.url,
          altText: mediaEdge.node.image.altText,
          width: mediaEdge.node.image.width,
          height: mediaEdge.node.image.height
        }));

      // Format collections
      const collections = product.collections.edges.map(
        (collectionEdge: any) => ({
          id: collectionEdge.node.id,
          title: collectionEdge.node.title
        })
      );

      const formattedProduct = {
        id: product.id,
        legacyResourceId: product.legacyResourceId,
        title: product.title,
        description: product.description,
        handle: product.handle,
        status: product.status,
        createdAt: product.createdAt,
        updatedAt: product.updatedAt,
        publishedAt: product.publishedAt,
        totalInventory: product.totalInventory,
        tracksInventory: product.tracksInventory,
        hasOnlyDefaultVariant: product.hasOnlyDefaultVariant,
        hasOutOfStockVariants: product.hasOutOfStockVariants,
        isGiftCard: product.isGiftCard,
        requiresSellingPlan: product.requiresSellingPlan,
        templateSuffix: product.templateSuffix,
        onlineStoreUrl: product.onlineStoreUrl,
        onlineStorePreviewUrl: product.onlineStorePreviewUrl,
        category: product.category,
        variantsCount: product.variantsCount?.count ?? null,
        mediaCount: product.mediaCount?.count ?? null,
        priceRange: {
          minPrice: {
            amount: product.priceRangeV2.minVariantPrice.amount,
            currencyCode: product.priceRangeV2.minVariantPrice.currencyCode
          },
          maxPrice: {
            amount: product.priceRangeV2.maxVariantPrice.amount,
            currencyCode: product.priceRangeV2.maxVariantPrice.currencyCode
          }
        },
        images,
        variants,
        variantsPageInfo: product.variants.pageInfo,
        collections,
        tags: product.tags,
        vendor: product.vendor,
        productType: product.productType,
        descriptionHtml: product.descriptionHtml,
        seo: product.seo,
        options: product.options,
        metafields: product.metafields.edges.map((edge: any) => edge.node),
        metafieldsPageInfo: product.metafields.pageInfo,
      };

      return { product: formattedProduct };
    } catch (error) {
      handleToolError("fetch product", error);
    }
  }
};

export { getProductById };
