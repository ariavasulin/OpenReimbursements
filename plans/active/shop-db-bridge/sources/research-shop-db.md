# DWS shop database: schema and hosting context (employees, phones, projects/jobs, connectivity)

Source checkout: `/Users/ariavasulin/Desktop/dwsTables` (all paths below are relative to it unless absolute).
Research was read-only. No personal values (names, phone numbers, emails, passwords) appear in this report. Phone and email formats are shown as masked shapes (`9` = digit, `a` = letter).

Note on paths: `CLAUDE.md`/`AGENTS.md` refer to `metadata/sql_server/` and `docs/`. In this checkout the SQL Server metadata lives under `archive/metadata/sql_server/`, the Access metadata under `archive/metadata/access/` (plus a copy of `queries.csv` at `metadata/access/queries.csv`), and the docs under `catalog/docs/`.

---

## 1. How the database is hosted and reached

### What the repo docs say
- `CLAUDE.md:26-28` and `AGENTS.md:26-28`: "SQL Server: `SQL2016\SQLEXPRESS`, database `DWSRestore` (Windows machine)"; "Access DB: `DWSJA.accdb` (123 MB, in repo root, not committed)"; "Analysis runs on Mac".
- `catalog/docs/architecture.md:5`: "Metadata is extracted on **Windows** (SQL Server) and **Mac** (Access), then analyzed and cataloged on Mac."
- `catalog/docs/architecture.md:60-61`: the SQL Server side was extracted with `scripts/extract_metadata.ps1` using `Invoke-Sqlcmd`; the Access side with `mdbtools`.
- `CLAUDE.md:72` / `AGENTS.md:32`: "No foreign keys exist anywhere."
- `CLAUDE.md:68`: "MAS90/JC3 linked tables do not exist in the export."

### The extraction script (the only code that ran against the real SQL Server)
- `scripts/extract_metadata.ps1:7-8`: `$serverName = "SQL2016\SQLEXPRESS"`, `$databaseName = "DWSRestore"`.
- `scripts/extract_metadata.ps1:191-193`: `Invoke-Sqlcmd -ServerInstance $serverName -Database $databaseName ... -TrustServerCertificate`. No username/password is passed, so it uses the Windows login of whoever ran it.
- It pulls 9 metadata sets (columns, FKs, indexes, constraints, views, routines, row counts, table sizes, extended properties) at `scripts/extract_metadata.ps1:19-178`. It does not query `@@VERSION`, collation, `sys.identity_columns`, or `sys.triggers`.
- The instance host name is `SQL2016`; no file in the repo records the actual SQL Server version/edition string beyond the instance name `SQLEXPRESS` (Express edition) and the host name.

### How the Access front end connects (from the Access system table dump)
Source: `archive/metadata/access/msysobjects.csv` (latin-1 encoded; `catalog/docs/schema-guide.md:20`). Object counts by type: 124 ODBC linked tables (type 4), 8 linked-Access tables (type 6), 1,055 queries (type 5).

- **123 of 124 ODBC linked tables** share one DSN-less connect string:
  `Description=sql 2016 dsn;DRIVER=SQL Server;SERVER=SQL2016\SQLEXPRESS;Trusted_Connection=Yes;APP=Microsoft Office 2016;DATABASE=DWS`
  - Driver: legacy `SQL Server` ODBC driver. Auth: Windows integrated (`Trusted_Connection=Yes`), no stored credentials.
  - The live database name is **`DWS`**. `DWSRestore` (the name in CLAUDE.md and the extraction script) is a separately named restored copy that the metadata and CSVs came from.
  - Local names use a `dbo_` prefix and bind via `ForeignName` (e.g. `dbo_tblProject` -> `dbo.tblProject`, `dbo_tblContact` -> `dbo.tblContact`, `dbo_tblMas90JobMasterOpen` -> `dbo.tblMas90JobMasterOpen`).
  - Link metadata dates: `dbo_tblProject` link last updated 02/01/26; `dbo_tblContact` 01/15/25; `dbo_tblMas90JobMasterOpen` and `dbo_tblPM` 12/21/17.
