import { redirect } from "react-router";

import { INBOX_PATH } from "@/lib/shop-workspace";

// This is an alias for old bookmarks, never a second landing surface.
export function loader() {
  return redirect(INBOX_PATH);
}
export function clientLoader() {
  return redirect(INBOX_PATH);
}
