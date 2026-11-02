import { useT } from "@agent-native/core/client/i18n";
import type { Address, Order, Request } from "@muscle-memory/shop-domain";
import {
  IconChevronDown,
  IconCreditCardRefund,
  IconMapPin,
  IconPackage,
  IconTicket,
} from "@tabler/icons-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { moneyText } from "@/lib/shop-workspace";

import { ActionForm, formText, type SavedResult } from "./ActionForm";

const operations = {
  refund: {
    action: "issue-refund",
    label: "shop.refund",
    description: "shop.refundDescription",
    success: "shop.refundSaved",
    Icon: IconCreditCardRefund,
  },
  replacement: {
    action: "create-replacement-order",
    label: "shop.replacement",
    description: "shop.replacementDescription",
    success: "shop.replacementSaved",
    Icon: IconPackage,
  },
  address: {
    action: "update-shipping-address",
    label: "shop.address",
    description: "shop.addressDescription",
    success: "shop.addressSaved",
    Icon: IconMapPin,
  },
  label: {
    action: "generate-return-label",
    label: "shop.returnLabel",
    description: "shop.returnDescription",
    success: "shop.labelSaved",
    Icon: IconTicket,
  },
} as const;
type Operation = keyof typeof operations;
const addressKeys = [
  "name",
  "line1",
  "line2",
  "city",
  "region",
  "postalCode",
  "countryCode",
] as const;

function AddressFields({ order, request }: { order: Order; request: Request }) {
  const t = useT();
  const [address, setAddress] = useState<Address>(order.shippingAddress);
  const requested =
    request.content.source === "structured" &&
    request.content.fields.type === "address_change"
      ? request.content.fields.address
      : null;
  return (
    <>
      {requested && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => setAddress(requested)}
        >
          {t("shop.useRequestedAddress")}
        </Button>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {addressKeys.map((key) => (
          <div
            key={key}
            className={
              key === "line1" || key === "line2" || key === "name"
                ? "sm:col-span-2"
                : ""
            }
          >
            <Label htmlFor={`address-${key}`}>{t(`shop.${key}`)}</Label>
            <Input
              id={`address-${key}`}
              name={key}
              className="mt-1.5"
              required={key !== "line2"}
              maxLength={key === "countryCode" ? 2 : undefined}
              minLength={key === "countryCode" ? 2 : undefined}
              autoComplete={key === "countryCode" ? "country" : "off"}
              value={address[key] ?? ""}
              onChange={(event) =>
                setAddress((previous) => ({
                  ...previous,
                  [key]: event.target.value,
                }))
              }
            />
          </div>
        ))}
      </div>
    </>
  );
}

function OperationForm({
  operation,
  order,
  request,
  onSaved,
  onPending,
  onCancel,
}: {
  operation: Operation;
  order: Order;
  request: Request;
  onSaved: (result: SavedResult) => void;
  onPending: (pending: boolean) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const config = operations[operation];
  return (
    <ActionForm
      action={config.action}
      label={config.label}
      successKey={config.success}
      onSaved={onSaved}
      onPending={onPending}
      onCancel={onCancel}
      buildInput={(data) => {
        switch (operation) {
          case "refund": {
            const amount = formText(data, "amount");
            return {
              orderId: order.id,
              reason: formText(data, "reason"),
              ...(amount
                ? {
                    amount: {
                      amountMinor: Math.round(Number(amount) * 100),
                      currency: order.paid.currency,
                    },
                  }
                : {}),
            };
          }
          case "replacement":
            return {
              orderId: order.id,
              items: order.items
                .map((item) => ({
                  productId: item.productId,
                  quantity: Number(formText(data, item.productId)),
                }))
                .filter((item) => item.quantity > 0),
            };
          case "address":
            return {
              orderId: order.id,
              address: Object.fromEntries(
                addressKeys.map((key) => [key, formText(data, key)]),
              ),
            };
          case "label":
            return { orderId: order.id };
        }
      }}
    >
      {operation === "refund" && (
        <>
          <div>
            <Label htmlFor="refund-amount">
              {t("shop.refundAmount", { currency: order.paid.currency })}
            </Label>
            <Input
              className="mt-1.5"
              id="refund-amount"
              name="amount"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0.01"
              aria-describedby="refund-hint"
            />
            <p
              id="refund-hint"
              className="mt-1.5 text-xs text-muted-foreground"
            >
              {t("shop.refundAmountHint")}
            </p>
          </div>
          <div>
            <Label htmlFor="refund-reason">{t("shop.reason")}</Label>
            <Textarea
              className="mt-1.5"
              id="refund-reason"
              name="reason"
              required
            />
          </div>
        </>
      )}
      {operation === "replacement" && (
        <div className="grid gap-3">
          {order.items.map((item) => (
            <div
              key={item.productId}
              className="flex items-center justify-between gap-4"
            >
              <label
                htmlFor={`replace-${item.productId}`}
                className="min-w-0 text-sm"
              >
                {item.name}
                <span className="kiln-data mt-1 block text-xs text-muted-foreground">
                  {moneyText(item.unitPrice)}
                </span>
              </label>
              <Input
                id={`replace-${item.productId}`}
                className="w-20 shrink-0"
                name={item.productId}
                type="number"
                min="0"
                max={item.quantity}
                step="1"
                defaultValue={item.quantity}
                required
                aria-label={t("shop.replacementQuantity", { name: item.name })}
              />
            </div>
          ))}
        </div>
      )}
      {operation === "address" && (
        <AddressFields order={order} request={request} />
      )}
      {operation === "label" && order.returnLabel && (
        <p className="shop-inline-note">
          {t("shop.labelId", { id: order.returnLabel.id })}
        </p>
      )}
    </ActionForm>
  );
}

export function OrderOperations({
  order,
  request,
  onSaved,
}: {
  order: Order;
  request: Request;
  onSaved: (result: SavedResult) => void;
}) {
  const t = useT();
  const [operation, setOperation] = useState<Operation | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <>
      {/* Dialog alone owns the modal pointer lock; overlapping modal menu and
          dialog lifetimes can leave body pointer-events:none after closing. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            {t("shop.orderActions")}
            <IconChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {(Object.keys(operations) as Operation[]).map((key) => {
            const { label, Icon } = operations[key];
            return (
              <DropdownMenuItem key={key} onSelect={() => setOperation(key)}>
                <Icon className="me-2 size-4" />
                {t(label)}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={operation !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setOperation(null);
        }}
      >
        {operation && (
          <DialogContent
            closeLabel={t("shop.close")}
            onEscapeKeyDown={(event) => {
              if (pending) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (pending) event.preventDefault();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t(operations[operation].label)}</DialogTitle>
              <DialogDescription>
                {t(operations[operation].description)}
              </DialogDescription>
            </DialogHeader>
            <OperationForm
              key={operation}
              operation={operation}
              order={order}
              request={request}
              onPending={setPending}
              onCancel={() => setOperation(null)}
              onSaved={(result) => {
                onSaved(result);
                setOperation(null);
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