- **1 ODBC linked table goes to Sage MAS 90**: `MAS90EmpSaveAsDirectConnectExample` -> `PR1_EmployeeMaster`, connect string `DSN=Silent_MAS90_32;Description=MAS 90 4.0 ODBC Driver;Directory=\\SQL2016\Sage\MAS90;...;Company=DWS;PWD=<REDACTED>;...`. So Sage MAS 90 data files live on a share on the same `SQL2016` host (`\\SQL2016\Sage\MAS90`). The string carries a plaintext password in `msysobjects.csv`. It is also copied verbatim into `.humanlayer/tasks/sqlserver-to-postgres-migration/02-research-postgres-migration.md:134`.
- **8 linked-Access tables** (`tblDocuments`, `tblDWSImages`, `tblEmail`, `tblEmailSend`, `tblFeatureImg`, `tblLocationDrawing`, `tblMatlDrawing`, `tblSignature`) point at a second Access file on a file share: `\\SQL2016\MainData\DWS PMdb\AccessDBs.accdb` (6 links) or `J:\DWS PMdb\AccessDBs.accdb` (2 links, a mapped drive letter).
- 59 Access-local (not on SQL Server) tables are listed in `archive/metadata/access/tables.txt:1-59`. Examples: `BambooEmployees`, `tmpMas90Employee`, `tmpMas90TransDetail`, `Timesheet Entries`, `BkpContact`, `BkpProject`.
- `archive/metadata/access/relationships.csv` is empty (no Access-side declared relationships either).
- A table owned by schema `DWS\<user>` (`tblSheetHist`) appears at `archive/metadata/sql_server/columns.csv:1068`. This is a Windows-domain-style login (`DWS\...`) owning a schema.

### SQL Server linked servers to Sage (inside the database)
From `archive/metadata/sql_server/views.csv` (113 views; definitions are cut off at about 4,000 characters because they come from `INFORMATION_SCHEMA.VIEWS`):
- 39 views use `OPENQUERY(...)` against SQL Server linked servers named `MAS902016`, `MAS902017`, `MAS902017NEW`, `MAS902020`. The Sage tables they read include `JC_Job`, `JC1_JobMaster`, `JC_JobTransactionDetail`, `JC3_TransactionDetail`, `AP_InvoiceHistoryDetail`/`Header`, `PR_Employee`, `PR1_EmployeeMaster`, `PR_Department`, `JC_CostCode`.
- Example: `vewMas90JobMasterOpen2023` = `SELECT JobStatus, CONVERT(numeric, LEFT(JobNo, 4)) AS JobNo FROM OPENQUERY(MAS902020, 'SELECT * FROM JC_Job') WHERE JobStatus='o' AND JobNo > '1999' AND NOT (JobNo LIKE '%[N,S,V,T]%')`. `vewMas90JobMasterOpen` is the same, using `MAS902017NEW`. `vewMas90JobMasterOpenOld` (defined as `vewMas90JobMasterOpen20`) uses `JC1_JobMaster`/`JobNumber` on `MAS902017`.
- `archive/metadata/sql_server/stored_procs.csv`, `foreign_keys.csv`, and `column_extended.csv` are empty: no procedures, functions, FKs, or extended properties.

### Hosting and operations notes (migration research written in this repo, 2026-06)
- `.humanlayer/tasks/sqlserver-to-postgres-migration/03-leadership-proposal-cloud-migration.md:29`: "The database lives on one server in the office. There is no automatic off-site backup or disaster recovery."
- Same file, `:30`: "The system can only be reached from inside the office."
- Same file, `:31`: SQL Server Express is described as "a free, entry-level product with built-in size and performance ceilings".
- Same file, `:32`: "the live data link to the accounting system is known to 'go to sleep' and require a server restart to recover."
- `02-research-postgres-migration.md:12`: "edition confirmed: Sage classic" (file-based ProvideX Sage 100, per `:350-357`).
- `knowledge/access_analysis/overview.md:23,42`: there are Access "backup" queries (`_bkp*`) that snapshot key tables. No database-level backup schedule, `.bak` handling, or VPN/network setup is documented anywhere in the repo.

