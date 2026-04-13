import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { supabaseAdmin } from '@/lib/supabaseAdminClient';
import type { AdminUser } from '@/lib/types';

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

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('user_id', session.user.id)
    .single();

  if (profileError || !profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const perPage = Math.min(1000, Math.max(1, parseInt(searchParams.get('perPage') || '50', 10)));
    const search = searchParams.get('search') || null;
    const includeDeleted = searchParams.get('includeDeleted') === 'true';

    const { data: users, error: usersError } = await supabaseAdmin.rpc(
      'get_auth_users_for_admin',
      {
        page_num: page,
        page_size: perPage,
        search_query: search,
        include_deleted: includeDeleted,
      }
    );

    if (usersError) {
      return NextResponse.json({ error: usersError.message }, { status: 500 });
    }

    const { data: total, error: countError } = await supabaseAdmin.rpc(
      'get_auth_users_count',
      {
        search_query: search,
        include_deleted: includeDeleted,
      }
    );

    if (countError) {
      return NextResponse.json({ error: countError.message }, { status: 500 });
    }

    const mappedUsers: AdminUser[] = (users || []).map((u: {
      id: string;
      phone: string | null;
      created_at: string;
      last_sign_in_at: string | null;
      banned_until: string | null;
      role: string;
      full_name: string | null;
      preferred_name: string | null;
      employee_id_internal: string | null;
      deleted_at: string | null;
    }) => ({
      id: u.id,
      phone: u.phone || '',
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at || undefined,
      banned_until: u.banned_until || undefined,
      role: u.role as 'employee' | 'admin',
      full_name: u.full_name || undefined,
      preferred_name: u.preferred_name || undefined,
      employee_id_internal: u.employee_id_internal || undefined,
      deleted_at: u.deleted_at || null,
    }));

    return NextResponse.json({
      users: mappedUsers,
      page,
      perPage,
      total: total || 0,
    });

  } catch (error) {
    console.error('GET /api/admin/users: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

export async function POST(request: Request) {
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

    if (!phone || !full_name) {
      return NextResponse.json(
        { error: 'Phone and full_name are required' },
        { status: 400 }
      );
    }

    const formattedPhone = formatUSPhoneNumber(phone);
    if (!formattedPhone) {
      return NextResponse.json(
        { error: 'Invalid phone number format. Please provide a 10-digit US number.' },
        { status: 400 }
      );
    }

    if (role !== 'employee' && role !== 'admin') {
      return NextResponse.json(
        { error: 'Role must be "employee" or "admin"' },
        { status: 400 }
      );
    }

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

    // Note: Database trigger on_auth_user_created may have already created a basic profile,
    // so we use upsert to handle both cases
    const { error: profileUpsertError } = await supabaseAdmin
      .from('user_profiles')
      .upsert(
        {
          user_id: authData.user.id,
          role,
          full_name,
          preferred_name: preferred_name || null,
          employee_id_internal: employee_id_internal || null,
        },
        { onConflict: 'user_id' }
      );

    if (profileUpsertError) {
      // User was created in auth but profile failed - try to clean up
      await supabaseAdmin.auth.admin.deleteUser(authData.user.id);
      return NextResponse.json({ error: 'Failed to create user profile' }, { status: 500 });
    }

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

function formatUSPhoneNumber(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  return null;
}
