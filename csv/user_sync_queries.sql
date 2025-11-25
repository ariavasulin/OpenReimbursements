-- ============================================================================
-- USER SYNC SCRIPT - Design Workshops Employee Database
-- ============================================================================
-- Generated: 2025-11-04
-- Source: Employee_Phone_List_(Design_Workshops).csv
--
-- IMPORTANT: Review this entire script before running!
-- This script will:
--   1. Update incomplete accounts with employee data
--   2. Merge duplicate work/mobile accounts (keep work phones)
--   3. Create new accounts for missing employees
-- ============================================================================

-- ============================================================================
-- SECTION 1: UPDATE INCOMPLETE ACCOUNTS WITH EXISTING DATA
-- ============================================================================
-- These accounts exist but are missing employee_id_internal and/or names

-- 1.1: Bass, Michael - Add missing employee_id_internal
UPDATE user_profiles
SET 
  employee_id_internal = '10-0006648',
  updated_at = NOW()
WHERE user_id = (
  SELECT id FROM auth.users WHERE phone = '15103260226'
);

-- 1.2: Soriano, Jonathan - Add missing employee_id_internal
UPDATE user_profiles
SET 
  employee_id_internal = '30-0092561',
  updated_at = NOW()
WHERE user_id = (
  SELECT id FROM auth.users WHERE phone = '15103756890'
);

-- 1.3: Ramirez Hernandez, Apolinar - Add complete profile
INSERT INTO user_profiles (user_id, role, full_name, employee_id_internal, preferred_name, created_at, updated_at)
SELECT 
  id,
  'employee',
  'Ramirez Hernandez, Apolinar',
  '50-0070608',
  'Apolinar',
  NOW(),
  NOW()
FROM auth.users 
WHERE phone = '15102534381'
ON CONFLICT (user_id) DO UPDATE
SET 
  full_name = EXCLUDED.full_name,
  employee_id_internal = EXCLUDED.employee_id_internal,
  preferred_name = EXCLUDED.preferred_name,
  updated_at = NOW();

-- 1.4: Andrade, Ricardo - Add complete profile
INSERT INTO user_profiles (user_id, role, full_name, employee_id_internal, preferred_name, created_at, updated_at)
SELECT 
  id,
  'employee',
  'Andrade, Ricardo',
  '50-0005342',
  'Ricardo',
  NOW(),
  NOW()
FROM auth.users 
WHERE phone = '15106858514'
ON CONFLICT (user_id) DO UPDATE
SET 
  full_name = EXCLUDED.full_name,
  employee_id_internal = EXCLUDED.employee_id_internal,
  preferred_name = EXCLUDED.preferred_name,
  updated_at = NOW();

-- 1.5: Rothman, Roary - Add complete profile
INSERT INTO user_profiles (user_id, role, full_name, employee_id_internal, preferred_name, created_at, updated_at)
SELECT 
  id,
  'employee',
  'Rothman, Roary',
  '50-0078117',
  'Roary',
  NOW(),
  NOW()
FROM auth.users 
WHERE phone = '14156666211'
ON CONFLICT (user_id) DO UPDATE
SET 
  full_name = EXCLUDED.full_name,
  employee_id_internal = EXCLUDED.employee_id_internal,
  preferred_name = EXCLUDED.preferred_name,
  updated_at = NOW();


-- ============================================================================
-- SECTION 2: MERGE DUPLICATE ACCOUNTS (Work Phone + Mobile Phone)
-- ============================================================================
-- Strategy: Keep WORK phone accounts (they have receipts), delete MOBILE accounts
-- Work accounts have receipts but incomplete profiles
-- Mobile accounts have complete profiles but no receipts

-- 2.1: Martin Jimenez - Update work phone account with profile data
INSERT INTO user_profiles (user_id, role, full_name, employee_id_internal, preferred_name, created_at, updated_at)
SELECT 
  id,
  'employee',
  'Jimenez, Martin',
  '50-0055091',
  'Martin',
  NOW(),
  NOW()
FROM auth.users 
WHERE phone = '14157164124'
ON CONFLICT (user_id) DO UPDATE
SET 
  full_name = EXCLUDED.full_name,
  employee_id_internal = EXCLUDED.employee_id_internal,
  preferred_name = EXCLUDED.preferred_name,
  updated_at = NOW();