---

## 2. Employees (and phone numbers)

### Main table: `tblContact` holds both employees and external contacts
Schema from `archive/metadata/sql_server/columns.csv:285+`. PK constraint `PK_tblContact_1` on `ContactID` (`archive/metadata/sql_server/constraints.csv:21`). Indexes: clustered unique on `ContactID`, plus `IX_tblContact` on (FirstName, LastName, Role, CompanyID, Initials). Rows: 5,066 (both `row_counts.csv` and the CSV). Columns: 54.

| Group | Columns (SQL Server type) |
|---|---|
| Key | `ContactID int NOT NULL` (values 1..9174) |
| Name | `FirstName varchar(20)`, `LastName varchar(30)`, `Nickname varchar(20)`, `Initials varchar(5)` |
| Company link | `CompanyID int` -> `tblCompany.CompanyID`. **CompanyID = 1 is DWS itself** (`tblCompany` row 1, CompanyType "Design Workshops"; `knowledge/access_analysis/labor.md:580`) |
| Phones | `Mobile varchar(20)`, `OfficePhone varchar(20)`, `HomePhone varchar(15)`, `Ext varchar(10)`, `PrimaryPhn varchar(1)` ('m'/'o' marks which phone is primary) |
| Email | `email varchar(50)`, `email2 varchar(50)` |
| Employee number | `EmplCode varchar(15)` (Sage/MAS90 employee code) |
| Employment status | `CurrentEmp varchar(2) default ((1))`, `dbTermDate smalldatetime`, `HireDate smalldatetime`, `EmplDate smalldatetime` (an evaluation date, not filled in this export) |
| Role/capability flags (varchar(2), Access booleans '-1'/'0') | `PM`, `Drt`, `Msr`, `Stk`, `Pgm`, `Mill`, `Ven`, `Mac`, `Ben`, `Fin`, `Fld`, `Finance`, `Fore`, `FldFore`, `Apprentice`, `HR`, `SysAdmin`, `EOT` |
| Other HR/payroll | `Role varchar(25)`, `DefaultDept tinyint`, `Paycycle varchar(2)` (W/B/M), `SecondCheckOT`, `VacaExempt`, `BirthYr/BirthMonth/BirthDay`, `Mail*` address fields, `WorkstationNo` |
| App login | `Pswd varchar(12)`: the Access front-end password is stored on this row (`knowledge/access_analysis/contacts_companies.md:562-575`) |
| Audit | `DateAdded smalldatetime default getdate()`, `ContDateMod smalldatetime`, `ContPersonMod varchar(5)` |

Masked profile of the export (counts only):
- `Mobile`: 2,084 non-null, mostly shape `9999999999` (2,051); a few `999-999-9999`, `(999) 999-9999`, `99999999999`.
- `OfficePhone`: 2,587 non-null, mostly `9999999999`; some junk like `a/a`. The Access query `qryContactList` treats the last 4 digits as the extension (`contacts_companies.md:159-166`).
- `HomePhone`: 250 non-null.
- `email`: 3,414 non-null.
- `EmplCode`: 293 non-null, all shape `9999999` (7 digits), 291 distinct. All 293 have CompanyID = 1.
- `CurrentEmp`: '1' = 4,751, '0' = 248, '-1' = 67. The '1' value is the column default and sits mostly on external contacts (4,740 non-DWS rows). Among CompanyID = 1 rows (321): '0' = 243, '-1' = 67, '1' = 11.
- `dbTermDate`: 241 non-null (2009-01-01..2024-01-19). `HireDate`: 291 non-null.

