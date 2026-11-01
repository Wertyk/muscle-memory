import { defineAction } from "@agent-native/core/action";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { traced, type CapturedAction } from "./traced";

describe("traced action run", () => {
  it("captures validated input/output, caller, navigation at entry, and elapsed time", async () => {
    const steps: CapturedAction[] = [];
    const navigation = { view: "request", requestId: "req_0007" };
    const clock = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(125);
    const action = defineAction({
      description: "Trace test",
      audit: { enabled: false },
      schema: z.object({
        orderId: z.string(),
        tag: z.string().default("damaged"),
      }),
      run: traced(
        "tag-order",
        async (input) => {
          navigation.requestId = "req_0008";
          input.tag = "handled";
          return { orderId: input.orderId, tags: [input.tag] };
        },
        {
          recording: async () => ({
            append: async (step) => {
              steps.push(step);
            },
          }),
          navigation: async () => navigation,
          now: clock,
        },
      ),
    });
    const result = await action.run(
      { orderId: "ord_1042" },
      { caller: "frontend" },
    );
    result.tags.push("later");
    expect(steps).toEqual([
      {
        actionName: "tag-order",
        input: { orderId: "ord_1042", tag: "damaged" },
        output: { orderId: "ord_1042", tags: ["handled"] },
        caller: "frontend",
        navigation: { view: "request", requestId: "req_0007" },
        startedAt: 100,
        durationMs: 25,
      },
    ]);
  });

  it("does no snapshot work while off and resolves recording per caller", async () => {
    const navigation = vi.fn();
    const append = vi.fn();
    const context = {
      caller: "frontend" as const,
      userEmail: "operator@example.test",
    };
    const recording = vi.fn(async () => null);
    const run = traced("mutate", async () => ({ ok: true }), {
      recording,
      navigation,
    });
    await expect(run({}, context)).resolves.toEqual({ ok: true });
    expect(recording).toHaveBeenCalledWith(context);
    expect(navigation).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("keeps the session captured at entry when the active recording changes", async () => {
    const first = vi.fn();
    const second = vi.fn();
    let active = { append: first };
    const run = traced(
      "mutate",
      async () => {
        active = { append: second };
        return 7;
      },
      {
        recording: async () => active,
        navigation: async () => null,
      },
    );
    await run({});
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
  });

  it("does not record rejected calls and propagates persistence failures", async () => {
    const append = vi.fn();
    const capture = {
      recording: async () => ({ append }),
      navigation: async () => null,
    };
    await expect(
      traced(
        "fail",
        async () => {
          throw new Error("rejected");
        },
        capture,
      )({}),
    ).rejects.toThrow("rejected");
    expect(append).not.toHaveBeenCalled();
    append.mockRejectedValue(new Error("store unavailable"));
    await expect(traced("mutate", async () => 1, capture)({})).rejects.toThrow(
      "store unavailable",
    );
  });
});