-- 2.2: Ethan Johnson - Update work phone account with profile data
INSERT INTO user_profiles (user_id, role, full_name, employee_id_internal, preferred_name, created_at, updated_at)
SELECT 
  id,
  'employee',
  'Johnson, Ethan',
  '50-0055318',
  'Ethan',
  NOW(),
  NOW()
FROM auth.users 
WHERE phone = '15104143390'
ON CONFLICT (user_id) DO UPDATE
SET 
  full_name = EXCLUDED.full_name,
  employee_id_internal = EXCLUDED.employee_id_internal,
  preferred_name = EXCLUDED.preferred_name,
  updated_at = NOW();

-- 2.3: Luke Villasenor - Update work phone account with profile data
INSERT INTO user_profiles (user_id, role, full_name, employee_id_internal, preferred_name, created_at, updated_at)
SELECT 
  id,
  'employee',
  'Villasenor, Luke',
  '50-0095848',
  'Luke',
  NOW(),
  NOW()
FROM auth.users 
WHERE phone = '15108467616'
ON CONFLICT (user_id) DO UPDATE
SET 
  full_name = EXCLUDED.full_name,
  employee_id_internal = EXCLUDED.employee_id_internal,
  preferred_name = EXCLUDED.preferred_name,
  updated_at = NOW();

-- 2.4: DELETE the old mobile phone accounts (no receipts, no longer needed)
-- Delete profiles first (foreign key constraint)
DELETE FROM user_profiles
WHERE user_id IN (
  SELECT id FROM auth.users WHERE phone IN (
    '15104276390',  -- Martin Jimenez (mobile)
    '19258122025',  -- Ethan Johnson (mobile)
    '14154978313'   -- Luke Villasenor (mobile)
  )
);

-- Delete the auth users
DELETE FROM auth.users
WHERE phone IN (
  '15104276390',  -- Martin Jimenez (mobile)
  '19258122025',  -- Ethan Johnson (mobile)
  '14154978313'   -- Luke Villasenor (mobile)
);


-- ============================================================================
-- SECTION 3: CREATE NEW ACCOUNTS FOR MISSING EMPLOYEES
-- ============================================================================
-- These employees are in the CSV but don't have accounts yet

-- 3.1: ByBonnie, Test (Test account with phone numbers)
-- NOTE: Trigger auto-creates profile, so we just insert user then update profile
DO $$
DECLARE
  new_user_id uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM auth.users WHERE phone = '14155551212') THEN
    INSERT INTO auth.users (
      id, phone, phone_confirmed_at, role, aud,
      created_at, updated_at, is_sso_user, is_anonymous
    ) VALUES (
      gen_random_uuid(),
      '14155551212',  -- Work phone
      NOW(), 'authenticated', 'authenticated',
      NOW(), NOW(), false, false
    ) RETURNING id INTO new_user_id;
    
    -- Update the auto-created profile
    UPDATE user_profiles
    SET 
      full_name = 'ByBonnie, Test',
      employee_id_internal = NULL,
      preferred_name = 'Test',
      updated_at = NOW()
    WHERE user_id = new_user_id;
    
    RAISE NOTICE 'Created account for ByBonnie, Test with phone: 14155551212';
  END IF;
END $$;

-- 3.2: Doyle, Bonnie (No phone numbers)
-- SKIPPING: No phone number available in CSV

-- 3.3: Runcorn, Scott (No phone numbers)
-- SKIPPING: No phone number available in CSV

-- 3.4: Segura, Roberto (No phone numbers)
-- SKIPPING: No phone number available in CSV

-- 3.2: Beal, James (Has mobile phone)
DO $$
DECLARE
  new_user_id uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM auth.users WHERE phone = '17077123107') THEN
    INSERT INTO auth.users (
      id, phone, phone_confirmed_at, role, aud,
      created_at, updated_at, is_sso_user, is_anonymous
    ) VALUES (
      gen_random_uuid(),
      '17077123107',  -- Mobile phone
      NOW(), 'authenticated', 'authenticated',
      NOW(), NOW(), false, false
    ) RETURNING id INTO new_user_id;
    
    -- Update the auto-created profile
    UPDATE user_profiles
    SET 
      full_name = 'Beal, James',
      employee_id_internal = '50-0006382',
      preferred_name = 'James',
      updated_at = NOW()
    WHERE user_id = new_user_id;
    
    RAISE NOTICE 'Created account for Beal, James with phone: 17077123107';
  END IF;