How the Access app defines "current employee" (from documented queries):
- `qryContactInternalCurrent` (`knowledge/access_analysis/contacts_companies.md:393-408`): `CompanyID=1 AND dbTermDate Is Null AND EmplCode>"0" AND FirstName>"a"`, OR `CompanyID=1 AND CurrentEmp<>"0" AND Role="Contractor"`.
- `QryEmpPhoneExtensions` (`contacts_companies.md:9-34`): `dbTermDate IS NULL AND EmplCode > "0"`.
- Timesheet compliance (`knowledge/access_analysis/labor.md:579-580`): `CurrentEmp <> "0" AND CompanyID = 1`.
- So there are two termination signals: `dbTermDate` and `CurrentEmp = "0"` (`knowledge/access_analysis/engineering.md:664`).
- In this export, CompanyID=1 AND CurrentEmp<>'0' AND dbTermDate null = 48 rows (34 with a Mobile). EmplCode set AND CurrentEmp<>'0' AND dbTermDate null = 40 rows (33 with a Mobile).

Company-issued phones live in a different table:
- `tblHardware` (79 rows, PK `HardwareID`): `HardwareType varchar(30)`, `UserID int` (-> `tblContact.ContactID`), `PhoneNumber varchar(20)`, `IMEI`, `iCloudID`, `AcquireDate`, `RetireDate`, plus other columns. 23 rows are `HardwareType='Mobile Phone'`; 35 rows have a PhoneNumber (shapes `999-999-9999` x28, `9999999999` x7).
- `qryMobileNumbers` filters to mobile phones, and `QryEmpPhoneExtensions` shows it as the "DWS Cell" column, next to `tblContact.Mobile` as the personal cell (`contacts_companies.md:19,582-586`).

### Other employee-related tables (all keyed to `tblContact.ContactID`; no FKs)
| Table | Rows | PK | Columns / join key |
|---|---|---|---|
| `tmpEmployeeMas90` | 258 | `EmployeeNo nchar(20)` | DepartmentNo, EmployeeNo, LastName, FirstName, AddressLine1. A Sage snapshot. Queries refer to it as `tmpMas90Employee` (`02-research...md:173`) |
| `tblEmpPayHist` | 1,380 | `PHID` | `EmplID` -> ContactID; PayStart/PayEnd; PayRate1-3 smallmoney |
| `tblEmpHireHistory` | 52 | `EHID` | `EmpID` -> ContactID; PastHireDate/PastTermDate |
| `tblEmpWeek` | 4,797 | `EWID` | `Employee` -> ContactID; WeekID; unique index (Employee, WeekID) |
| `tblEmpApprenticeLevel` | 2 | `ALID` | `EmpID` -> ContactID |
| `tblContactRole` | 40 | none | `Role varchar(30)` lookup |
| `tblTimesheet` | 288,977 | `TimesheetID` | `Employee` -> ContactID, `Project` -> ProjectID |

Cross-system employee keys:
- `tblContact.EmplCode` = Sage `MAS90Emp.EmployeeNumber` (`knowledge/access_analysis/mas90_integration.md:17,32`).
- For BambooHR, `SageEmpNo` is **not a stored column**. `qryContactInternal` computes it as `[DefaultDept] & "-" & [EmplCode]` (`metadata/access/queries.csv:737`), and the Bamboo sync queries join on it: `BambooEmployees.employeeNumber = qryContactInternal.SageEmpNo` (`metadata/access/queries.csv:1116,2678`). `knowledge/access_analysis/labor.md:124` describes it as a column; the query text shows it is an alias.
- BambooHR to `tblContact` flow: `BambooEmployees` (an Access-local table) -> `qryInsertBambooEmp`/`qryUpdateBambooEmp` (`labor.md:123-131`). The insert query selects `mobilephone`, `workphone`, and `HomePhone` from Bamboo (`metadata/access/queries.csv:1110-1118`). The reconstructed queries are all rewritten as SELECT, so which column each value is written to is not visible (`02-research...md:141`).

