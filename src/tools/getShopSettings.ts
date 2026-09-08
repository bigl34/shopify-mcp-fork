import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError } from "../lib/toolUtils.js";

const GetShopSettingsInputSchema = z.object({});
type GetShopSettingsInput = z.infer<typeof GetShopSettingsInputSchema>;

let shopifyClient: GraphQLClient;

const getShopSettings = {
  name: "get-shop-settings",
  description:
    "Read operational shop settings, currencies, locale, taxes, payments, plan, features, and addresses.",
  schema: GetShopSettingsInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (_input: GetShopSettingsInput) => {
    try {
      const query = gql`
        #graphql

        query GetShopSettings {
          shop {
            id
            name
            email
            contactEmail
            myshopifyDomain
            primaryDomain {
              url
              host
            }
            plan {
              publicDisplayName
              partnerDevelopment
              shopifyPlus
            }
            currencyCode
            enabledPresentmentCurrencies
            ianaTimezone
            timezoneAbbreviation
            unitSystem
            weightUnit
            taxShipping
            taxesIncluded
            setupRequired
            checkoutApiSupported
            customerAccounts
            shipsToCountries
            features {
              giftCards
              reports
              storefront
              harmonizedSystemCode
              avalaraAvatax
              sellsSubscriptions
            }
            paymentSettings {
              supportedDigitalWallets
            }
            shopAddress {
              address1
              address2
              city
              province
              provinceCode
              country
              countryCodeV2
              zip
              phone
            }
            billingAddress {
              address1
              address2
              city
              province
              provinceCode
              country
              countryCodeV2
              zip
              phone
            }
          }
        }
      `;

      const data = (await shopifyClient.request(query)) as {
        shop: Record<string, unknown>;
      };

      return { shop: data.shop };
    } catch (error) {
      handleToolError("fetch shop settings", error);
    }
  },
};

export { getShopSettings };