END $$;

-- 3.3: Venne, Ralf
DO $$
DECLARE
  new_user_id uuid;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM auth.users WHERE phone = '14152463172') THEN
    INSERT INTO auth.users (
      id, phone, phone_confirmed_at, role, aud,
      created_at, updated_at, is_sso_user, is_anonymous
    ) VALUES (
      gen_random_uuid(),
      '14152463172',  -- Mobile phone
      NOW(), 'authenticated', 'authenticated',
      NOW(), NOW(), false, false
    ) RETURNING id INTO new_user_id;
    
    -- Update the auto-created profile
    UPDATE user_profiles
    SET 
      full_name = 'Venne, Ralf',
      employee_id_internal = '50-0095667',
      preferred_name = 'Ralf',
      updated_at = NOW()
    WHERE user_id = new_user_id;
    
    RAISE NOTICE 'Created account for Venne, Ralf with phone: 14152463172';
  END IF;
END $$;

-- SKIPPING: Lumbre, Anthony (per user request)


-- ============================================================================
-- SECTION 4: VERIFICATION QUERIES
-- ============================================================================
-- Run these after executing the above to verify everything worked

-- 4.1: Check all accounts are now complete or properly categorized
SELECT 
  CASE 
    WHEN p.user_id IS NULL THEN 'NO_PROFILE'
    WHEN p.full_name IS NULL OR p.preferred_name IS NULL THEN 'INCOMPLETE'
    ELSE 'COMPLETE'
  END as status,
  COUNT(*) as count
FROM auth.users u
LEFT JOIN user_profiles p ON u.id = p.user_id
WHERE u.deleted_at IS NULL
GROUP BY status
ORDER BY status;

-- 4.2: Show all incomplete accounts (should be minimal now)
SELECT 
  u.phone,
  p.full_name,
  p.preferred_name,
  p.employee_id_internal,
  'INCOMPLETE' as status
FROM auth.users u
LEFT JOIN user_profiles p ON u.id = p.user_id
WHERE u.deleted_at IS NULL
  AND (p.user_id IS NULL OR p.full_name IS NULL OR p.preferred_name IS NULL)
ORDER BY u.phone;

-- 4.3: Verify the merged accounts (work phones should now have profiles)
SELECT 
  u.phone,
  p.full_name,
  p.employee_id_internal,
  p.preferred_name,
  COUNT(r.id) as receipt_count
FROM auth.users u
LEFT JOIN user_profiles p ON u.id = p.user_id
LEFT JOIN receipts r ON u.id = r.user_id
WHERE u.phone IN (
  '14157164124',  -- Martin work
  '15104143390',  -- Ethan work
  '15108467616'   -- Luke work
)
GROUP BY u.phone, p.full_name, p.employee_id_internal, p.preferred_name
ORDER BY u.phone;

-- 4.4: Verify deleted accounts are gone
SELECT phone, 'SHOULD NOT EXIST' as status
FROM auth.users
WHERE phone IN (
  '15104276390',  -- Martin mobile (should be deleted)
  '19258122025',  -- Ethan mobile (should be deleted)
  '14154978313'   -- Luke mobile (should be deleted)
);

-- 4.5: Show newly created accounts
SELECT 
  u.phone,
  p.full_name,
  p.employee_id_internal,
  u.created_at
FROM auth.users u
LEFT JOIN user_profiles p ON u.id = p.user_id
WHERE u.phone IN (
  '14155551212',  -- ByBonnie, Test
  '17077123107',  -- Beal, James
  '14152463172'   -- Venne, Ralf
)
ORDER BY u.phone;

-- ============================================================================
-- END OF SCRIPT
-- ============================================================================
-- Summary of changes:
-- - Updated 2 accounts with missing employee IDs
-- - Updated 3 accounts with missing profiles
-- - Merged 3 duplicate accounts (kept work phones, deleted mobiles)
-- - Created 3 new employee accounts
-- - Left test accounts (1234567, 7654321) untouched
-- - Left unknown phone numbers untouched
-- ============================================================================