---

## 3. Projects / jobs

### `tblProject` (one row per DWS job)
1,809 rows; 58 columns; PK `ProjectID int` (`archive/metadata/sql_server/constraints.csv:56`, `columns.csv:773`). Indexes: clustered PK; `IX_tblProj_Complete` (Completed, PM, ProjectID); `IX_tblProj_PM` (PM, ProjectID).
- **Job number = `ProjectID`**, a 4-digit integer (1860..3990 in the export, all 4 digits). Other external refs: `PONo varchar(25)`, `CustProjNo varchar(30)`.
- People keys (all int -> `tblContact.ContactID`): `PM`, `PM2`, `PM3`, `Estimator`, `Foreman`, `ClientContact`, `BillingContact`. `PM` resolves to a tblContact row for 1,757 of 1,784 non-null values.
- Company keys (-> `tblCompany.CompanyID`): `Client`, `Architect`, `Contractor`.
- `Location smallint` -> `tblLocation.LocationID` (668 rows).
- Dates: `DateAdded` (default getdate; 2009-09-24..2023-12-12), `EstProjectStart`, `EstToJobsite`, `EstReadyForProd`, `MoveIn`, `EngEnd`, `ProdEnd`, `Completed`, `WarrantyDt`, `LastBill`, `LienDate`, `CertDate`.
- Money/flags: `TotProjCost`, `TMEstProjCost`, `FixtureCost`, `JC`, `TM` (T&M flag, varchar), `Archived bit default 0`, `NoSheet`, `RetentionPct`.

**What "open/active" means on the DWS side:** `Completed` is a date, and NULL means not closed out (`knowledge/access_analysis/projects.md:91,137`). `Archived` is a later housekeeping flag for projects completed more than 180 days ago (`projects.md:149-156`). In the export: Completed NULL = 30 rows (26 of them added 2022 or later); Archived True = 1,693, False = 116. 24 saved Access queries filter `Completed) Is Null` (`metadata/access/queries.csv`).

### `tblMas90JobMasterOpen` (Sage's open-job list, copied in)
35 rows; 2 columns: `JobNo int NOT NULL` (PK, `constraints.csv:45`), `JobStatus varchar(5)`. All 35 rows have JobStatus = 'O'. JobNo ranges 3612..9999, all 4 digits.
- How it is filled: the Access pass-through `qryMas90JobMasterOpen` (`SELECT *` against Sage, `metadata/access/queries.csv:1328`) feeds the anti-join `qryUpdateMas90JobMasterOpen2`, which finds Sage jobs not yet in the table (`queries.csv:2799-2802`; `mas90_integration.md:418-423,562-567`). The server-side views `vewMas90JobMasterOpen*` derive JobNo as `LEFT(JobNo,4)` of the Sage job number, excluding job numbers containing N/S/V/T (see section 1).
- **How it relates to `tblProject`:** `JobNo` is meant to equal `tblProject.ProjectID`. The first 4 characters of the Sage job number are the DWS ProjectID (`mas90_integration.md:243`). In the export, 23 of 35 JobNos match a ProjectID, and all 23 have `Completed` NULL. Those 23 are 23 of the 30 open DWS projects. The 12 that do not match are 3992-3999, 6028-6030, and 9999.
- It is used in `vewProjectCost` (and the Access pass-through `qryProjectCostPASS`) to derive `M90Status` ('O' -> 'Open', else 'Closed') (`knowledge/access_analysis/billing.md:1693-1705`). The join clause itself is past the roughly 4,000-character cutoff of the captured view text, so the exact ON condition cannot be seen.

