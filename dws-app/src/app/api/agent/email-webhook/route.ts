import { NextResponse, type NextRequest } from 'next/server';
import { getAgentMailClient } from '@/lib/agentmail';
import { processEmailReceipt, type ProcessingResult } from '@/lib/email-receipt-processor';

// AgentMail webhook payload types
interface AgentMailAttachment {
  attachment_id: string;
  filename: string;
  content_type: string;
  size: number;
  inline: boolean;
}

interface AgentMailMessage {
  from_: string[];
  to: string[];
  subject: string;
  message_id: string;
  inbox_id: string;
  text: string;
  html: string;
  attachments: AgentMailAttachment[];
  labels: string[];
  timestamp: string;
}

interface AgentMailWebhookPayload {
  event_type: string;
  event_id: string;
  message: AgentMailMessage;
}

export async function POST(request: NextRequest) {
  console.log('Email webhook: Received request');

  try {
    const payload: AgentMailWebhookPayload = await request.json();
    console.log('Email webhook: Event type:', payload.event_type);

    // Ignore sent messages to avoid processing our own replies
    if (payload.message.labels.includes('sent')) {
      console.log('Email webhook: Ignoring sent message');
      return NextResponse.json({ success: true, skipped: true });
    }

    // Only process received messages
    if (payload.event_type !== 'message.received') {
      console.log('Email webhook: Ignoring non-receive event');
      return NextResponse.json({ success: true, skipped: true });
    }

    const message = payload.message;
    const senderEmail = message.from_[0]; // First sender address

    if (!senderEmail) {
      console.error('Email webhook: No sender email found');
      return NextResponse.json({ error: 'No sender email' }, { status: 400 });
    }

    console.log('Email webhook: Processing email from:', senderEmail);
    console.log('Email webhook: Subject:', message.subject);
    console.log('Email webhook: Attachments:', message.attachments.length);

    // Process the email and get results
    const result = await processEmailReceipt({
      senderEmail,
      subject: message.subject,
      messageId: message.message_id,
      inboxId: message.inbox_id,
      attachments: message.attachments,
    });

    // Send reply email with results
    await sendReplyEmail(message.inbox_id, message.message_id, senderEmail, result);

    return NextResponse.json({ success: true, result });

  } catch (error) {
    console.error('Email webhook: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

async function sendReplyEmail(
  inboxId: string,
  messageId: string,
  senderEmail: string,
  result: ProcessingResult
) {
  const client = getAgentMailClient();

  let subject: string;
  let body: string;

  if (result.error) {
    subject = 'Receipt Submission Failed';
    body = `Hello,\n\n${result.error}\n\nPlease try again or use the mobile app.\n\nDWS Receipts`;
  } else if (result.receipts.length === 0) {
    subject = 'No Receipts Processed';
    body = `Hello,\n\nNo valid receipt images were found in your email. Please attach JPEG, PNG, or PDF files.\n\nDWS Receipts`;
  } else {
    subject = `${result.receipts.length} Receipt(s) Submitted`;
    const receiptList = result.receipts.map((r, i) => {
      const status = r.success ? '✓' : '⚠';
      const details = r.success
        ? `$${r.amount?.toFixed(2) || '?.??'} on ${r.date || 'unknown date'}`
        : r.error;
      return `${status} Receipt ${i + 1}: ${details}`;
    }).join('\n');

    body = `Hello,\n\nProcessed ${result.receipts.length} receipt(s):\n\n${receiptList}\n\nView your receipts in the DWS Receipts app.\n\nDWS Receipts`;
  }

  try {
    await client.inboxes.messages.reply(inboxId, messageId, {
      text: body,
    });
    console.log('Email webhook: Reply sent to', senderEmail);
  } catch (error) {
    console.error('Email webhook: Failed to send reply:', error);
  }
}
