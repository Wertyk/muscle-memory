import { describe, expect, it } from "vitest";

import type {
  Demonstration,
  DemonstrationScope,
  DemonstrationStep,
} from "../domain/demonstration.js";
import type { JsonObject } from "../domain/model.js";
import { Demonstrations } from "./demonstrations.js";
import type { DemonstrationRecords, TraceStore } from "./ports.js";

const scope: DemonstrationScope = {
  userId: "operator@example.test",
  workspaceId: "shop",
  sessionId: "tab_a",
};
function setup() {
  const rows = new Map<string, Demonstration>();
  const matches = (d: Demonstration, s: DemonstrationScope) =>
    Object.entries(s).every(
      ([k, v]) => d.scope[k as keyof DemonstrationScope] === v,
    );
  let failure = false;
  const records: DemonstrationRecords = {
    active: async (s) =>
      [...rows.values()].find(
        (d) => matches(d, s) && d.status === "recording",
      ) ?? null,
    latest: async (s, subjectId) =>
      [...rows.values()]
        .reverse()
        .find((d) => matches(d, s) && d.subjectId === subjectId) ?? null,
    get: async (owner, id) => {
      const d = rows.get(id);
      return d &&
        d.scope.userId === owner.userId &&
        d.scope.workspaceId === owner.workspaceId
        ? (JSON.parse(JSON.stringify(d)) as Demonstration)
        : null;
    },
    save: async (d) => {
      if (failure) {
        failure = false;
        throw new Error("offline");
      }
      rows.set(d.id, JSON.parse(JSON.stringify(d)) as Demonstration);
    },
  };
  let queue = Promise.resolve();
  const store: TraceStore = {
    transaction: (work) => {
      const result = queue.then(() => work(records));
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  let id = 0;
  let now = 100;
  const service = new Demonstrations(
    store,
    { now: () => now++ },
    () => `demo_${++id}`,
  );
  const start = (s = scope, subjectId = "req_a") =>
    service.start({
      scope: s,
      subjectId,
      references: {
        requestId: subjectId,
        orderId: "ord_a",
        customerId: "cus_a",
      },
      trigger: { requestId: subjectId, type: "damage" },
    });
  const begin = (
    s = scope,
    subjectId = "req_a",
    references = { orderId: "ord_a" },
  ) => service.begin({ scope: s, subjectId, references });
  return {
    service,
    start,
    begin,
    fail: () => {
      failure = true;
    },
  };
}
const step = (action: string) => ({
  action,
  input: { orderId: "ord_a" },
  output: { id: "ord_a" },
  caller: "frontend",
  navigation: { view: "request", requestId: "req_a" },
  startedAt: 101,
  durationMs: 3,
});

describe("demonstrations", () => {
  it("records only while active and retains the complete trace after stop", async () => {
    const { service, start, begin } = setup();
    expect(await begin()).toBeNull();
    const demo = await start();
    const ticket = (await begin())!;
    await service.complete(scope, ticket, step("get-order"));
    const stopped = await service.finish(scope, demo.id);
    expect(stopped.status).toBe("completed");
    expect(stopped.steps).toEqual([
      { ...step("get-order"), id: "step_1", sequence: 1 },
    ]);
    expect(await begin()).toBeNull();
    expect(await service.get(scope, demo.id)).toEqual(stopped);
    expect(await service.current(scope, "req_a")).toEqual(stopped);
  });
  it("reserves invocation order even if concurrent actions complete backwards", async () => {
    const { service, start, begin } = setup();
    const demo = await start();
    const [one, two] = await Promise.all([begin(), begin()]);
    await service.complete(scope, two!, step("send-reply"));
    await service.complete(scope, one!, step("get-order"));
    await service.complete(scope, one!, step("ignored duplicate"));
    expect(
      (await service.get(scope, demo.id))?.steps.map((s) => s.action),
    ).toEqual(["get-order", "send-reply"]);
  });
  it("keeps the first read output across refetches and canonicalizes nested object key order", async () => {
    const { service, start } = setup();
    const demo = await start();
    const input: JsonObject = {
      filter: { status: "open", tags: ["priority", "damage"] },
      limit: 5,
    };
    const read = { action: "lookup", input };
    const begin = (identity = read) =>
      service.begin({
        scope,
        subjectId: "req_a",
        references: {},
        read: identity,
      });
    const first = (await begin())!;
    await service.complete(
      scope,
      first,
      { ...step("lookup"), input, output: { snapshot: "first" } },
      "read",
    );
    expect(
      await begin({
        action: "lookup",
        input: {
          limit: 5,
          filter: { tags: ["priority", "damage"], status: "open" },
        },
      }),
    ).toBeNull();
    const distinct = {
      action: "lookup",
      input: {
        limit: 5,
        filter: { tags: ["damage", "priority"], status: "open" },
      },
    };
    const second = (await begin(distinct))!;
    await service.complete(
      scope,
      second,
      {
        ...step("lookup"),
        input: distinct.input,
        output: { snapshot: "different array order" },
      },
      "read",
    );
    expect(
      (await service.finish(scope, demo.id)).steps.map((s) => s.output),
    ).toEqual([{ snapshot: "first" }, { snapshot: "different array order" }]);
    await start();
    expect(await begin()).not.toBeNull(); // Deduplication resets with each demonstration.
  });

  it("retains the first invocation when identical reads finish in reverse order", async () => {
    const { service, start } = setup();
    const demo = await start();
    const read = { action: "get-order", input: { orderId: "ord_a" } };
    const begin = () =>
      service.begin({ scope, subjectId: "req_a", references: {}, read });
    const [first, second] = await Promise.all([begin(), begin()]);
    await service.complete(
      scope,
      second!,
      { ...step(read.action), output: { snapshot: "second" }, startedAt: 102 },
      "read",
    );
    await service.complete(
      scope,
      first!,
      { ...step(read.action), output: { snapshot: "first" } },
      "read",
    );
    const saved = await service.finish(scope, demo.id);
    expect(saved.steps).toEqual([
      {
        ...step(read.action),
        output: { snapshot: "first" },
        id: "step_1",
        sequence: 1,
      },
    ]);
    expect(saved.pending).toEqual([]);
  });

  it("records identical mutations every time and permits a read after its first attempt rejects", async () => {
    const { service, start, begin } = setup();
    const demo = await start();
    const read = { action: "get-order", input: { orderId: "ord_a" } };
    const beginRead = () =>
      service.begin({ scope, subjectId: "req_a", references: {}, read });
    await service.complete(scope, (await beginRead())!, null, "read");
    await service.complete(
      scope,
      (await beginRead())!,
      step(read.action),
      "read",
    );
    const mutation: Omit<DemonstrationStep, "id" | "sequence"> = {
      ...step("tag-request"),
      input: { tag: "handled" },
      output: { tags: ["handled"] },
    };
    await service.complete(scope, (await begin())!, mutation);
    await service.complete(scope, (await begin())!, mutation);
    expect(
      (await service.finish(scope, demo.id)).steps.map((s) => s.action),
    ).toEqual(["get-order", "tag-request", "tag-request"]);
  });

  it("isolates user, workspace, tab, request and related entity references", async () => {
    const { service, start, begin } = setup();
    const demo = await start();
    for (const other of [
      { ...scope, userId: "other@example.test" },
      { ...scope, workspaceId: "elsewhere" },
      { ...scope, sessionId: "tab_b" },
    ]) {
      expect(await begin(other)).toBeNull();
      expect(await service.current(other, "req_a")).toBeNull();
      await expect(service.finish(other, demo.id)).rejects.toThrow("not found");
    }
    expect(await begin(scope, "req_b")).toBeNull();
    expect(await begin(scope, "req_a", { orderId: "ord_b" })).toBeNull();
    expect(
      await service.get({ ...scope, userId: "other@example.test" }, demo.id),
    ).toBeNull();
    expect(
      await service.get({ ...scope, workspaceId: "elsewhere" }, demo.id),
    ).toBeNull();
    const anotherSession = { ...scope, sessionId: "tab_b" };
    expect(await service.get(anotherSession, demo.id)).toEqual(demo); // Owned retrieval by ID works across sessions.
  });
  it("rejects overlapping starts; cancellation frees the slot and late completion cannot enter another demo", async () => {
    const { service, start, begin } = setup();
    const demo = await start();
    const ticket = (await begin())!;
    await expect(start(scope, "req_b")).rejects.toThrow("already recording");
    await service.finish(scope, demo.id, true);
    const next = await start(scope, "req_b");
    await service.complete(scope, ticket, step("get-order"));
    expect((await service.get(scope, demo.id))?.steps).toEqual([]);
    expect((await service.get(scope, next.id))?.steps).toEqual([]);
  });
  it("never claims completeness after stop races or interrupted captures", async () => {
    const { service, start, begin } = setup();
    const demo = await start();
    const ticket = (await begin())!;
    expect((await service.finish(scope, demo.id)).status).toBe("incomplete");
    await service.complete(scope, ticket, step("get-order"));
    expect((await service.finish(scope, demo.id)).status).toBe("incomplete");
  });
  it("marks a failed append incomplete without losing prior steps or the durable pending reservation", async () => {
    const { service, start, begin, fail } = setup();
    const demo = await start();
    const one = (await begin())!;
    await service.complete(scope, one, step("get-order"));
    const two = (await begin())!;
    fail();
    await expect(
      service.complete(scope, two, step("issue-refund")),
    ).rejects.toThrow();
    await service.incomplete(
      scope,
      demo.id,
      "Could not save issue-refund; shop action succeeded.",
    );
    const saved = (await service.get(scope, demo.id))!;
    expect(saved.status).toBe("incomplete");
    expect(saved.incompleteReason).toContain("issue-refund");
    expect(saved.steps).toHaveLength(1);
    expect(saved.pending).toEqual([2]);
    expect(await begin()).toBeNull();
  });
  it("drops rejected actions without adding an executable step", async () => {
    const { service, start, begin } = setup();
    const demo = await start();
    await service.complete(scope, (await begin())!, null);
    expect((await service.finish(scope, demo.id)).status).toBe("completed");
    expect((await service.get(scope, demo.id))?.steps).toEqual([]);
  });
});
