import { describe, expect, it, vi } from "vitest";

import { APP_TITLE } from "@/lib/app-config";

import { meta as threadMeta } from "./chat.$threadId";
import { meta as indexMeta } from "./chat._index";

vi.mock("@/components/chat/ChatRouteContent", () => ({ default: () => null }));
vi.mock("@/components/chat/ChatHomeRedirect", () => ({ default: () => null }));

describe("chat route metadata exports", () => {
  it.each([
    ["/chat", indexMeta],
    ["/chat/:threadId", threadMeta],
  ] as const)(
    "%s provides product metadata independently of the home redirect",
    (_path, meta) => {
      const descriptors = meta();
      expect(descriptors).toContainEqual({
        title: expect.stringContaining(APP_TITLE),
      });
      expect(descriptors).toContainEqual({
        name: "description",
        content: expect.stringContaining("customer requests"),
      });
    },
  );
});