### Related tables
| Table | Rows | Key | Notes |
|---|---|---|---|
| `tblProjContact` | 4,335 | No PK constraint. Unique nonclustered index `PK_tblProjContact` on `ProjContactID`; clustered non-unique index on `ProjectID` | ProjectID, ContactID, CompanyID, `ProjRole varchar(30)` (e.g. Client/End User 1,136, General Contractor 933, Architect/Designer 576, 'please fill in' 351, blank 1,138), `ContactRole varchar(50)`, `ContPM varchar(2)` ('-1' = 197) |
| `tblProjClose` | 0 | `PCID` | `pClose bit`. Empty table (`scripts/config.py:23`) |
| `tblPM` | 271 | No PK constraint; unique index `ixPKey` on `PMID` | `PMID int`, `Initials varchar(50)`. 243 PMIDs match a `tblContact.ContactID` |
| `tblStatus` | 13 | none | `SheetStatus`, `Explan`, `Phase`. These are sheet (production) statuses, not project statuses |
| `tblStatusAll` | 37 | none | `StatusID tinyint`, `StatusName`, `StatusOrder` |
| `tblProjRole` | 10 | none | `ProjRole` lookup |
| `tblLocation` | 668 | `LocationID smallint` | job-site address and contact fields (includes `LocationPhone`) |

---

## 4. Timestamps and primary keys (relevant to incremental sync)
- No `timestamp`/`rowversion` columns exist anywhere (`archive/metadata/sql_server/columns.csv`). 19 columns have a `getdate()` default.
- `tblContact`: `DateAdded` (default getdate; 5,064 non-null, max 2024-01-31), `ContDateMod` (396 non-null, 2010-02-02..2023-12-01), `ContPersonMod` (initials). No saved Access query refers to `ContDateMod` or `ContPersonMod` (grep of `metadata/access/queries.csv`), so how they get filled is not visible in the repo.
- `tblProject`: only `DateAdded`. No modified-at column.
- `tblMas90JobMasterOpen`, `tblPM`, `tblProjContact`, `tblHardware`: no timestamp columns.
- Only the `tblSheetNEW` family has `ModDate`/`ModBy`.
- PKs: `tblContact.ContactID`, `tblProject.ProjectID`, `tblMas90JobMasterOpen.JobNo`, `tblHardware.HardwareID` are declared PK constraints. `tblProjContact` and `tblPM` have unique indexes only. Whether keys are IDENTITY columns was not extracted (`02-research-postgres-migration.md:330`). In total, 88 PK constraint rows (`constraints.csv`) cover 87 tables.

---

## 5. Scripts that touched real databases, and requirements
- `scripts/extract_metadata.ps1`: PowerShell `Invoke-Sqlcmd` against `SQL2016\SQLEXPRESS` / `DWSRestore`, Windows auth (section 1). It is the only script that touched SQL Server.
- `scripts/extract_access_queries.py:20-36`: `pyodbc` with `DRIVER={Microsoft Access Driver (*.mdb, *.accdb)};DBQ=<repo>/DWSJA.accdb` (a local file, no credentials).
- `scripts/extract_access_metadata.sh:9-48`: `mdb-tables`, `mdb-schema`, `mdb-export MSysQueries/MSysObjects`, `mdb-queries` on `DWSJA.accdb`.
- `scripts/build_sqlite.py:1-15,573`: builds local SQLite from `Tables/*.csv` (`sqlite3.connect`). It does not touch a server.
- `context_compiler/` (`next_query.py`, `verify.py`, `run.sh`): no driver imports or connection strings (grep for sqlite/connect/odbc/accdb found none).
- No `pymssql`, SQLAlchemy, or SQL Server ODBC connection string exists in any Python file.
- `requirements.txt:1-7`: `pandas>=2.0`, `pyarrow`, `jupyter`, `notebook`, `matplotlib`, `seaborn`, `tqdm`. It does not list `pyodbc`, even though `extract_access_queries.py` asks for it.
- Git: the data CSVs and metadata were added in commit `a132667` (2026-03-21). The latest commit is 2026-04-06.

---

