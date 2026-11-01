import { useT } from "@agent-native/core/client/i18n";
import {
  REQUEST_TYPES,
  structuredRequestFieldsSchema,
  type Order,
  type Request,
  type RequestType,
  type StructuredRequestFields,
} from "@muscle-memory/shop-domain";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { PendingMark } from "./WorkspaceParts";

export function TeachRequestFields({
  request,
  order,
  pending,
  onConfirm,
  onCancel,
}: {
  request: Request;
  order?: Order | undefined;
  pending: boolean;
  onConfirm: (fields: StructuredRequestFields) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [type, setType] = useState<RequestType>(
    request.content.source === "free_text"
      ? (request.content.type ?? "damaged_item")
      : request.content.fields.type,
  );
  const [error, setError] = useState(false);
  const field = (
    name: string,
    label: string,
    options: { required?: boolean; multiline?: boolean } = {},
  ) => (
    <label className="grid gap-1.5 text-sm" key={name}>
      {t(label)}
      {options.multiline ? (
        <Textarea name={name} required={options.required ?? true} />
      ) : (
        <Input name={name} required={options.required ?? true} />
      )}
    </label>
  );
  return (
    <form
      className="grid gap-4"
      aria-label={t("shop.teachFieldsTitle")}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const text = (name: string) => String(data.get(name) ?? "");
        let candidate: unknown;
        switch (type) {
          case "damaged_item":
            candidate = {
              type,
              orderId: text("orderId"),
              productId: text("productId"),
              quantity: Number(text("quantity")),
              description: text("description"),
            };
            break;
          case "where_is_my_order":
            candidate = { type, orderId: text("orderId") };
            break;
          case "return":
            candidate = {
              type,
              orderId: text("orderId"),
              reason: text("reason"),
            };
            break;
          case "wholesale_inquiry":
            candidate = {
              type,
              company: text("company"),
              message: text("message"),
            };
            break;
          case "address_change":
            candidate = {
              type,
              orderId: text("orderId"),
              address: Object.fromEntries(
                [
                  "name",
                  "line1",
                  "line2",
                  "city",
                  "region",
                  "postalCode",
                  "countryCode",
                ].flatMap((key) =>
                  key === "line2" && !text(key) ? [] : [[key, text(key)]],
                ),
              ),
            };
            break;
        }
        const parsed = structuredRequestFieldsSchema.safeParse(candidate);
        setError(!parsed.success);
        if (parsed.success) onConfirm(parsed.data);
      }}
    >
      <fieldset className="grid gap-4" disabled={pending}>
        <label className="grid gap-1.5 text-sm">
          {t("shop.type")}
          <select
            className="rounded-md border border-input bg-background px-3 py-2"
            value={type}
            onChange={(e) => setType(e.target.value as RequestType)}
          >
            {REQUEST_TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`shop.types.${value}`)}
              </option>
            ))}
          </select>
        </label>
        {type !== "wholesale_inquiry" && (
          <label className="grid gap-1.5 text-sm">
            {t("shop.order")}
            <Input
              name="orderId"
              defaultValue={request.orderId ?? ""}
              readOnly={Boolean(request.orderId)}
              required
            />
          </label>
        )}
        {type === "damaged_item" && (
          <>
            <label className="grid gap-1.5 text-sm">
              {t("shop.product")}
              {order ? (
                <select
                  name="productId"
                  className="rounded-md border border-input bg-background px-3 py-2"
                >
                  {order.items.map((item) => (
                    <option key={item.productId} value={item.productId}>
                      {item.name}
                    </option>
                  ))}
                </select>
              ) : (
                <Input name="productId" required />
              )}
            </label>
            <label className="grid gap-1.5 text-sm">
              {t("shop.teachQuantity")}
              <Input
                name="quantity"
                type="number"
                min="1"
                step="1"
                defaultValue="1"
                required
              />
            </label>
            {field("description", "shop.description", { multiline: true })}
          </>
        )}
        {type === "return" &&
          field("reason", "shop.reason", { multiline: true })}
        {type === "wholesale_inquiry" && (
          <>
            {field("company", "shop.company")}
            {field("message", "shop.message", { multiline: true })}
          </>
        )}
        {type === "address_change" && (
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              "name",
              "line1",
              "line2",
              "city",
              "region",
              "postalCode",
              "countryCode",
            ].map((key) =>
              field(key, `shop.${key}`, { required: key !== "line2" }),
            )}
          </div>
        )}
      </fieldset>
      {error && (
        <p className="shop-form-error" role="alert">
          {t("shop.teachFieldsInvalid")}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={onCancel}
        >
          {t("shop.cancel")}
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <PendingMark />}
          {t("shop.teach")}
        </Button>
      </div>
    </form>
  );
}
