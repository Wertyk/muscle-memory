import { useParams } from "react-router";

import { RequestPage } from "@/components/shop/RequestPage";

export default function RequestRoute() {
  const { requestId = "" } = useParams();
  return <RequestPage key={requestId} requestId={requestId} />;
}
