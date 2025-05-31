"use client"

import { useState, useEffect } from "react"

export function useMobile() {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    // Initial check
    const checkIfMobile = () => {
      const widthIsMobile = window.innerWidth < 768;
      const agentIsMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      console.log(`useMobile: window.innerWidth = ${window.innerWidth}, widthIsMobile = ${widthIsMobile}`);
      console.log(`useMobile: navigator.userAgent = ${navigator.userAgent}, agentIsMobile = ${agentIsMobile}`);
      setIsMobile(widthIsMobile || agentIsMobile);
    }

    checkIfMobile() // Call on mount

    // Listen for resize events
    window.addEventListener("resize", checkIfMobile)

    // Cleanup listener on component unmount
    return () => window.removeEventListener("resize", checkIfMobile)
  }, []) // Empty dependency array ensures this runs only on mount and unmount

  return isMobile
}