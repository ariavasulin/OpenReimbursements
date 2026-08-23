


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."admin_role" AS ENUM (
    'AccountantAdmin',
    'SystemAdmin'
);


ALTER TYPE "public"."admin_role" OWNER TO "postgres";


CREATE TYPE "public"."receipt_status" AS ENUM (
    'Pending',
    'Approved',
    'Rejected'
);


ALTER TYPE "public"."receipt_status" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_admin_receipt_status_counts"("from_date" "date" DEFAULT NULL::"date", "to_date" "date" DEFAULT NULL::"date") RETURNS TABLE("status" "text", "count" bigint)
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT r.status, COUNT(*)::bigint
  FROM public.receipts r
  WHERE (from_date IS NULL OR r.receipt_date >= from_date)
    AND (to_date   IS NULL OR r.receipt_date <  to_date)
  GROUP BY r.status;
$$;


ALTER FUNCTION "public"."get_admin_receipt_status_counts"("from_date" "date", "to_date" "date") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_admin_receipts_with_phone"("status_filter" "text" DEFAULT NULL::"text", "from_date" "date" DEFAULT NULL::"date", "to_date" "date" DEFAULT NULL::"date") RETURNS TABLE("id" "uuid", "receipt_date" "date", "amount" numeric, "status" "text", "description" "text", "image_url" "text", "category_id" "uuid", "user_id" "uuid", "created_at" timestamp with time zone, "updated_at" timestamp with time zone, "category_name" "text", "full_name" "text", "preferred_name" "text", "employee_id_internal" "text", "phone" "text")
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'auth'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.id,
    r.receipt_date,
    r.amount,
    r.status,
    r.description,
    r.image_url,
    r.category_id,
    r.user_id,
    r.created_at,
    r.updated_at,
    c.name as category_name,
    up.full_name,
    up.preferred_name,
    up.employee_id_internal,
    au.phone
  FROM public.receipts r
  LEFT JOIN public.user_profiles up ON r.user_id = up.user_id
  LEFT JOIN auth.users au ON r.user_id = au.id
  LEFT JOIN public.categories c ON r.category_id = c.id
  WHERE
    (status_filter IS NULL OR status_filter = 'all' OR r.status = status_filter)
    AND (from_date IS NULL OR r.receipt_date >= from_date)
    AND (to_date IS NULL OR r.receipt_date < to_date)
  ORDER BY r.receipt_date DESC, r.created_at DESC;
END;
$$;


ALTER FUNCTION "public"."get_admin_receipts_with_phone"("status_filter" "text", "from_date" "date", "to_date" "date") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_admin_receipts_with_phone"("status_filter" "text", "from_date" "date", "to_date" "date") IS 'Admin-only function to retrieve all receipts with user profile data including phone numbers from auth.users table. Security definer allows access to auth schema.';



CREATE OR REPLACE FUNCTION "public"."get_auth_users_count"("search_query" "text" DEFAULT NULL::"text", "include_deleted" boolean DEFAULT false) RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'auth', 'public'
    AS $$
DECLARE
  total INTEGER;
BEGIN
  SELECT COUNT(*)::INTEGER INTO total
  FROM auth.users au
  LEFT JOIN public.user_profiles up ON au.id = up.user_id
  WHERE
    au.deleted_at IS NULL
    -- Exclude test account
    AND au.phone != '1234'
    AND (include_deleted OR up.deleted_at IS NULL)
    AND (
      search_query IS NULL
      OR search_query = ''
      OR LOWER(up.full_name) LIKE '%' || LOWER(search_query) || '%'
      OR LOWER(up.preferred_name) LIKE '%' || LOWER(search_query) || '%'
      OR LOWER(au.phone) LIKE '%' || LOWER(search_query) || '%'
      OR LOWER(up.employee_id_internal) LIKE '%' || LOWER(search_query) || '%'
    );

  RETURN total;
END;
$$;


