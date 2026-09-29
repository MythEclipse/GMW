"use client";

import { useCallback } from "react";
import { ErrorState, LoadingState } from "@/components/shared/states";
import { useRouteSeed } from "@/hooks/use-route-seed";
import { browserApi } from "@/lib/api/browser";
import type { UserPage } from "@/lib/types";
import { UsersView } from "./view";

/**
 * Client route for /users — was a server component fetching via
 * `getUsers({ limit: 30 })`. Same fetch, same `data` projection into the view's
 * `initialUsers` prop.
 */
export function UsersPage() {
  const fetcher = useCallback(async () => {
    const users = (await browserApi.dashboard.users({
      limit: 30,
    })) as unknown as UserPage;
    return { users: users?.data ?? [] };
  }, []);

  const seed = useRouteSeed(fetcher);

  if (seed.error) {
    return <ErrorState error={seed.error} onRetry={seed.retry} />;
  }

  if (seed.isPending || !seed.data) {
    return <LoadingState label="Loading members" />;
  }

  return <UsersView initialUsers={seed.data.users} />;
}
