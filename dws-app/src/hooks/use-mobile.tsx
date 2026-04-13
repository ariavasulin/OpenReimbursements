"use client"

import { useState, useEffect } from "react"

export function useMobile() {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const checkIfMobile = () => {
      const widthIsMobile = window.innerWidth < 768;
      const agentIsMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      setIsMobile(widthIsMobile || agentIsMobile);
    }

    checkIfMobile()

    window.addEventListener("resize", checkIfMobile)
    return () => window.removeEventListener("resize", checkIfMobile)
  }, [])

  return isMobile
}