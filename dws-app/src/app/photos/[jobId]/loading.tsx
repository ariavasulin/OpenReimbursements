import { PageSkeleton } from "@/components/photos/shell-skeleton";

// Shown at once when a project is tapped, while its page loads (the card's
// prefetch makes this instant). The same grey page the shell draws during the
// session check, so the two never flash one after the other.
export default function Loading() {
  return <PageSkeleton kind="collection" />;
}
