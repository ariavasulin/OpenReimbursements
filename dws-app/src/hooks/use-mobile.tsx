"use client"

import { useState, useEffect } from "react"

export function useMobile() {
  // Lazy initializer: compute synchronously on first client render so a phone
  // never paints the desktop variant (e.g. Dialog) before flipping to mobile.
  const [isMobile, setIsMobile] = useState(() =>
    typeof window === "undefined" ? false : checkIfMobile()
  )

  useEffect(() => {
    const update = () => setIsMobile(checkIfMobile())
    update()

    window.addEventListener("resize", update)
    return () => window.removeEventListener("resize", update)
  }, [])

  return isMobile
}

function checkIfMobile() {
  return (
    window.innerWidth < 768 ||
    /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)
  )
}
