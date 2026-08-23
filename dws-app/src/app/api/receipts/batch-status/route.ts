import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/requireAdmin';
import { RECEIPT_STATUS_VALUES, type BatchStatusRequest } from '@/lib/types';

export async function PATCH(request: Request): Promise<NextResponse> {
  const gate = await requireAdmin();
  if (gate.response) return gate.response;
  const { supabase } = gate;

  try {
    const body = (await request.json()) as BatchStatusRequest;
    const decisions = body?.decisions;

    if (!Array.isArray(decisions) || decisions.length === 0) {
      return NextResponse.json({ error: 'Missing or empty decisions array' }, { status: 400 });
    }

    for (const decision of decisions) {
      if (!decision?.id || !decision?.status || !RECEIPT_STATUS_VALUES.includes(decision.status)) {
        return NextResponse.json({ error: 'Each decision requires a valid id and status' }, { status: 400 });
      }
    }

    const results = await Promise.all(
      decisions.map((decision) =>
        supabase.from('receipts').update({ status: decision.status }).eq('id', decision.id)
      )
    );

    const failed = results.find((result) => result.error);
    if (failed?.error) {
      return NextResponse.json(
        { error: `Failed to update one or more receipts. First error: ${failed.error.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, updatedCount: decisions.length }, { status: 200 });
  } catch (error) {
    console.error('PATCH /api/receipts/batch-status: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: `Error processing request: ${errorMessage}` }, { status: 500 });
  }
}
