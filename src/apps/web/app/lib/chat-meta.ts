import { APP_TITLE } from "./app-config";

/** Chat metadata stays independent of the legacy home redirect. */
export function chatMeta() {
  return [
    { title: `${APP_TITLE} — Chat` },
    {
      name: "description",
      content:
        "Work with the Kiln & Co. shop assistant on customer requests, orders, and replies.",
    },
  ];
}
