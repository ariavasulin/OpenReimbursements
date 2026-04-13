import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';

export async function POST(request: NextRequest) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();

    if (sessionError || !session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = session.user.id;
    const body = await request.json();
    const { receipt_date, amount } = body;

    if (!receipt_date || amount === undefined || amount === null) {
      return NextResponse.json({ error: 'Missing required fields: receipt_date and amount' }, { status: 400 });
    }

    const numericAmount = Number(amount);
    if (isNaN(numericAmount)) {
        return NextResponse.json({ error: 'Invalid amount format' }, { status: 400 });
    }

    const { data: existingReceipts, error: dbError } = await supabase
      .from('receipts')
      .select('id, description')
      .eq('user_id', userId)
      .eq('receipt_date', receipt_date)
      .eq('amount', numericAmount);

    if (dbError) {
      return NextResponse.json({ error: 'Database error while checking for duplicates', details: dbError.message }, { status: 500 });
    }

    if (existingReceipts && existingReceipts.length > 0) {
      return NextResponse.json({
        isDuplicate: true,
        existingReceipts: existingReceipts.map(r => ({ id: r.id, description: r.description || "" })),
      });
    } else {
      return NextResponse.json({
        isDuplicate: false,
        existingReceipts: [],
      });
    }

  } catch (error: any) {
    console.error('Check Duplicate API: Unexpected error:', error);
    return NextResponse.json({ error: 'Internal server error', details: error.message }, { status: 500 });
  }
}
