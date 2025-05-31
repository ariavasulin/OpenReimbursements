-- Check current RLS policies on user_profiles table
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies 
WHERE tablename = 'user_profiles';

-- Check if RLS is enabled on user_profiles
SELECT schemaname, tablename, rowsecurity
FROM pg_tables 
WHERE tablename = 'user_profiles';

-- Drop existing policies that might be too restrictive
DROP POLICY IF EXISTS "Users can view own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON user_profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON user_profiles;

-- Create new policies that allow:
-- 1. Users to view their own profile
-- 2. Admins to view all profiles
-- 3. System to insert profiles during registration

-- Policy for SELECT: Users can view their own profile OR if they are admin, they can view all
CREATE POLICY "user_profiles_select_policy" ON user_profiles
    FOR SELECT
    USING (
        auth.uid() = user_id 
        OR 
        EXISTS (
            SELECT 1 FROM user_profiles admin_check 
            WHERE admin_check.user_id = auth.uid() 
            AND admin_check.role = 'admin'
        )
    );

-- Policy for INSERT: Allow system/triggers to create profiles
CREATE POLICY "user_profiles_insert_policy" ON user_profiles
    FOR INSERT
    WITH CHECK (true);  -- Allow system to create profiles during registration

-- Policy for UPDATE: Users can update their own profile, admins can update any profile
CREATE POLICY "user_profiles_update_policy" ON user_profiles
    FOR UPDATE
    USING (
        auth.uid() = user_id 
        OR 
        EXISTS (
            SELECT 1 FROM user_profiles admin_check 
            WHERE admin_check.user_id = auth.uid() 
            AND admin_check.role = 'admin'
        )
    );

-- Ensure RLS is enabled
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Verify the new policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies 
WHERE tablename = 'user_profiles'; 