ALTER FUNCTION "public"."get_auth_users_count"("search_query" "text", "include_deleted" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_auth_users_for_admin"("page_num" integer DEFAULT 1, "page_size" integer DEFAULT 50, "search_query" "text" DEFAULT NULL::"text", "include_deleted" boolean DEFAULT false) RETURNS TABLE("id" "uuid", "phone" "text", "created_at" timestamp with time zone, "last_sign_in_at" timestamp with time zone, "banned_until" timestamp with time zone, "role" "text", "full_name" "text", "preferred_name" "text", "employee_id_internal" "text", "deleted_at" timestamp with time zone)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'auth', 'public'
    AS $$
DECLARE
  offset_val INTEGER;
BEGIN
  offset_val := (page_num - 1) * page_size;

  RETURN QUERY
  SELECT
    au.id,
    au.phone,
    au.created_at,
    au.last_sign_in_at,
    au.banned_until,
    COALESCE(up.role, 'employee') AS role,
    up.full_name,
    up.preferred_name,
    up.employee_id_internal,
    up.deleted_at
  FROM auth.users au
  LEFT JOIN public.user_profiles up ON au.id = up.user_id
  WHERE
    au.deleted_at IS NULL
    -- Exclude test account
    AND au.phone != '1234'
    AND (include_deleted OR up.deleted_at IS NULL)
    AND (
      search_query IS NULL
      OR search_query = ''
      OR LOWER(up.full_name) LIKE '%' || LOWER(search_query) || '%'
      OR LOWER(up.preferred_name) LIKE '%' || LOWER(search_query) || '%'
      OR LOWER(au.phone) LIKE '%' || LOWER(search_query) || '%'
      OR LOWER(up.employee_id_internal) LIKE '%' || LOWER(search_query) || '%'
    )
  ORDER BY au.created_at DESC
  LIMIT page_size
  OFFSET offset_val;
END;
$$;


ALTER FUNCTION "public"."get_auth_users_for_admin"("page_num" integer, "page_size" integer, "search_query" "text", "include_deleted" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.user_profiles (user_id, role)
  VALUES (NEW.id, 'employee'); -- Default role is 'employee'
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.user_profiles up
    where up.user_id = auth.uid()
      and up.role = 'admin'
  );
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trigger_set_timestamp"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."trigger_set_timestamp"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."categories" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."categories" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_number" "text" NOT NULL,
    "name" "text" NOT NULL,
    "location" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "synced_at" timestamp with time zone
);


ALTER TABLE "public"."jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."photos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid" NOT NULL,
    "uploader_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "sheet_number" "text",
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "captured_at" timestamp with time zone,
    "original_path" "text" NOT NULL,
    "original_bytes" bigint,
    "mime_type" "text",
    "original_name" "text",
    "thumb_path" "text",
    "preview_path" "text",
    "duration_secs" numeric,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "photos_kind_check" CHECK (("kind" = ANY (ARRAY['image'::"text", 'video'::"text", 'file'::"text"])))
);


ALTER TABLE "public"."photos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."receipts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "category_id" "uuid",
    "amount" numeric(10,2) NOT NULL,
    "receipt_date" "date" NOT NULL,
    "description" "text",
    "status" "text" DEFAULT 'Pending'::"text",
    "image_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "receipts_status_check" CHECK (("status" = ANY (ARRAY['Pending'::"text", 'Approved'::"text", 'Rejected'::"text", 'Reimbursed'::"text"])))
);


ALTER TABLE "public"."receipts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_profiles" (
    "user_id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'employee'::"text" NOT NULL,
    "full_name" "text",
    "employee_id_internal" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "preferred_name" "text",
    "deleted_at" timestamp with time zone,
    CONSTRAINT "user_profiles_role_check" CHECK (("role" = ANY (ARRAY['employee'::"text", 'admin'::"text"])))
);


ALTER TABLE "public"."user_profiles" OWNER TO "postgres";


COMMENT ON COLUMN "public"."user_profiles"."deleted_at" IS 'Timestamp when user was banned/soft-deleted';



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."categories"
    ADD CONSTRAINT "categories_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_job_number_key" UNIQUE ("job_number");



