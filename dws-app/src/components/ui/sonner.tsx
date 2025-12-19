"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner, ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "bg-[#2e2e2e] border-[#4e4e4e] text-white",
          title: "text-white",
          description: "text-gray-300",
          success: "bg-[#2e2e2e] border-[#4e4e4e]",
          error: "bg-[#2e2e2e] border-[#4e4e4e]",
          warning: "bg-[#2e2e2e] border-[#4e4e4e]",
          info: "bg-[#2e2e2e] border-[#4e4e4e]",
        },
        actionButtonStyle: {
          backgroundColor: "#2680FC",
          color: "white",
          fontSize: "12px",
          fontWeight: "500",
          padding: "6px 12px",
          borderRadius: "6px",
        },
        cancelButtonStyle: {
          backgroundColor: "#3e3e3e",
          color: "white",
          fontSize: "12px",
          fontWeight: "500",
          padding: "6px 12px",
          borderRadius: "6px",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
