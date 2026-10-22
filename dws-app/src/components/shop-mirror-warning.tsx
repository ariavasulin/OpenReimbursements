"use client"

import { useQuery } from "@tanstack/react-query"
import { AlertTriangle } from "lucide-react"
import { fetchJson } from "@/lib/photos/api"
import type { MirrorWarning } from "@/lib/shop/mirror-warning"

/**
 * A warning bar on the admin receipts page when the shop mirror has had no good copy
 * of some table for over an hour. Nothing shows while it is healthy, or where the
 * mirror has never run.
 */
export function ShopMirrorWarning() {
  const { data: warning } = useQuery({
    queryKey: ["shop-mirror-warning"],
    queryFn: () => fetchJson<{ warning: MirrorWarning | null }>(
      "/api/shop/mirror-status", "Could not load the shop sync status", { cache: "no-store" },
    ).then(r => r.warning),
    refetchInterval: 5 * 60_000,
  })
  if (!warning) return null
  const since = warning.lastOkAt ? new Date(warning.lastOkAt).toLocaleString() : "never"
  return (
    <div role="alert" className="flex items-start gap-3 rounded-md border border-yellow-600 bg-yellow-950/60 p-3 text-sm text-yellow-100">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        The office data sync has not succeeded for over an hour ({warning.tables.join(", ")}; last good sync: {since}).
        New office jobs will not reach the photos app until it does. See “When something is wrong” (section 8) in shop-bridge/README.md.
      </p>
    </div>
  )
}
