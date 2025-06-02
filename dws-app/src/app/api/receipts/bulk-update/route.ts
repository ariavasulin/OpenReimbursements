import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';

export async function PUT(request: Request) {
  console.log("PUT /api/receipts/bulk-update: Handler called");
  const supabase = await createSupabaseServerClient();

  // Verify authentication
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) {
    console.error("PUT /api/receipts/bulk-update: Session error:", sessionError);
    return NextResponse.json({ error: 'Failed to get session' }, { status: 500 });
  }

  if (!session) {
    console.log("PUT /api/receipts/bulk-update: No session, unauthorized");
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify admin role
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('user_id', session.user.id)
    .single();

  if (profileError || !profile || profile.role !== 'admin') {
    console.log("PUT /api/receipts/bulk-update: User is not admin");
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const body = await request.json();
    console.log("PUT /api/receipts/bulk-update: Request body:", body);
    
    const { fromStatus, toStatus } = body;

    // Validate request body
    if (fromStatus !== 'Approved' || toStatus !== 'Reimbursed') {
      return NextResponse.json({ 
        error: 'Invalid status transition. Only Approved → Reimbursed is supported.' 
      }, { status: 400 });
    }

    console.log("PUT /api/receipts/bulk-update: Starting bulk update transaction");

    // First, get count of receipts that will be updated
    const { count, error: countError } = await supabase
      .from('receipts')
      .select('*', { count: 'exact', head: true })
      .eq('status', fromStatus);

    if (countError) {
      console.error('PUT /api/receipts/bulk-update: Error counting receipts:', countError);
      return NextResponse.json({ error: 'Failed to count receipts' }, { status: 500 });
    }

    console.log(`PUT /api/receipts/bulk-update: Found ${count || 0} receipts to update`);

    if (!count || count === 0) {
      return NextResponse.json({ 
        success: true, 
        message: 'No approved receipts found to update',
        updatedCount: 0 
      });
    }

    // Perform the bulk update in a transaction
    const { data: updatedReceipts, error: updateError } = await supabase
      .from('receipts')
      .update({ 
        status: toStatus,
        updated_at: new Date().toISOString()
      })
      .eq('status', fromStatus)
      .select('id');

    if (updateError) {
      console.error('PUT /api/receipts/bulk-update: Error updating receipts:', updateError);
      return NextResponse.json({ 
        error: `Failed to update receipts: ${updateError.message}` 
      }, { status: 500 });
    }

    const actualUpdatedCount = updatedReceipts?.length || 0;
    console.log(`PUT /api/receipts/bulk-update: Successfully updated ${actualUpdatedCount} receipts`);

    return NextResponse.json({ 
      success: true, 
      message: `Successfully updated ${actualUpdatedCount} receipts from ${fromStatus} to ${toStatus}`,
      updatedCount: actualUpdatedCount
    });

  } catch (error) {
    console.error('PUT /api/receipts/bulk-update: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ 
      error: `Error processing bulk update: ${errorMessage}` 
    }, { status: 500 });
  }
} 