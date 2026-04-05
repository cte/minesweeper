import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";

import type { DashboardPayload } from "./dashboard-types.ts";

export const dashboardClient = createTRPCProxyClient<any>({
  links: [
    httpBatchLink({
      url: new URL("/trpc", window.location.origin).toString(),
    }),
  ],
});

export async function fetchDashboardState(signal?: AbortSignal): Promise<DashboardPayload> {
  return (await (dashboardClient as any).state.query(undefined, {
    signal,
  })) as DashboardPayload;
}
