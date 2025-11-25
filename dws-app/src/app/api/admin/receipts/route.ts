import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import type { Receipt } from '@/lib/types';

/**
 * GET /api/admin/receipts
 *
 * Admin-only endpoint that returns all receipts with user profile information
 * including phone numbers from auth.users table.
 *
 * Query parameters:
 * - status: Filter by receipt status (Pending, Approved, Rejected, Reimbursed)
 * - fromDate: Filter receipts from this date (YYYY-MM-DD)
 * - toDate: Filter receipts before this date (YYYY-MM-DD)
 */
export async function GET(request: Request) {
  console.log("GET /api/admin/receipts: Handler called");
  const supabase = await createSupabaseServerClient();

  // Verify authentication
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) {
    console.error("GET /api/admin/receipts: Session error:", sessionError);
    return NextResponse.json({ error: 'Failed to get session' }, { status: 500 });
  }

  if (!session) {
    console.log("GET /api/admin/receipts: No session, unauthorized");
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify admin role
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('user_id', session.user.id)
    .single();

  if (profileError || !profile || profile.role !== 'admin') {
    console.log("GET /api/admin/receipts: User is not admin");
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const statusFilter = searchParams.get('status');
    const fromDate = searchParams.get('fromDate');
    const toDate = searchParams.get('toDate');

    console.log("GET /api/admin/receipts: Filters -", { statusFilter, fromDate, toDate });

    // Call our custom Postgres function that includes phone numbers
    console.log("GET /api/admin/receipts: Calling get_admin_receipts_with_phone function");
    const { data: receiptsData, error: queryError } = await supabase.rpc(
      'get_admin_receipts_with_phone',
      {
        status_filter: statusFilter || null,
        from_date: fromDate || null,
        to_date: toDate || null,
      }
    );

    if (queryError) {
      console.error('GET /api/admin/receipts: Query error:', queryError);
      return NextResponse.json({ error: queryError.message }, { status: 500 });
    }

    // Map receipts to match frontend Receipt interface
    const mappedReceipts = (receiptsData || []).map((item: any) => {
      let publicImageUrl = item.image_url;

      if (item.image_url) {
        const { data: publicUrlData } = supabase.storage
          .from('receipt-images')
          .getPublicUrl(item.image_url);

        if (publicUrlData?.publicUrl) {
          publicImageUrl = publicUrlData.publicUrl;
        }
      }

      return {
        id: item.id,
        user_id: item.user_id,
        employeeName: item.preferred_name || item.full_name || "Unknown",
        employeeId: item.employee_id_internal || "",
        phone: item.phone || null,
        date: item.receipt_date,
        amount: item.amount,
        status: item.status,
        category_id: item.category_id,
        category: item.category_name || "Uncategorized",
        description: item.description || "",
        image_url: publicImageUrl,
        created_at: item.created_at,
        updated_at: item.updated_at,
      };
    });

    console.log(`GET /api/admin/receipts: Returning ${mappedReceipts.length} receipts`);
    return NextResponse.json({
      success: true,
      receipts: mappedReceipts as Receipt[]
    }, { status: 200 });

  } catch (error) {
    console.error('GET /api/admin/receipts: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({
      error: `Error processing request: ${errorMessage}`
    }, { status: 500 });
  }
}
