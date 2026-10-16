// The sign-in page is shared by both products. The page sets the tab title to
// "DWS Photos" in the browser when the address (or the page the person is
// headed to) is a photos one. This layout used to decide it on the server
// from the Host header, which made /login a server render on every visit
// (~60-80 ms more to the first byte from the Bay Area). Now /login is static
// and served from the CDN; the trade-off is that on the photos address the
// generic title can show for a moment before the page's code runs.
export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
