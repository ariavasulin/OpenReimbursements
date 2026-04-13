import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { supabaseAdmin } from '@/lib/supabaseAdminClient';
import type { AdminUser } from '@/lib/types';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteParams) {
  const { id: userId } = await params;
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
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);

    if (authError || !authData.user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const { data: userProfile, error: userProfileError } = await supabaseAdmin
      .from('user_profiles')
      .select('role, full_name, preferred_name, employee_id_internal, deleted_at')
      .eq('user_id', userId)
      .single();

    if (userProfileError && userProfileError.code !== 'PGRST116') {
      // Log only unexpected profile errors (not "no rows found")
    }

    const user: AdminUser = {
      id: authData.user.id,
      phone: authData.user.phone || '',
      created_at: authData.user.created_at,
      last_sign_in_at: authData.user.last_sign_in_at || undefined,
      banned_until: authData.user.banned_until || undefined,
      role: userProfile?.role || 'employee',
      full_name: userProfile?.full_name || undefined,
      preferred_name: userProfile?.preferred_name || undefined,
      employee_id_internal: userProfile?.employee_id_internal || undefined,
      deleted_at: userProfile?.deleted_at || null,
    };

    return NextResponse.json({ user });

  } catch (error) {
    console.error('GET /api/admin/users/[id]: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { id: userId } = await params;
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
    const { phone, full_name, preferred_name, employee_id_internal, role } = body;

    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);

    if (authError || !authData.user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const currentPhone = authData.user.phone;
    let phoneChanged = false;

    if (phone && phone !== currentPhone) {
      const formattedPhone = formatUSPhoneNumber(phone);
      if (!formattedPhone) {
        return NextResponse.json(
          { error: 'Invalid phone number format. Please provide a 10-digit US number.' },
          { status: 400 }
        );
      }

      const { error: updateAuthError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        phone: formattedPhone,
        phone_confirm: true,
      });

      if (updateAuthError) {
        if (updateAuthError.message?.includes('phone_exists') || updateAuthError.message?.includes('already been registered')) {
          return NextResponse.json(
            { error: 'Phone number already registered' },
            { status: 409 }
          );
        }
        return NextResponse.json({ error: updateAuthError.message }, { status: 500 });
      }

      phoneChanged = true;
    }

    const profileUpdates: Record<string, unknown> = {};
    if (full_name !== undefined) profileUpdates.full_name = full_name;
    if (preferred_name !== undefined) profileUpdates.preferred_name = preferred_name || null;
    if (employee_id_internal !== undefined) profileUpdates.employee_id_internal = employee_id_internal || null;
    if (role !== undefined) {
      if (role !== 'employee' && role !== 'admin') {
        return NextResponse.json(
          { error: 'Role must be "employee" or "admin"' },
          { status: 400 }
        );
      }
      profileUpdates.role = role;
    }

    if (Object.keys(profileUpdates).length > 0) {
      profileUpdates.updated_at = new Date().toISOString();

      const { error: profileUpdateError } = await supabaseAdmin
        .from('user_profiles')
        .update(profileUpdates)
        .eq('user_id', userId);

      if (profileUpdateError) {
        return NextResponse.json({ error: 'Failed to update user profile' }, { status: 500 });
      }
    }

    // If phone changed, sign out all sessions for security
    if (phoneChanged) {
      const { error: signOutError } = await supabaseAdmin.auth.admin.signOut(userId, 'global');
      if (signOutError) {
        // Don't fail the request, just continue
      }
    }

    const { data: updatedAuthData } = await supabaseAdmin.auth.admin.getUserById(userId);
    const { data: updatedProfile } = await supabaseAdmin
      .from('user_profiles')
      .select('role, full_name, preferred_name, employee_id_internal, deleted_at')
      .eq('user_id', userId)
      .single();

    const updatedUser: AdminUser = {
      id: userId,
      phone: updatedAuthData?.user?.phone || '',
      created_at: updatedAuthData?.user?.created_at || '',
      last_sign_in_at: updatedAuthData?.user?.last_sign_in_at || undefined,
      banned_until: updatedAuthData?.user?.banned_until || undefined,
      role: updatedProfile?.role || 'employee',
      full_name: updatedProfile?.full_name || undefined,
      preferred_name: updatedProfile?.preferred_name || undefined,
      employee_id_internal: updatedProfile?.employee_id_internal || undefined,
      deleted_at: updatedProfile?.deleted_at || null,
    };

    return NextResponse.json({
      user: updatedUser,
      phoneChanged, // Let client know if re-auth is needed
    });

  } catch (error) {
    console.error('PATCH /api/admin/users/[id]: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const { id: userId } = await params;
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

  if (userId === session.user.id) {
    return NextResponse.json({ error: 'Cannot ban yourself' }, { status: 400 });
  }

  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);

    if (authError || !authData.user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const { error: banError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      ban_duration: '876000h', // ~100 years
    });

    if (banError) {
      return NextResponse.json({ error: 'Failed to ban user' }, { status: 500 });
    }

    const { error: profileUpdateError } = await supabaseAdmin
      .from('user_profiles')
      .update({
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    if (profileUpdateError) {
      // Don't fail - the ban was successful
    }

    const { error: signOutError } = await supabaseAdmin.auth.admin.signOut(userId, 'global');
    if (signOutError) {
      // Don't fail - the ban was successful
    }

    return NextResponse.json({ success: true, message: 'User has been banned' });

  } catch (error) {
    console.error('DELETE /api/admin/users/[id]: Unhandled error:', error);
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
