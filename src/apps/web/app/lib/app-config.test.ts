import { describe, expect, it } from "vitest";
import { APP_NAME, APP_TITLE } from "./app-config";

describe("workspace identity", () => {
  it("combines both pure package exports in the app title", () => {
    expect(APP_NAME).toBe("muscle-memory");
    expect(APP_TITLE).toBe("Muscle Memory · Kiln & Co.");
  });
});
