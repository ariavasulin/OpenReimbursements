import { createSupabaseAdminClient } from '@/lib/supabaseServerClient';
import { getAgentMailClient } from '@/lib/agentmail';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { b } from '@baml/index';
import { Image } from '@boundaryml/baml';

interface AttachmentInfo {
  attachment_id: string;
  filename: string;
  content_type: string;
  size: number;
}

interface ProcessEmailParams {
  senderEmail: string;
  subject: string;
  messageId: string;
  inboxId: string;
  attachments: AttachmentInfo[];
}

interface ReceiptResult {
  success: boolean;
  receiptId?: string;
  date?: string;
  amount?: number;
  error?: string;
}

export interface ProcessingResult {
  error?: string;
  receipts: ReceiptResult[];
}

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'application/pdf', 'image/jpg'];
const MAX_SIZE = 10 * 1024 * 1024; // 10MB

export async function processEmailReceipt(params: ProcessEmailParams): Promise<ProcessingResult> {
  const { senderEmail, subject, messageId, inboxId, attachments } = params;
  const supabase = createSupabaseAdminClient();

  // 1. Look up user by email
  const { data: userProfile, error: userError } = await supabase
    .from('user_profiles')
    .select('user_id, full_name, email')
    .eq('email', senderEmail.toLowerCase())
    .single();

  if (userError || !userProfile) {
    console.log('Email processor: Unknown sender:', senderEmail);
    return {
      error: `We couldn't find an account associated with ${senderEmail}. Please contact your administrator to add your email address to your profile, or use the mobile app.`,
      receipts: [],
    };
  }

  const userId = userProfile.user_id;
  console.log('Email processor: Matched user:', userId, userProfile.full_name);

  // 2. Filter valid attachments
  const validAttachments = attachments.filter(att => {
    const isValidType = ALLOWED_TYPES.includes(att.content_type.toLowerCase());
    const isValidSize = att.size <= MAX_SIZE;
    const isNotInline = !att.filename.startsWith('inline'); // Skip inline images
    return isValidType && isValidSize && isNotInline;
  });

  if (validAttachments.length === 0) {
    return {
      error: 'No valid receipt images found. Please attach JPEG, PNG, or PDF files (max 10MB each).',
      receipts: [],
    };
  }

  console.log('Email processor: Processing', validAttachments.length, 'attachments');

  // 3. Get default category (Other)
  const defaultCategoryId = process.env.DEFAULT_CATEGORY_ID;
  if (!defaultCategoryId) {
    console.error('Email processor: DEFAULT_CATEGORY_ID not configured');
  }

  // 4. Process each attachment
  const results: ReceiptResult[] = [];
  const client = getAgentMailClient();

  for (const attachment of validAttachments) {
    try {
      const result = await processAttachment({
        attachment,
        userId,
        messageId,
        inboxId,
        defaultCategoryId,
        subject,
        supabase,
        client,
      });
      results.push(result);
    } catch (error) {
      console.error('Email processor: Error processing attachment:', attachment.filename, error);
      results.push({
        success: false,
        error: `Failed to process ${attachment.filename}`,
      });
    }
  }

  return { receipts: results };
}

async function processAttachment(params: {
  attachment: AttachmentInfo;
  userId: string;
  messageId: string;
  inboxId: string;
  defaultCategoryId?: string;
  subject: string;
  supabase: ReturnType<typeof createSupabaseAdminClient>;
  client: ReturnType<typeof getAgentMailClient>;
}): Promise<ReceiptResult> {
  const { attachment, userId, messageId, inboxId, defaultCategoryId, subject, supabase, client } = params;

  console.log('Email processor: Processing attachment:', attachment.filename);

  // 1. Download attachment from AgentMail
  const attachmentResponse = await client.inboxes.messages.getAttachment(
    inboxId,
    messageId,
    attachment.attachment_id
  );

  // Convert to buffer using arrayBuffer()
  const arrayBuffer = await attachmentResponse.arrayBuffer();
  let fileBuffer = Buffer.from(arrayBuffer);

  // 2. Compress image if not PDF
  let processedBuffer = fileBuffer;
  let contentType = attachment.content_type;

  if (attachment.content_type.startsWith('image/') && attachment.content_type !== 'application/pdf') {
    try {
      processedBuffer = await sharp(fileBuffer)
        .resize({
          width: 1200,
          height: 1200,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality: 80, progressive: true })
        .toBuffer();
      contentType = 'image/jpeg';
      console.log('Email processor: Compressed image from', fileBuffer.length, 'to', processedBuffer.length);
    } catch (err) {
      console.warn('Email processor: Sharp compression failed, using original');
      processedBuffer = fileBuffer;
    }
  }

  // 3. Upload to Supabase Storage
  const fileExtension = contentType === 'application/pdf' ? 'pdf' : 'jpg';
  const randomString = uuidv4().slice(0, 8);
  const tempFilePath = `${userId}/temp_email_${randomString}_${Date.now()}.${fileExtension}`;

  const { error: uploadError } = await supabase.storage
    .from('receipt-images')
    .upload(tempFilePath, processedBuffer, {
      contentType,
      upsert: false,
    });

  if (uploadError) {
    console.error('Email processor: Upload failed:', uploadError);
    return { success: false, error: 'Failed to upload image' };
  }

  console.log('Email processor: Uploaded to', tempFilePath);

  // 4. Run OCR extraction
  const base64 = processedBuffer.toString('base64');
  const image = Image.fromBase64(contentType, base64);

  let extractedDate: string | null = null;
  let extractedAmount: number | null = null;
  let categoryId = defaultCategoryId || null;

  try {
    const extracted = await b.ExtractReceiptFromImage(image);
    console.log('Email processor: OCR result:', extracted);

    extractedDate = extracted.date || null;
    extractedAmount = extracted.amount ?? null;

    // Try to match extracted category
    if (extracted.category) {
      const { data: categoryMatch } = await supabase
        .from('categories')
        .select('id')
        .ilike('name', extracted.category)
        .single();

      if (categoryMatch) {
        categoryId = categoryMatch.id;
      }
    }
  } catch (ocrError) {
    console.error('Email processor: OCR failed:', ocrError);
    // Continue with null values - receipt will be flagged for review
  }

  // 5. Create receipt record
  const { data: newReceipt, error: insertError } = await supabase
    .from('receipts')
    .insert({
      user_id: userId,
      receipt_date: extractedDate,
      amount: extractedAmount,
      category_id: categoryId,
      description: `Email: ${subject}`.slice(0, 500), // Use email subject as description
      status: 'Pending',
      image_url: tempFilePath,
      submission_source: 'email',
    })
    .select('id')
    .single();

  if (insertError || !newReceipt) {
    console.error('Email processor: Insert failed:', insertError);
    // Clean up uploaded file
    await supabase.storage.from('receipt-images').remove([tempFilePath]);
    return { success: false, error: 'Failed to create receipt record' };
  }

  // 6. Move file to final location
  const finalPath = `${userId}/${newReceipt.id}.${fileExtension}`;
  const { error: moveError } = await supabase.storage
    .from('receipt-images')
    .move(tempFilePath, finalPath);

  if (moveError) {
    console.error('Email processor: Move failed:', moveError);
    // Receipt exists but image path is wrong - update with temp path
  } else {
    // Update receipt with final path
    await supabase
      .from('receipts')
      .update({ image_url: finalPath })
      .eq('id', newReceipt.id);
  }

  console.log('Email processor: Created receipt:', newReceipt.id);

  return {
    success: true,
    receiptId: newReceipt.id,
    date: extractedDate || undefined,
    amount: extractedAmount || undefined,
  };
}
