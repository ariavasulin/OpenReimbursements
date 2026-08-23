import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { isStorageNotFound } from '@/lib/storageErrors';
import { keysetOrFilter } from '@/lib/keysetCursor';
import { decodeReceiptCursor, encodeReceiptCursor } from '@/lib/receiptCursor';
import { RECEIPT_STATUS_VALUES, type Receipt } from '@/lib/types';

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

    // No pre-flight existence check: storage.move() returns a 404 when the
    // source object is missing, and the moveError branch below already cleans
    // up the orphan receipt row. The check that used to live here compiled to
    // storage.search(), which cost 29.6% of all database time (85ms mean,
    // 1527ms p-max, 3213 calls) for information the move already gives us.
    const { error: moveError } = await supabase.storage
      .from(bucketName)
      .move(tempFilePath, finalImagePath);

    if (moveError) {
      const { error: deleteDbError } = await supabase.from('receipts').delete().eq('id', newReceiptId);
      // Best-effort cleanup, ignore deleteDbError
      // A missing source is the "temp file not found" case the old pre-flight
      // list() reported as 404; everything else is a genuine 500.
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

/** Status values stored in receipts.status, keyed by their lowercase form. */
const RECEIPT_STATUSES: Record<string, string> = Object.fromEntries(
  RECEIPT_STATUS_VALUES.map((status) => [status.toLowerCase(), status])
);

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
  const limit = Math.min(
    Math.max(parseInt(params.get('limit') ?? '', 10) || DEFAULT_RECEIPTS_LIMIT, 1),
    MAX_RECEIPTS_LIMIT
  );
  const rawCursor = params.get('cursor');

  // The employee table's status filter is applied here, not over the returned
  // rows: only one page is loaded at a time, so a client-side filter searched
  // a 50-row prefix and reported "No receipts found" for anyone whose matching
  // receipt sat further back in their history.
  const rawStatus = params.get('status');
  const statusFilter = rawStatus ? RECEIPT_STATUSES[rawStatus.toLowerCase()] : undefined;
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
      // Keyset pagination on (receipt_date, created_at), same idiom as
      // GET /api/photos. Separate or() calls are ANDed by PostgREST, so this
      // composes with the user_id filter.
      query = query.or(
        keysetOrFilter('receipt_date', cursor.receiptDate, 'created_at', cursor.createdAt)
      );
    }

    const { data: rows, error: dbError } = await query;

    if (dbError) {
      return NextResponse.json({ error: dbError.message || 'Failed to fetch receipts from database' }, { status: 500 });
    }

    const page = (rows ?? []).slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor =
      (rows ?? []).length > limit && last
        ? encodeReceiptCursor(last.receipt_date, last.created_at)
        : null;

    const mappedReceipts = page.map((item: any) => {
      let publicImageUrl = item.image_url;
      if (item.image_url) {
        const { data: publicUrlData } = supabase.storage
          .from('receipt-images')
          .getPublicUrl(item.image_url);

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

    let userIsAdmin = false;
    const isOwner = existingReceipt.user_id === userId;

    if (!isOwner) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('user_id', userId)
        .single();

      if (!profile || profile.role !== 'admin') {
        return NextResponse.json({ error: 'You can only edit your own receipts' }, { status: 403 });
      }
      userIsAdmin = true;
    } else {
      // Owner - check if also admin (needed for status check)
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('role')
        .eq('user_id', userId)
        .single();
      userIsAdmin = profile?.role === 'admin';
    }

    if (existingReceipt.status.toLowerCase() !== 'pending' && !userIsAdmin) {
      return NextResponse.json({
        error: `Cannot edit receipt with status "${existingReceipt.status}". Contact an admin.`
      }, { status: 403 });
    }

    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (receipt_date !== undefined) updateData.receipt_date = receipt_date;
    if (amount !== undefined) updateData.amount = amount;
    if (category_id !== undefined) updateData.category_id = category_id;
    if (notes !== undefined) updateData.description = notes;
    if (status !== undefined) {
      const validStatuses = ['Pending', 'Approved', 'Rejected', 'Reimbursed'];
      const capitalizedStatus = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
      if (!validStatuses.includes(capitalizedStatus)) {
        return NextResponse.json({ error: `Invalid status value. Must be one of: ${validStatuses.join(', ')}` }, { status: 400 });
      }
      updateData.status = capitalizedStatus;
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
