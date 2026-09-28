import { redirect } from "next/navigation";
import { DEFAULT_ROUTE } from "@/lib/navigation";

/**
 * `/` is not a page — it redirects to the overview so there is exactly one
 * canonical landing route and no duplicated shell.
 */
export default function RootPage() {
  redirect(DEFAULT_ROUTE);
}
