-- Create user_profiles for users who have submitted receipts but don't have profiles
INSERT INTO user_profiles (user_id, full_name, role)
SELECT DISTINCT 
    r.user_id,
    'User ' || SUBSTRING(r.user_id, 1, 8) as full_name,  -- Temporary name based on user_id
    'employee' as role
FROM receipts r
LEFT JOIN user_profiles up ON r.user_id = up.user_id
WHERE up.user_id IS NULL  -- Only insert if profile doesn't exist
AND r.user_id IS NOT NULL; 