ALTER TABLE ONLY "public"."jobs"
    ADD CONSTRAINT "jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."receipts"
    ADD CONSTRAINT "receipts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("user_id");



CREATE INDEX "idx_receipts_category_id" ON "public"."receipts" USING "btree" ("category_id");



CREATE INDEX "idx_receipts_receipt_date" ON "public"."receipts" USING "btree" ("receipt_date");



CREATE INDEX "idx_receipts_status" ON "public"."receipts" USING "btree" ("status");



CREATE INDEX "idx_receipts_status_date" ON "public"."receipts" USING "btree" ("status", "receipt_date");



CREATE INDEX "idx_receipts_user_id" ON "public"."receipts" USING "btree" ("user_id");



CREATE INDEX "photos_job_captured" ON "public"."photos" USING "btree" ("job_id", "captured_at" DESC);



CREATE INDEX "photos_sheet" ON "public"."photos" USING "btree" ("job_id", "sheet_number");



CREATE INDEX "photos_tags_gin" ON "public"."photos" USING "gin" ("tags");



ALTER TABLE ONLY "public"."receipts"
    ADD CONSTRAINT "fk_category" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id");



ALTER TABLE ONLY "public"."receipts"
    ADD CONSTRAINT "fk_user_profile" FOREIGN KEY ("user_id") REFERENCES "public"."user_profiles"("user_id");



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id");



ALTER TABLE ONLY "public"."photos"
    ADD CONSTRAINT "photos_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "public"."user_profiles"("user_id");



ALTER TABLE ONLY "public"."receipts"
    ADD CONSTRAINT "receipts_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."receipts"
    ADD CONSTRAINT "receipts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_profiles"
    ADD CONSTRAINT "user_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



-- Policies are deliberately omitted here: re-creating them from a dump reverts
-- the wrapped (select auth.uid()) forms. Source of truth:
--   00000000000003_photos_schema.sql                   (jobs_select, photos_select)
--   20260822130000_rls_scalar_subqueries.sql           (receipts, categories, user_profiles)
--   20260822130100_rls_photos_tighten_update.sql       (photos write policies)

ALTER TABLE "public"."categories" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."photos" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."receipts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_profiles" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."get_admin_receipt_status_counts"("from_date" "date", "to_date" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."get_admin_receipt_status_counts"("from_date" "date", "to_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_admin_receipt_status_counts"("from_date" "date", "to_date" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_admin_receipts_with_phone"("status_filter" "text", "from_date" "date", "to_date" "date") TO "anon";
GRANT ALL ON FUNCTION "public"."get_admin_receipts_with_phone"("status_filter" "text", "from_date" "date", "to_date" "date") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_admin_receipts_with_phone"("status_filter" "text", "from_date" "date", "to_date" "date") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_auth_users_count"("search_query" "text", "include_deleted" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."get_auth_users_count"("search_query" "text", "include_deleted" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_auth_users_count"("search_query" "text", "include_deleted" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."get_auth_users_for_admin"("page_num" integer, "page_size" integer, "search_query" "text", "include_deleted" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."get_auth_users_for_admin"("page_num" integer, "page_size" integer, "search_query" "text", "include_deleted" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_auth_users_for_admin"("page_num" integer, "page_size" integer, "search_query" "text", "include_deleted" boolean) TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."trigger_set_timestamp"() TO "anon";
GRANT ALL ON FUNCTION "public"."trigger_set_timestamp"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."trigger_set_timestamp"() TO "service_role";



GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."categories" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."categories" TO "authenticated";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."categories" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."jobs" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."jobs" TO "authenticated";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."jobs" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."photos" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."photos" TO "authenticated";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."photos" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."receipts" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."receipts" TO "authenticated";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."receipts" TO "service_role";



GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."user_profiles" TO "anon";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."user_profiles" TO "authenticated";
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE "public"."user_profiles" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO "service_role";







