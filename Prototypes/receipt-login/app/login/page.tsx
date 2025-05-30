"use client"

import type React from "react"

import { useState } from "react"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ArrowRight } from "lucide-react"

export default function LoginPage() {
  const [phoneNumber, setPhoneNumber] = useState("")
  const [showOtpInput, setShowOtpInput] = useState(false)
  const [otp, setOtp] = useState("")

  const handleSendCode = (e: React.FormEvent) => {
    e.preventDefault()
    if (phoneNumber.length >= 10) {
      setShowOtpInput(true)
    }
  }

  const handleVerifyCode = (e: React.FormEvent) => {
    e.preventDefault()
    // Here you would implement the actual verification logic
    console.log("Verifying code:", otp)
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#222222] px-4 py-8">
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center justify-center">
          <div className="mb-8 flex items-center justify-center">
            <Image
              src="/images/logo.png"
              alt="Design Workshops Logo"
              width={300}
              height={300}
              className="h-auto w-40 object-contain"
            />
          </div>
          <p className="mt-2 text-center text-sm text-gray-400">Sign in to upload and track your receipts</p>
        </div>

        {!showOtpInput ? (
          <form onSubmit={handleSendCode} className="mt-8 space-y-6">
            <div className="space-y-2">
              <Label htmlFor="phone" className="text-white">
                Phone Number
              </Label>
              <Input
                id="phone"
                type="tel"
                placeholder="(555) 123-4567"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                required
                className="bg-[#333333] border-[#444444] text-white placeholder:text-gray-500"
              />
            </div>
            <Button type="submit" className="w-full bg-[#2680FC] hover:bg-[#1a6fd8] text-white">
              Send Code
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </form>
        ) : (
          <form onSubmit={handleVerifyCode} className="mt-8 space-y-6">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="otp" className="text-white">
                  One-Time Code
                </Label>
                <button
                  type="button"
                  onClick={() => setShowOtpInput(false)}
                  className="text-sm text-[#2680FC] hover:text-[#1a6fd8]"
                >
                  Change Number
                </button>
              </div>
              <Input
                id="otp"
                type="text"
                placeholder="Enter 6-digit code"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                required
                className="bg-[#333333] border-[#444444] text-white placeholder:text-gray-500"
                maxLength={6}
              />
              <p className="text-xs text-gray-400">We sent a code to {phoneNumber}</p>
            </div>
            <Button type="submit" className="w-full bg-[#2680FC] hover:bg-[#1a6fd8] text-white">
              Verify & Login
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}
