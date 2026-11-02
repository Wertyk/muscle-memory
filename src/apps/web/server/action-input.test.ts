import { ActionInputValidationError } from "@agent-native/core/action";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonContainerInput } from "./action-input.js";

const object = z.object({ count: z.number().int().positive() }).strict();
const array = z.array(object).min(1);

describe("JSON container action input", () => {
  it("accepts native and stringified objects and arrays with the original validation", () => {
    for (const [schema, kind, value] of [[object, "object", { count: 2 }], [array, "array", [{ count: 2 }]]] as const) {
      const input = jsonContainerInput(schema, "value", kind);
      expect(input.parse(value)).toEqual(value);
      expect(input.parse(JSON.stringify(value))).toEqual(value);
      expect(z.toJSONSchema(input, { io: "input" })).toEqual(z.toJSONSchema(schema, { io: "input" }));
    }
  });

  it("retains nested data, transforms and optional fields", () => {
    const schema = z.object({ name: z.string().trim(), items: array, extra: z.string().optional() });
    const value = { name: " Example ", items: [{ count: 2 }] };
    expect(jsonContainerInput(schema, "value").parse(JSON.stringify(value))).toEqual(schema.parse(value));
    expect(jsonContainerInput(array, "items", "array").optional().parse(undefined)).toBeUndefined();
  });

  it.each(["null", "42", "true", '"text"', "[]", null, 42, true])("preserves the original object error for %s", (value) => {
    expect(jsonContainerInput(object, "value").safeParse(value).error?.issues).toEqual(object.safeParse(value).error?.issues);
  });

  it.each(["null", "42", "false", '"text"', "{}", null, 42, false])("preserves the original array error for %s", (value) => {
    expect(jsonContainerInput(array, "items", "array").safeParse(value).error?.issues).toEqual(array.safeParse(value).error?.issues);
  });

  it("rejects schema-invalid parsed values with the original field errors", () => {
    for (const [schema, kind, value] of [[object, "object", { count: -1 }], [array, "array", [{ count: "2" }]]] as const) {
      expect(jsonContainerInput(schema, "value", kind).safeParse(JSON.stringify(value)).error?.issues).toEqual(schema.safeParse(value).error?.issues);
    }
  });

  it("parses either container without coercing legacy scalar JSON values", () => {
    const schema = jsonContainerInput(z.json(), "trigger", "object-or-array");
    expect(schema.parse('{"items":[1]}')).toEqual({ items: [1] });
    expect(schema.parse('[{"count":2}]')).toEqual([{ count: 2 }]);
    expect(schema.parse("42")).toBe("42");
  });

  it.each(["{bad", "[bad", "garbage", ""])("reports malformed JSON %s without repairing it", (value) => {
    expect(() => jsonContainerInput(object, "content").parse(value)).toThrow(ActionInputValidationError);
    expect(() => jsonContainerInput(array, "items", "array").parse(value)).toThrow("Send items as a JSON array, not a string.");
  });

  it("includes the parser position and at most 80 characters near it without a raw input preview", () => {
    const value = `{"padding":"${"private text ".repeat(100)}","broken":1 "missing":2}`;
    let parserMessage = "";
    try { JSON.parse(value); } catch (error) { parserMessage = (error as SyntaxError).message; }
    try {
      jsonContainerInput(object, "content").parse(value);
      expect.unreachable("Expected invalid JSON");
    } catch (error) {
      expect(error).toBeInstanceOf(ActionInputValidationError);
      const failure = error as ActionInputValidationError;
      expect(failure.paths).toEqual(["content"]);
      expect(failure.message).toContain(parserMessage);
      expect(failure.message).toContain("Send content as a JSON object, not a string.");
      const excerpt = /near ("(?:[^"\\]|\\.)*")\)/.exec(failure.message)![1]!;
      expect(JSON.parse(excerpt).length).toBeLessThanOrEqual(80);
      expect(JSON.parse(excerpt)).toContain('"broken":1 "missing":2');
      expect(failure.message).not.toContain(value);
      expect(failure.message).not.toContain("Received:");
    }
  });

  it("reports EOF positions and preserves literal strings only when explicitly allowed", () => {
    expect(() => jsonContainerInput(object, "content").parse('{"count":')).toThrow("at position 9");
    const reference = z.union([z.string().regex(/^ver_\w+$/), object]);
    expect(jsonContainerInput(reference, "recipe", "object", true).parse("ver_saved")).toBe("ver_saved");
    expect(() => jsonContainerInput(reference, "recipe", "object", true).parse("{bad")).toThrow("recipe was sent as a string, but it is not valid JSON");
  });

  it("keeps parser reasons without the parser's own input copy when no position is reported", () => {
    expect(() => jsonContainerInput(array, "items", "array").parse("[bad")).toThrow("Unexpected token 'b'; position not reported by JSON.parse");
    expect(() => jsonContainerInput(array, "items", "array").parse("[bad")).not.toThrow('"[bad" is not valid JSON');
  });
});
