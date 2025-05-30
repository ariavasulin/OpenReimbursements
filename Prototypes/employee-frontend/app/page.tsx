"use client"

import { useState } from "react"
import Image from "next/image"
import ReceiptUploader from "@/components/receipt-uploader"
import ReceiptTable from "@/components/receipt-table"
import { receipts as initialReceipts } from "@/lib/data"
import type { Receipt } from "@/lib/types"

export default function Home() {
  const [receipts, setReceipts] = useState<Receipt[]>(initialReceipts)

  const handleReceiptAdded = (newReceipt: Receipt) => {
    setReceipts((prevReceipts) => [newReceipt, ...prevReceipts])
  }

  return (
    <main className="container max-w-md mx-auto p-4 space-y-6">
      <div className="flex flex-col items-center justify-center pt-6 pb-2">
        <Image src="/images/DWLogo_white+transparent.png" alt="DW Logo" width={200} height={200} priority />
      </div>
      <ReceiptUploader onReceiptAdded={handleReceiptAdded} />
      <ReceiptTable receipts={receipts} />
    </main>
  )
}
