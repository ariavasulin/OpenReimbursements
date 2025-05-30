"use client"

import { useState, useEffect } from "react"

export function useMobile() {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    // Initial check
    const checkIfMobile = () => {
      // Check for touch points as another indicator, or specific user agent strings.
      // window.innerWidth < 768 is a common breakpoint for "mobile".
      setIsMobile(window.innerWidth < 768 || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent))
    }

    checkIfMobile() // Call on mount

    // Listen for resize events
    window.addEventListener("resize", checkIfMobile)

    // Cleanup listener on component unmount
    return () => window.removeEventListener("resize", checkIfMobile)
  }, []) // Empty dependency array ensures this runs only on mount and unmount

  return isMobile
}