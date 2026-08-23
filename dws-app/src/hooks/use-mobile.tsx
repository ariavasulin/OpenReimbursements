"use client"

import { useSyncExternalStore } from "react"

// Phone-class devices are always "mobile" regardless of viewport (a tablet in
// landscape still has a software keyboard); everything else goes by width.
const UA_IS_MOBILE =
  typeof navigator !== "undefined" &&
  /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

const QUERY = "(max-width: 767px)"

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

function getSnapshot() {
  return UA_IS_MOBILE || window.matchMedia(QUERY).matches
}

function getServerSnapshot() {
  return false
}

export function useMobile() {
  // useSyncExternalStore reads the snapshot synchronously on the first client
  // render, so a phone never paints the desktop variant before flipping.
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
