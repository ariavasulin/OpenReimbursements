import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import type { Receipt } from '@/lib/types'; // Assuming Receipt type is defined

export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  try {
    const body = await request.json();
    console.log("POST /api/receipts: Request body:", body);
    // Destructure receipt_date instead of date from the body
    const { receipt_date, amount, category_id, notes, tempFilePath } = body;

    // Update validation to check for receipt_date
    if (!receipt_date || amount === undefined || !category_id || !tempFilePath) {
      console.error("POST /api/receipts: Missing required fields. Received:", body);
      // Update error message to reflect expectation of receipt_date
      return NextResponse.json({ error: 'Missing required fields: receipt_date, amount, category_id, tempFilePath' }, { status: 400 });
    }

    console.log("POST /api/receipts: Attempting to insert initial receipt record for user:", userId);
    // 1. Insert initial receipt record to get an ID
    const { data: newReceipt, error: insertError } = await supabase
      .from('receipts')
      .insert({
        user_id: userId,
        receipt_date: receipt_date, // Use the destructured receipt_date
        amount: amount,
        category_id: category_id,
        description: notes,
        status: 'Pending', // Capitalized to match DB constraint
        image_url: tempFilePath, // Temporary path initially
      })
      .select()
      .single();

    if (insertError || !newReceipt) {
      console.error('POST /api/receipts: Error inserting receipt:', insertError);
      if (tempFilePath) {
        console.log("POST /api/receipts: Attempting to delete orphaned file due to insert error:", tempFilePath);
        const { error: deleteError } = await supabase.storage.from('receipt-images').remove([tempFilePath]);
        if (deleteError) console.error('POST /api/receipts: Error deleting orphaned file:', deleteError);
      }
      return NextResponse.json({ error: insertError?.message || 'Failed to create receipt record during INSERT' }, { status: 500 });
    }

    const newReceiptId = newReceipt.id;
    console.log("POST /api/receipts: Initial insert successful. New receipt ID:", newReceiptId);
    const originalFileExtension = tempFilePath.split('.').pop();
    const finalImagePath = `${userId}/${newReceiptId}.${originalFileExtension}`;
    const bucketName = 'receipt-images';

    // 2. Verify temp file exists before attempting to move using list()
    console.log(`POST /api/receipts: Verifying existence of temp file at: ${tempFilePath}`);
    const pathParts = tempFilePath.split('/');
    const fileNameToSearch = pathParts.pop(); // Get the actual filename
    const folderPathToList = pathParts.join('/');   // Get the folder path

    console.log(`POST /api/receipts: Listing folder '${folderPathToList}' for file matching '${fileNameToSearch}'`);
    const { data: fileList, error: listError } = await supabase.storage
      .from(bucketName)
      .list(folderPathToList, {
        search: fileNameToSearch,
        limit: 1 // We only need to find one
      });

    if (listError) {
      console.error(`POST /api/receipts: Error listing temp file. Path: ${tempFilePath}`, listError);
      return NextResponse.json({ error: `Error verifying temporary file before move: ${listError.message}` }, { status: 500 });
    }

    if (!fileList || fileList.length === 0) {
      console.error(`POST /api/receipts: Temp file not found in list. Path: ${tempFilePath}. List result:`, fileList);
      // Attempt to delete the DB record if the temp file is already gone, to prevent orphaned DB entries.
      console.log("POST /api/receipts: Attempting to delete DB record as temp file not found, ID:", newReceiptId);
      const { error: deleteDbError } = await supabase.from('receipts').delete().eq('id', newReceiptId);
      if (deleteDbError) console.error('POST /api/receipts: Error deleting DB record after temp file not found:', deleteDbError);
      return NextResponse.json({ error: `Temporary file not found before move. Path: ${tempFilePath}` }, { status: 404 });
    }
    
    // Check if the found file exactly matches the name (list with search can be broad)
    const foundFile = fileList.find(f => f.name === fileNameToSearch);
    if (!foundFile) {
        console.error(`POST /api/receipts: Temp file name '${fileNameToSearch}' not found in list result for folder '${folderPathToList}'. List:`, fileList);
        // Attempt to delete the DB record
        console.log("POST /api/receipts: Attempting to delete DB record as temp file name mismatch, ID:", newReceiptId);
        const { error: deleteDbError } = await supabase.from('receipts').delete().eq('id', newReceiptId);
        if (deleteDbError) console.error('POST /api/receipts: Error deleting DB record after temp file name mismatch:', deleteDbError);
        return NextResponse.json({ error: `Temporary file '${fileNameToSearch}' not found in expected folder '${folderPathToList}'.` }, { status: 404 });
    }

    console.log(`POST /api/receipts: Temp file ${tempFilePath} successfully verified via list().`);

    // Proceed to Move/Rename the file in storage
    console.log(`POST /api/receipts: Attempting to move file from ${tempFilePath} to ${finalImagePath}`);
    const { data: moveData, error: moveError } = await supabase.storage
      .from(bucketName)
      .move(tempFilePath, finalImagePath);

    if (moveError) {
      console.error('POST /api/receipts: Error moving file in storage:', moveError);
      // Attempt to delete the database record if move fails, as the image is not in its final place
      console.log("POST /api/receipts: Attempting to delete DB record due to move error, ID:", newReceiptId);
      const { error: deleteDbError } = await supabase.from('receipts').delete().eq('id', newReceiptId);
      if (deleteDbError) console.error('POST /api/receipts: Error deleting DB record after move fail:', deleteDbError);
      // The temp file still exists in storage at tempFilePath
      return NextResponse.json({ error: `Failed to finalize image storage during MOVE: ${moveError.message}` }, { status: 500 });
    }
    console.log("POST /api/receipts: File move successful.");

    // 3. Update the receipt record with the final image_url
    console.log("POST /api/receipts: Attempting to update receipt record with final image_url:", finalImagePath);
    const { data: updatedReceipt, error: updateError } = await supabase
      .from('receipts')
      .update({ image_url: finalImagePath })
      .eq('id', newReceiptId)
      .select()
      .single();

    if (updateError || !updatedReceipt) {
      console.error('POST /api/receipts: Error updating receipt with final image path:', updateError);
      // Critical: File is moved, but DB update failed.
      // Options: try to move file back, or flag for manual reconciliation.
      // For now, just log and error out.
      return NextResponse.json({ error: updateError?.message || 'Failed to update receipt with final image path during UPDATE' }, { status: 500 });
    }
    console.log("POST /api/receipts: Receipt update successful. Final receipt:", updatedReceipt);

    return NextResponse.json({ success: true, receipt: updatedReceipt as Receipt }, { status: 201 });

  } catch (error) {
    console.error('POST /api/receipts: Unhandled error in try-catch block:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: `Error processing request: ${errorMessage}` }, { status: 500 });
  }
}

