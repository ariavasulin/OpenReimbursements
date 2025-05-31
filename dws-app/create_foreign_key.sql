-- Create foreign key relationship between receipts and user_profiles
ALTER TABLE receipts 
ADD CONSTRAINT receipts_user_id_fkey 
FOREIGN KEY (user_id) 
REFERENCES user_profiles(user_id); 