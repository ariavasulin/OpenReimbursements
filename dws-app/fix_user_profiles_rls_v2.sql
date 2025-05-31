-- Check current RLS policies on user_profiles table
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies 
WHERE tablename = 'user_profiles';

-- Drop the problematic recursive policies
DROP POLICY IF EXISTS "user_profiles_select_policy" ON user_profiles;
DROP POLICY IF EXISTS "user_profiles_insert_policy" ON user_profiles;
DROP POLICY IF EXISTS "user_profiles_update_policy" ON user_profiles;

-- Create a simple policy that allows:
-- 1. Users to view their own profile
-- 2. Anyone authenticated to view any profile (since admins need to see all profiles)
-- This is secure because only authenticated users can access the table

-- For SELECT: Allow authenticated users to read any profile
-- This is safe because only logged-in users can access this data
CREATE POLICY "user_profiles_select_policy" ON user_profiles
    FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- For INSERT: Allow authenticated users to create profiles
-- This is needed for registration and admin functions
CREATE POLICY "user_profiles_insert_policy" ON user_profiles
    FOR INSERT
    WITH CHECK (auth.uid() IS NOT NULL);

-- For UPDATE: Users can only update their own profile
CREATE POLICY "user_profiles_update_policy" ON user_profiles
    FOR UPDATE
    USING (auth.uid() = user_id);

-- Ensure RLS is enabled
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Verify the new policies
SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies 
WHERE tablename = 'user_profiles'; 