export async function GET(request: Request) {
  console.log("GET /api/receipts: Handler called");
  const supabase = await createSupabaseServerClient();

  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) {
    console.error("GET /api/receipts: Session error:", sessionError);
    return NextResponse.json({ error: 'Failed to get session' }, { status: 500 });
  }

  if (!session) {
    console.log("GET /api/receipts: No session, unauthorized");
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;
  console.log("GET /api/receipts: Authenticated user ID:", userId);

  try {
    console.log("GET /api/receipts: Fetching receipts from DB for user:", userId);
    const { data: receipts, error: dbError } = await supabase
      .from('receipts')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (dbError) {
      console.error('GET /api/receipts: DB error fetching receipts:', dbError);
      return NextResponse.json({ error: dbError.message || 'Failed to fetch receipts from database' }, { status: 500 });
    }

    if (!receipts) {
      console.log("GET /api/receipts: No receipts found for user, returning empty array.");
      return NextResponse.json({ success: true, receipts: [] }, { status: 200 });
    }
    console.log(`GET /api/receipts: Found ${receipts.length} receipts for user.`);

    // Augment receipts with public image URLs
    const receiptsWithPublicUrls = receipts.map(receipt => {
      let publicImageUrl = receipt.image_url; // Default to existing if no processing needed
      if (receipt.image_url) { // Ensure there's an image_url to process
        console.log(`GET /api/receipts: Generating public URL for image path: ${receipt.image_url}`);
        const { data: publicUrlData } = supabase.storage
          .from('receipt-images')
          .getPublicUrl(receipt.image_url); // image_url here is the path
        
        if (publicUrlData && publicUrlData.publicUrl) {
          publicImageUrl = publicUrlData.publicUrl;
          console.log(`GET /api/receipts: Generated public URL: ${publicImageUrl}`);
        } else {
          console.warn(`GET /api/receipts: Could not generate public URL for ${receipt.image_url}. Falling back to stored path.`);
        }
      }
      return {
        ...receipt,
        image_url: publicImageUrl,
      };
    });
    
    console.log("GET /api/receipts: Returning receipts with public URLs. Data:", JSON.stringify(receiptsWithPublicUrls, null, 2));
    return NextResponse.json({ success: true, receipts: receiptsWithPublicUrls as Receipt[] }, { status: 200 });

  } catch (error) {
    console.error('GET /api/receipts: Unhandled error in try block:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: `Error processing request: ${errorMessage}` }, { status: 500 });
  }
}
// GET handler will be added later for fetching receipts