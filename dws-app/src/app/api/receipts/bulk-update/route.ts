import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/requireAdmin';

export async function PUT(request: Request) {
  const gate = await requireAdmin();
  if (gate.response) return gate.response;
  const { supabase } = gate;

  try {
    const body = await request.json();

    const { fromStatus, toStatus } = body;

    if (fromStatus !== 'Approved' || toStatus !== 'Reimbursed') {
      return NextResponse.json({
        error: 'Invalid status transition. Only Approved → Reimbursed is supported.'
      }, { status: 400 });
    }

    const { count, error: countError } = await supabase
      .from('receipts')
      .select('*', { count: 'exact', head: true })
      .eq('status', fromStatus);

    if (countError) {
      return NextResponse.json({ error: 'Failed to count receipts' }, { status: 500 });
    }

    if (!count || count === 0) {
      return NextResponse.json({
        success: true,
        message: 'No approved receipts found to update',
        updatedCount: 0
      });
    }

    const { data: updatedReceipts, error: updateError } = await supabase
      .from('receipts')
      .update({
        status: toStatus,
        updated_at: new Date().toISOString()
      })
      .eq('status', fromStatus)
      .select('id');

    if (updateError) {
      return NextResponse.json({
        error: `Failed to update receipts: ${updateError.message}`
      }, { status: 500 });
    }

    const actualUpdatedCount = updatedReceipts?.length || 0;

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
