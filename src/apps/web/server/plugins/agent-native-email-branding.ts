import { defineAppConfig } from "@agent-native/core/server";
import { PRODUCT_NAME } from "@muscle-memory/recipe-engine";

export default defineAppConfig({
  app: {
    // This name appears in transactional emails. Change it to your product name.
    name: PRODUCT_NAME,
    // The source template keeps a renamed app from inheriting first-party email branding.
    sourceTemplate: "chat",
    // Operators land on the shop's primary workflow after signing in.
    homePath: "/inbox",
    // Optional: use your own absolute HTTPS logo URL in transactional emails.
    // logoUrl: "https://example.com/logo.png",
  },
});
