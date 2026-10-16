// The project page is all client-side: the server has nothing per-project to
// render. Without this the route is dynamic, so every tap into a project waits
// for a fresh server render, and every visible card's prefetch is a function
// call that returns almost nothing. An empty generateStaticParams with
// dynamicParams on renders each id once, on its first visit, and serves it
// from the cache after that (until the next deploy). A page marked
// "use client" cannot export these itself, hence this layout.
export const dynamicParams = true;

export function generateStaticParams() {
  return [];
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
