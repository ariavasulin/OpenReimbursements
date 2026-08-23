import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { isStorageNotFound } from '@/lib/storageErrors';
import { encodeKeysetCursor, keysetOrFilter, parseLimit } from '@/lib/keysetCursor';
import { decodeReceiptCursor } from '@/lib/receiptCursor';
import { RECEIPT_STATUS_VALUES, parseReceiptStatus, type Receipt } from '@/lib/types';

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
    const { receipt_date, amount, category_id, notes, tempFilePath } = body;

    if (!receipt_date || amount === undefined || !category_id || !tempFilePath) {
      return NextResponse.json({ error: 'Missing required fields: receipt_date, amount, category_id, tempFilePath' }, { status: 400 });
    }

    const { data: newReceipt, error: insertError } = await supabase
      .from('receipts')
      .insert({
        user_id: userId,
        receipt_date: receipt_date,
        amount: amount,
        category_id: category_id,
        description: notes,
        status: 'Pending', // Capitalized to match DB constraint
        image_url: tempFilePath,
      })
      .select()
      .single();

    if (insertError || !newReceipt) {
      if (tempFilePath) {
        const { error: deleteError } = await supabase.storage.from('receipt-images').remove([tempFilePath]);
        // Best-effort cleanup, ignore deleteError
      }
      return NextResponse.json({ error: insertError?.message || 'Failed to create receipt record during INSERT' }, { status: 500 });
    }

    const newReceiptId = newReceipt.id;
    const originalFileExtension = tempFilePath.split('.').pop();
    const finalImagePath = `${userId}/${newReceiptId}.${originalFileExtension}`;
    const bucketName = 'receipt-images';

    const { error: moveError } = await supabase.storage
      .from(bucketName)
      .move(tempFilePath, finalImagePath);

    if (moveError) {
      console.error('POST /api/receipts: storage move failed', {
        tempFilePath,
        finalImagePath,
        error: moveError,
      });
      const { error: deleteDbError } = await supabase.from('receipts').delete().eq('id', newReceiptId);
      // Best-effort cleanup, ignore deleteDbError
      const notFound = isStorageNotFound(moveError);
      return NextResponse.json(
        {
          error: notFound
            ? `Temporary file not found before move. Path: ${tempFilePath}`
            : `Failed to finalize image storage during MOVE: ${moveError.message}`,
        },
        { status: notFound ? 404 : 500 }
      );
    }

    const { data: updatedReceipt, error: updateError } = await supabase
      .from('receipts')
      .update({ image_url: finalImagePath })
      .eq('id', newReceiptId)
      .select()
      .single();

    if (updateError || !updatedReceipt) {
      // Critical: File is moved, but DB update failed.
      // Options: try to move file back, or flag for manual reconciliation.
      // For now, just log and error out.
      return NextResponse.json({ error: updateError?.message || 'Failed to update receipt with final image path during UPDATE' }, { status: 500 });
    }

    return NextResponse.json({ success: true, receipt: updatedReceipt as Receipt }, { status: 201 });

  } catch (error) {
    console.error('POST /api/receipts: Unhandled error in try-catch block:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: `Error processing request: ${errorMessage}` }, { status: 500 });
  }
}

const DEFAULT_RECEIPTS_LIMIT = 50;
const MAX_RECEIPTS_LIMIT = 200;

