import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/supabaseServerClient';
import { supabaseAdmin } from '@/lib/supabaseAdminClient';
import type { AdminUser } from '@/lib/types';

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/admin/users/[id]
 *
 * Admin-only endpoint to get a single user by ID.
 */
export async function GET(request: Request, { params }: RouteParams) {
  const { id: userId } = await params;
  const supabase = await createSupabaseServerClient();

  // Verify authentication
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
    // Fetch auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);

    if (authError || !authData.user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Fetch user profile
    const { data: userProfile, error: userProfileError } = await supabaseAdmin
      .from('user_profiles')
      .select('role, full_name, preferred_name, employee_id_internal, deleted_at')
      .eq('user_id', userId)
      .single();

    if (userProfileError && userProfileError.code !== 'PGRST116') {
      console.error('GET /api/admin/users/[id]: Profile error:', userProfileError);
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

/**
 * PATCH /api/admin/users/[id]
 *
 * Admin-only endpoint to update a user.
 *
 * Request body (all optional):
 * - phone: Phone number
 * - full_name: Full name
 * - preferred_name: Preferred name
 * - employee_id_internal: Employee ID
 * - role: 'employee' | 'admin'
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id: userId } = await params;
  const supabase = await createSupabaseServerClient();

  // Verify authentication
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
    const { phone, full_name, preferred_name, employee_id_internal, role } = body;

    // Fetch current auth user
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);

    if (authError || !authData.user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const currentPhone = authData.user.phone;
    let phoneChanged = false;

    // Update phone in auth if changed
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
        console.error('PATCH /api/admin/users/[id]: Auth update error:', updateAuthError);
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

    // Update user_profiles if any profile fields provided
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
        console.error('PATCH /api/admin/users/[id]: Profile update error:', profileUpdateError);
        return NextResponse.json({ error: 'Failed to update user profile' }, { status: 500 });
      }
    }

    // If phone changed, sign out all sessions for security
    if (phoneChanged) {
      const { error: signOutError } = await supabaseAdmin.auth.admin.signOut(userId, 'global');
      if (signOutError) {
        console.error('PATCH /api/admin/users/[id]: Sign out error:', signOutError);
        // Don't fail the request, just log the error
      }
    }

    // Fetch and return updated user
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

/**
 * DELETE /api/admin/users/[id]
 *
 * Admin-only endpoint to ban (soft delete) a user.
 * - Admins cannot ban themselves
 * - Sets banned_until to ~100 years
 * - Sets deleted_at in user_profiles
 * - Signs out all user sessions
 */
export async function DELETE(request: Request, { params }: RouteParams) {
  const { id: userId } = await params;
  const supabase = await createSupabaseServerClient();

  // Verify authentication
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

  // Verify admin role
  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('user_id', session.user.id)
    .single();

  if (profileError || !profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  // Prevent self-ban
  if (userId === session.user.id) {
    return NextResponse.json({ error: 'Cannot ban yourself' }, { status: 400 });
  }

  try {
    // Verify user exists
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.getUserById(userId);

    if (authError || !authData.user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Ban user for ~100 years (876000 hours)
    const { error: banError } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      ban_duration: '876000h',
    });

    if (banError) {
      console.error('DELETE /api/admin/users/[id]: Ban error:', banError);
      return NextResponse.json({ error: 'Failed to ban user' }, { status: 500 });
    }

    // Mark as deleted in user_profiles
    const { error: profileUpdateError } = await supabaseAdmin
      .from('user_profiles')
      .update({
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);

    if (profileUpdateError) {
      console.error('DELETE /api/admin/users/[id]: Profile update error:', profileUpdateError);
      // Don't fail - the ban was successful
    }

    // Sign out all sessions
    const { error: signOutError } = await supabaseAdmin.auth.admin.signOut(userId, 'global');
    if (signOutError) {
      console.error('DELETE /api/admin/users/[id]: Sign out error:', signOutError);
      // Don't fail - the ban was successful
    }

    return NextResponse.json({ success: true, message: 'User has been banned' });

  } catch (error) {
    console.error('DELETE /api/admin/users/[id]: Unhandled error:', error);
    const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}

/**
 * Formats a US phone number to E.164 format (+1XXXXXXXXXX)
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
