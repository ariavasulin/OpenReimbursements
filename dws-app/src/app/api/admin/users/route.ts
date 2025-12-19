import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { supabaseAdmin } from '@/lib/supabaseAdminClient';
import type { AdminUser } from '@/lib/types';

/**
 * GET /api/admin/users
 *
 * Admin-only endpoint that returns all users with profile information.
 *
 * Query parameters:
 * - page: Page number (default: 1)
 * - perPage: Results per page (default: 50, max: 1000)
 * - search: Search query for name, phone, employee ID
 * - includeDeleted: Include soft-deleted users (default: false)
 */
export async function GET(request: Request) {
  const supabase = await createSupabaseServerClient();

  // Verify authentication
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) {
    console.error("GET /api/admin/users: Session error:", sessionError);
    return NextResponse.json({ error: 'Failed to get session' }, { status: 500 });
  }

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify admin role
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('user_id', session.user.id)
    .single();

  if (profileError || !profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const perPage = Math.min(1000, Math.max(1, parseInt(searchParams.get('perPage') || '50', 10)));
    const search = searchParams.get('search')?.toLowerCase() || '';
    const includeDeleted = searchParams.get('includeDeleted') === 'true';

    // Fetch all auth users using admin API
    // Note: Supabase Admin API pagination is 1-indexed
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage,
    });

    if (authError) {
      console.error('GET /api/admin/users: Auth error:', authError);
      return NextResponse.json({ error: authError.message }, { status: 500 });
    }

    const authUsers = authData.users || [];
    const totalFromAuth = authData.total || authUsers.length;

    if (authUsers.length === 0) {
      return NextResponse.json({
        users: [],
        page,
        perPage,
        total: 0,
      });
    }

    // Fetch user_profiles for all returned user IDs
    const userIds = authUsers.map(u => u.id);
    const { data: profiles, error: profilesError } = await supabaseAdmin
      .from('user_profiles')
      .select('user_id, role, full_name, preferred_name, employee_id_internal, deleted_at')
      .in('user_id', userIds);

    if (profilesError) {
      console.error('GET /api/admin/users: Profiles error:', profilesError);
      return NextResponse.json({ error: profilesError.message }, { status: 500 });
    }

    // Create a map of profiles by user_id
    const profileMap = new Map(
      (profiles || []).map(p => [p.user_id, p])
    );

    // Merge auth data with profile data
    let users: AdminUser[] = authUsers.map(authUser => {
      const userProfile = profileMap.get(authUser.id);
      return {
        id: authUser.id,
        phone: authUser.phone || '',
        created_at: authUser.created_at,
        last_sign_in_at: authUser.last_sign_in_at || undefined,
        banned_until: authUser.banned_until || undefined,
        role: userProfile?.role || 'employee',
        full_name: userProfile?.full_name || undefined,
        preferred_name: userProfile?.preferred_name || undefined,
        employee_id_internal: userProfile?.employee_id_internal || undefined,
        deleted_at: userProfile?.deleted_at || null,
      };
    });

    // Filter out deleted users unless includeDeleted is true
    if (!includeDeleted) {
      users = users.filter(u => !u.deleted_at);
    }

    // Apply search filter if provided (client-side since Admin API doesn't support server-side search)
    if (search) {
      users = users.filter(u => {
        const fullName = (u.full_name || '').toLowerCase();
        const preferredName = (u.preferred_name || '').toLowerCase();
        const phone = (u.phone || '').toLowerCase();
        const employeeId = (u.employee_id_internal || '').toLowerCase();

        return fullName.includes(search) ||
               preferredName.includes(search) ||
               phone.includes(search) ||
               employeeId.includes(search);
      });
    }

    return NextResponse.json({
      users,
      page,
      perPage,
      total: search ? users.length : totalFromAuth, // If searching, return filtered count
    });

  } catch (error) {
    console.error('GET /api/admin/users: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

/**
 * POST /api/admin/users
 *
 * Admin-only endpoint to create a new user.
 *
 * Request body:
 * - phone: Phone number (required, 10-digit US number)
 * - full_name: Full name (required)
 * - preferred_name: Preferred name (optional)
 * - employee_id_internal: Employee ID (optional)
 * - role: 'employee' | 'admin' (default: 'employee')
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();

  // Verify authentication
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) {
    console.error("POST /api/admin/users: Session error:", sessionError);
    return NextResponse.json({ error: 'Failed to get session' }, { status: 500 });
  }

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Verify admin role
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('user_id', session.user.id)
    .single();

  if (profileError || !profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const { phone, full_name, preferred_name, employee_id_internal, role = 'employee' } = body;

    // Validate required fields
    if (!phone || !full_name) {
      return NextResponse.json(
        { error: 'Phone and full_name are required' },
        { status: 400 }
      );
    }

    // Validate and format phone number
    const formattedPhone = formatUSPhoneNumber(phone);
    if (!formattedPhone) {
      return NextResponse.json(
        { error: 'Invalid phone number format. Please provide a 10-digit US number.' },
        { status: 400 }
      );
    }

    // Validate role
    if (role !== 'employee' && role !== 'admin') {
      return NextResponse.json(
        { error: 'Role must be "employee" or "admin"' },
        { status: 400 }
      );
    }

    // Create auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      phone: formattedPhone,
      phone_confirm: true,
      user_metadata: {
        full_name,
        preferred_name,
        employee_id_internal,
      },
    });

    if (authError) {
      console.error('POST /api/admin/users: Auth error:', authError);

      // Handle specific errors
      if (authError.message?.includes('phone_exists') || authError.message?.includes('already been registered')) {
        return NextResponse.json(
          { error: 'Phone number already registered' },
          { status: 409 }
        );
      }

      return NextResponse.json({ error: authError.message }, { status: 500 });
    }

    if (!authData.user) {
      return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
    }

    // Create user_profiles record
    const { error: profileInsertError } = await supabaseAdmin
      .from('user_profiles')
      .insert({
        user_id: authData.user.id,
        role,
        full_name,
        preferred_name: preferred_name || null,
        employee_id_internal: employee_id_internal || null,
      });

    if (profileInsertError) {
      console.error('POST /api/admin/users: Profile insert error:', profileInsertError);
      // User was created in auth but profile failed - try to clean up
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      return NextResponse.json({ error: 'Failed to create user profile' }, { status: 500 });
    }

    // Return created user
    const createdUser: AdminUser = {
      id: authData.user.id,
      phone: authData.user.phone || formattedPhone,
      created_at: authData.user.created_at,
      last_sign_in_at: undefined,
      banned_until: undefined,
      role,
      full_name,
      preferred_name: preferred_name || undefined,
      employee_id_internal: employee_id_internal || undefined,
      deleted_at: null,
    };

    return NextResponse.json({ user: createdUser }, { status: 201 });

  } catch (error) {
    console.error('POST /api/admin/users: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

/**
 * Formats a US phone number to E.164 format (+1XXXXXXXXXX)
 * @param input - Phone number in various formats
 * @returns E.164 formatted number or null if invalid
 */
function formatUSPhoneNumber(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  return null;
}
