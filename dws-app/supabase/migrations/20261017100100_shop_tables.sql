-- Mirror tables for the five office tables in shop-bridge/mirror.config.json.
-- Generated from the SQL Server catalog (INFORMATION_SCHEMA.COLUMNS and the primary
-- key constraints of the dwsTables metadata export) and reviewed by hand against
-- plans/active/shop-db-bridge/sources/research-shop-db.md § 2–3.
--
-- Names keep SQL Server's casing, so they are quoted. Columns are in source order;
-- NOT NULL and the primary key follow the source. Types map:
--   int/smallint/tinyint -> integer, bigint -> bigint, bit -> boolean,
--   varchar/nvarchar/char/nchar/text/ntext -> text,
--   smalldatetime/datetime/datetime2/date -> timestamp,
--   money/smallmoney/decimal/numeric -> numeric, float/real -> double precision,
--   anything else -> text.
-- The mirror replaces each table whole every run, so there are no defaults.
--
-- shop_mirror may read, insert, and delete (the replace); service_role gets
-- everything; anon and authenticated get nothing.

create table if not exists shop."tblProject" (
  "ProjectID" integer not null,
  "Project" text,
  "DateAdded" timestamp,
  "Location" integer,
  "SpecificLocation" text,
  "PM" integer,
  "PONo" text,
  "CustProjNo" text,
  "Client" integer,
  "ClientContact" integer,
  "BillingContact" integer,
  "EstToJobsite" timestamp,
  "EstReadyForProd" timestamp,
  "MoveIn" timestamp,
  "Description" text,
  "PrelimLien" text,
  "InsuranceCert" text,
  "FixtureCost" numeric,
  "NonFixtureCost" numeric,
  "TotalHrs" integer,
  "Certified" text,
  "Architect" integer,
  "Contractor" integer,
  "billprocyes" integer,
  "Completed" timestamp,
  "LienDate" timestamp,
  "CertDate" timestamp,
  "BillNotes" text,
  "FSC" text,
  "Estimator" integer,
  "TM" text,
  "TotProjCost" numeric,
  "TenantName" text,
  "ConstLenderName" text,
  "ConstLenderAddress" text,
  "ConstLenderCSZ" text,
  "EstProjectStart" timestamp,
  "RetentionPct" numeric,
  "NoRetention" text,
  "NoSheet" text,
  "InvDiscrepOK" text,
  "Archived" boolean,
  "EngEnd" timestamp,
  "ProdEnd" timestamp,
  "TMEstProjCost" numeric,
  "PM2" integer,
  "PM3" integer,
  "JC" numeric,
  "WarrantyDt" timestamp,
  "SpecLocationNotes" text,
  "Foreman" integer,
  "LastBill" timestamp,
  "MATS" text,
  "MATSPct" numeric,
  "MATSAmt" numeric,
  "BillRateType" integer,
  "OtherInfo" text,
  "InstallerYes" text,
  primary key ("ProjectID")
);
revoke all on table shop."tblProject" from public, anon, authenticated;
grant select, insert, delete on table shop."tblProject" to shop_mirror;
grant all on table shop."tblProject" to service_role;

create table if not exists shop."tblLocation" (
  "LocationID" integer not null,
  "LocationAddress" text,
  "LocationCity" text,
  "LocationState" text,
  "LocationZip" text,
  "LocationNotes" text,
  "LocationContact" text,
  "LocationPhone" text,
  "LocationAddr2" text,
  "LocationName" text,
  "BldgOwnerName" text,
  "BldgOwnerAddress" text,
  "BldgOwnerCSZ" text,
  "Keep" boolean,
  "NoPs" integer,
  "BldgColor" text,
  primary key ("LocationID")
);
revoke all on table shop."tblLocation" from public, anon, authenticated;
grant select, insert, delete on table shop."tblLocation" to shop_mirror;
grant all on table shop."tblLocation" to service_role;

create table if not exists shop."tblMas90JobMasterOpen" (
  "JobNo" integer not null,
  "JobStatus" text,
  primary key ("JobNo")
);
revoke all on table shop."tblMas90JobMasterOpen" from public, anon, authenticated;
grant select, insert, delete on table shop."tblMas90JobMasterOpen" to shop_mirror;
grant all on table shop."tblMas90JobMasterOpen" to service_role;

create table if not exists shop."tblContact" (
  "ContactID" integer not null,
  "FirstName" text,
  "LastName" text,
  "Role" text,
  "Mobile" text,
  "OfficePhone" text,
  "CompanyID" integer,
  "ContactNotes" text,
  "Initials" text,
  "PrimaryPhn" text,
  "email" text,
  "CurrentEmp" text,
  "PM" text,
  "Drt" text,
  "Msr" text,
  "Stk" text,
  "Pgm" text,
  "Mill" text,
  "Ven" text,
  "Mac" text,
  "Ben" text,
  "Fin" text,
  "Fld" text,
  "DateAdded" timestamp,
  "Pswd" text,
  "SysAdmin" text,
  "BirthYr" integer,
  "BirthMonth" integer,
  "BirthDay" integer,
  "EmplDate" timestamp,
  "ContDateMod" timestamp,
  "HomePhone" text,
  "ContPersonMod" text,
  "MailState" text,
  "MailZip" text,
  "MailAddress" text,
  "MailCity" text,
  "Nickname" text,
  "EmplCode" text,
  "DefaultDept" integer,
  "Paycycle" text,
  "SecondCheckOT" text,
  "Finance" text,
  "Fore" text,
  "Ext" text,
  "EOT" text,
  "HireDate" timestamp,
  "VacaExempt" text,
  "WorkstationNo" text,
  "dbTermDate" timestamp,
  "email2" text,
  "FldFore" text,
  "Apprentice" text,
  "HR" text,
  primary key ("ContactID")
);
revoke all on table shop."tblContact" from public, anon, authenticated;
grant select, insert, delete on table shop."tblContact" to shop_mirror;
grant all on table shop."tblContact" to service_role;

create table if not exists shop."tblHardware" (
  "HardwareID" integer not null,
  "HardwareType" text,
  "NetworkName" text,
  "HardwareDesc" text,
  "SerialNo" text,
  "Workstation" text,
  "UserID" integer,
  "AcquireDate" timestamp,
  "Make" text,
  "Model" text,
  "Vers" text,
  "RetireDate" timestamp,
  "PhoneNumber" text,
  "IMEI" text,
  "iCloudID" text,
  "HardComments" text,
  primary key ("HardwareID")
);
revoke all on table shop."tblHardware" from public, anon, authenticated;
grant select, insert, delete on table shop."tblHardware" to shop_mirror;
grant all on table shop."tblHardware" to service_role;

