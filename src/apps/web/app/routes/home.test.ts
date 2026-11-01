import { describe, expect, it } from "vitest";

import { loader, clientLoader } from "./home";

describe("legacy home route", () => {
  it("redirects direct requests and client-side navigation to the inbox", () => {
    for (const redirectHome of [loader, clientLoader]) {
      const result = redirectHome();
      expect(result.status).toBe(302);
      expect(result.headers.get("Location")).toBe("/inbox");
    }
  });
});
