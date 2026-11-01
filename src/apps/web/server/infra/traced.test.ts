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
            incomplete: async () => {},
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
    expect(recording).toHaveBeenCalledWith(context, {
      actionName: "mutate",
      input: {},
    });
    expect(navigation).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  it("keeps the session captured at entry when the active recording changes", async () => {
    const first = vi.fn();
    const second = vi.fn();
    let active = { append: first, incomplete: vi.fn() };
    const run = traced(
      "mutate",
      async () => {
        active = { append: second, incomplete: vi.fn() };
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

  it("does not record rejected calls; returns successful output exactly once when persistence fails", async () => {
    const append = vi.fn();
    const incomplete = vi.fn();
    const capture = {
      recording: async () => ({ append, incomplete }),
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
    const mutation = vi.fn(async () => 1);
    await expect(traced("mutate", mutation, capture)({})).resolves.toBe(1);
    expect(mutation).toHaveBeenCalledOnce();
    expect(incomplete).toHaveBeenCalledWith(
      expect.stringContaining("shop action succeeded"),
    );
    incomplete.mockRejectedValue(new Error("still unavailable"));
    await expect(traced("mutate", mutation, capture)({})).resolves.toBe(1);
    expect(mutation).toHaveBeenCalledTimes(2);
  });
});