export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) {
    return NextResponse.json({ error: 'Failed to get session' }, { status: 500 });
  }

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;

  const params = new URL(request.url).searchParams;
  const limit = parseLimit(params.get('limit'), DEFAULT_RECEIPTS_LIMIT, MAX_RECEIPTS_LIMIT);
  if (limit === null) {
    return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
  }
  const rawCursor = params.get('cursor');

  const rawStatus = params.get('status');
  const statusFilter = rawStatus ? parseReceiptStatus(rawStatus) : undefined;
  if (rawStatus && rawStatus.toLowerCase() !== 'all' && !statusFilter) {
    return NextResponse.json({ error: 'Invalid status filter' }, { status: 400 });
  }

  try {
    let query = supabase
      .from('receipts')
      .select(`
        id,
        receipt_date,
        amount,
        status,
        category_id,
        user_id,
        categories!receipts_category_id_fkey (name),
        description,
        image_url,
        created_at,
        updated_at
      `)
      .eq('user_id', userId)
      .order('receipt_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    if (statusFilter) {
      query = query.eq('status', statusFilter);
    }

    if (rawCursor) {
      const cursor = decodeReceiptCursor(rawCursor);
      if (!cursor) {
        return NextResponse.json({ error: 'Invalid cursor' }, { status: 400 });
      }
      // Separate or() calls are ANDed by PostgREST, so this composes with the
      // user_id filter.
      query = query.or(
        keysetOrFilter('receipt_date', cursor.receiptDate, 'created_at', cursor.createdAt)
      );
    }

    const { data, error: dbError } = await query;

    if (dbError) {
      return NextResponse.json({ error: dbError.message || 'Failed to fetch receipts from database' }, { status: 500 });
    }

    const rows = data ?? [];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > limit ? encodeKeysetCursor(last.receipt_date, last.created_at) : null;

    const bucket = supabase.storage.from('receipt-images');
    const mappedReceipts = page.map((item: any) => {
      let publicImageUrl = item.image_url;
      if (item.image_url) {
        const { data: publicUrlData } = bucket.getPublicUrl(item.image_url);

        if (publicUrlData && publicUrlData.publicUrl) {
          publicImageUrl = publicUrlData.publicUrl;
        }
      }

      return {
        id: item.id,
        user_id: item.user_id,
        employeeName: "Employee", // Not needed for employee view, but included for interface compatibility
        employeeId: "N/A",
        date: item.receipt_date,
        amount: item.amount,
        status: item.status.toLowerCase(),
        category_id: item.category_id,
        category: item.categories?.name || "Uncategorized",
        description: item.description || "",
        notes: item.description, // Keep both for compatibility
        image_url: publicImageUrl,
        created_at: item.created_at,
        updated_at: item.updated_at,
      };
    });

    return NextResponse.json(
      { success: true, receipts: mappedReceipts as Receipt[], nextCursor },
      { status: 200 }
    );

  } catch (error) {
    console.error('GET /api/receipts: Unhandled error in try block:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: `Error processing request: ${errorMessage}` }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) {
    return NextResponse.json({ error: 'Failed to get session' }, { status: 500 });
  }

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;

  try {
    const body = await request.json();

    const { id, receipt_date, amount, category_id, notes, status } = body;

    if (!id) {
      return NextResponse.json({ error: 'Receipt ID is required' }, { status: 400 });
    }

    if (receipt_date === undefined && amount === undefined && category_id === undefined && notes === undefined && status === undefined) {
      return NextResponse.json({ error: 'At least one field to update is required' }, { status: 400 });
    }

    const { data: existingReceipt, error: fetchError } = await supabase
      .from('receipts')
      .select('id, user_id, status')
      .eq('id', id)
      .single();

    if (fetchError || !existingReceipt) {
      return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
    }

    const isOwner = existingReceipt.user_id === userId;
    const isPending = existingReceipt.status.toLowerCase() === 'pending';
    // The role only decides the cases below; an owner editing a Pending
    // receipt's details never needs the lookup.
    let userIsAdmin = false;
    if (!isOwner || !isPending || status !== undefined) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('user_id', userId)
        .single();
      userIsAdmin = profile?.role === 'admin';
    }

    if (!isOwner && !userIsAdmin) {
      return NextResponse.json({ error: 'You can only edit your own receipts' }, { status: 403 });
    }

    if (!isPending && !userIsAdmin) {
      return NextResponse.json({
        error: `Cannot edit receipt with status "${existingReceipt.status}". Contact an admin.`
      }, { status: 403 });
    }

    // The owner of a Pending receipt may edit its details, not its status; the
    // database enforces the same rule with a trigger
    // (20260823120100_write_guards.sql), this just answers 403 instead of 500.
    if (status !== undefined && !userIsAdmin) {
      return NextResponse.json({ error: 'Only an admin can change a receipt status' }, { status: 403 });
    }

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (receipt_date !== undefined) updateData.receipt_date = receipt_date;
    if (amount !== undefined) updateData.amount = amount;
    if (category_id !== undefined) updateData.category_id = category_id;
    if (notes !== undefined) updateData.description = notes;
    if (status !== undefined) {
      const canonical = parseReceiptStatus(String(status));
      if (!canonical) {
        return NextResponse.json({ error: `Invalid status value. Must be one of: ${RECEIPT_STATUS_VALUES.join(', ')}` }, { status: 400 });
      }
      updateData.status = canonical;
    }

    const { data: updatedReceipt, error: updateError } = await supabase
      .from('receipts')
      .update(updateData)
      .eq('id', id)
      .select(`
        id,
        receipt_date,
        amount,
        status,
        category_id,
        user_id,
        categories!receipts_category_id_fkey (name),
        description,
        image_url,
        created_at,
        updated_at
      `)
      .single();

    if (updateError || !updatedReceipt) {
      return NextResponse.json({ error: updateError?.message || 'Failed to update receipt' }, { status: 500 });
    }

    let publicImageUrl = updatedReceipt.image_url;
    if (updatedReceipt.image_url) {
      const { data: publicUrlData } = supabase.storage
        .from('receipt-images')
        .getPublicUrl(updatedReceipt.image_url);

      if (publicUrlData?.publicUrl) {
        publicImageUrl = publicUrlData.publicUrl;
      }
    }

    const mappedReceipt = {
      id: updatedReceipt.id,
      user_id: updatedReceipt.user_id,
      date: updatedReceipt.receipt_date,
      amount: updatedReceipt.amount,
      status: updatedReceipt.status.toLowerCase(),
      category_id: updatedReceipt.category_id,
      category: (updatedReceipt.categories as unknown as { name: string } | null)?.name || "Uncategorized",
      description: updatedReceipt.description || "",
      notes: updatedReceipt.description,
      image_url: publicImageUrl,
      created_at: updatedReceipt.created_at,
      updated_at: updatedReceipt.updated_at,
    };

    return NextResponse.json({ success: true, receipt: mappedReceipt }, { status: 200 });

  } catch (error) {
    console.error('PATCH /api/receipts: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: `Error processing request: ${errorMessage}` }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const supabase = await createSupabaseServerClient();

  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) {
    return NextResponse.json({ error: 'Failed to get session' }, { status: 500 });
  }

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const { searchParams } = new URL(request.url);
  const receiptId = searchParams.get('id');

  if (!receiptId) {
    return NextResponse.json({ error: 'Receipt ID is required' }, { status: 400 });
  }

  try {
    const { data: receipt, error: fetchError } = await supabase
      .from('receipts')
      .select('id, user_id, status, image_url')
      .eq('id', receiptId)
      .single();

    if (fetchError || !receipt) {
      return NextResponse.json({ error: 'Receipt not found' }, { status: 404 });
    }

    const isOwner = receipt.user_id === userId;
    const isPending = receipt.status.toLowerCase() === 'pending';

    let isAdmin = false;
    if (!isOwner || !isPending) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('user_id', userId)
        .single();
      isAdmin = profile?.role === 'admin';
    }

    // Employees can only delete their own pending receipts
    // Admins can delete any receipt
    if (!isAdmin && (!isOwner || !isPending)) {
      if (!isOwner) {
        return NextResponse.json({ error: 'You can only delete your own receipts' }, { status: 403 });
      }
      return NextResponse.json({
        error: `Cannot delete receipt with status "${receipt.status}". Contact an admin.`
      }, { status: 403 });
    }

    if (receipt.image_url) {
      const { error: storageError } = await supabase.storage
        .from('receipt-images')
        .remove([receipt.image_url]);
      // Continue with deletion even if image removal fails
    }

    const { error: deleteError } = await supabase
      .from('receipts')
      .delete()
      .eq('id', receiptId);

    if (deleteError) {
      return NextResponse.json({ error: 'Failed to delete receipt' }, { status: 500 });
    }

    return NextResponse.json({ success: true }, { status: 200 });

  } catch (error) {
    console.error('DELETE /api/receipts: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: `Error processing request: ${errorMessage}` }, { status: 500 });
  }
}
