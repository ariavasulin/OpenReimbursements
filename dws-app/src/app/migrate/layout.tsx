import { QueryProvider } from "@/components/providers/query-provider";

// The query cache is mounted per signed-in area, not in the root layout, so
// the public share page (/s/...) does not ship React Query and the Supabase
// client it never uses. Every area that renders a useQuery or useQueryClient
// needs this.
export default function Layout({ children }: { children: React.ReactNode }) {
  return <QueryProvider>{children}</QueryProvider>;
}