## 6. Overall size
- 128 base tables (`archive/metadata/sql_server/row_counts.csv`, 128 rows); 122 have more than 0 rows. 1,726 columns. 113 views.
- About 720,787 total rows; about 220,872 KB (~216 MB) reserved on disk (`table_sizes.csv`; its row_count column is inflated because rows are counted once per index).
- `Tables/` holds 128 CSV files, 99 MB on disk.
- Biggest tables by SQL Server space (KB / true rows): `tblTimesheet` 114,616 / 288,977; `tblSheetProcess` 14,872 / 68,790; `tblPurchasing` 12,344 / 31,416; `tblSheetNEW` 10,792 / 15,932; `tblBillHistory` 6,424 / 11,618; `tblShipTag` 5,720 / 15,314; `tmpMas90InvHistDetail` 5,576 / 60,014; `tblShipTagItems` 5,000 / 64,994.
- Biggest CSVs: `tblTimesheet.csv` 36.4 MB, `tblSheetNEW.csv` 12.7 MB, `tblPurchasing.csv` 8.1 MB, `tmpMas90InvHistDetail.csv` 5.9 MB.
- The export's data ends around **late Dec 2023 / Jan 2024**: latest `tblTimesheet.WorkDate` 2023-12-27, latest `tblContact.DateAdded` 2024-01-31, latest `tblProject.DateAdded` 2023-12-12.

---

## Established
- The production system is an Access front end (`DWSJA.accdb`) using ODBC linked tables to SQL Server Express instance `SQL2016\SQLEXPRESS`, database **`DWS`**, with Windows integrated auth and the legacy `SQL Server` ODBC driver (`archive/metadata/access/msysobjects.csv`). `DWSRestore` is the restored copy that was analyzed (`scripts/extract_metadata.ps1:7-8`).
- Sage MAS 90 data sits on the same host (`\\SQL2016\Sage\MAS90`). It is reached through a 32-bit ProvideX DSN from Access and through SQL Server linked servers `MAS9020xx` used in 39 views. A second Access back end is on `\\SQL2016\MainData\DWS PMdb\AccessDBs.accdb`.
- Repo docs say: one on-prem server, office-only access, no off-site backup (`03-leadership-proposal...md:29-31`).
- There are no FKs, procedures, or rowversion columns. Primary keys exist on the core tables.
- Employees are rows in `tblContact` with `CompanyID = 1`. Employee number is `EmplCode` (7 digits). Phones are in `Mobile`/`OfficePhone`/`HomePhone`/`Ext`; company cells are in `tblHardware.PhoneNumber` (via `UserID`). Termination is shown by `dbTermDate` and `CurrentEmp='0'`.
- Job number = `tblProject.ProjectID` (4-digit int). DWS "open" = `Completed IS NULL`. `tblMas90JobMasterOpen.JobNo` is the first 4 digits of the Sage job number with status 'O'. 23 of its 35 rows match open `tblProject` rows.
- The only timestamp columns on these tables are `DateAdded` (both), plus `ContDateMod`/`ContPersonMod` on `tblContact`.

## Unknowns
- The exact SQL Server version/build and collation. Only the host name `SQL2016` and edition `SQLEXPRESS` are recorded.
- Whether the live `DWS` schema/data has drifted from `DWSRestore`. The export data ends about Jan 2024, while the `dbo_tblProject` link was refreshed 02/01/26.
- Whether `tblContact.ContDateMod` is reliably updated on edits, and by what (no saved query sets it; maybe form/VBA code, which was not extracted).
- Whether PKs are IDENTITY columns; whether triggers exist (not extracted).
- The exact join condition between `tblProject` and `tblMas90JobMasterOpen` in `vewProjectCost` (the view text is cut off).
- Network setup (VPN, firewall, remote access, how the Mac machine reached the data), backup schedule, and how `DWSRestore` was produced: none of this is documented.
- Which `tblContact` columns BambooHR sync writes (action-query targets were lost when the queries were reconstructed as SELECTs).
- What the 12 `tblMas90JobMasterOpen` JobNos with no `tblProject` match represent (3992-3999, 6028-6030, 9999).
