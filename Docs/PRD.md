
1. Introduction
1.1. Overview: Purpose of the application – to streamline receipt submission for employees and simplify expense management and approval for the accounting department at Design Workshops.
1.2. Goals:

Reduce manual data entry for employees and accounting.
Provide a clear and efficient approval workflow.
Centralize receipt storage and data.
Enable easy tracking and reporting of expenses.
1.3. Target Audience:

Employees of Design Workshops (submitting receipts).
Accounting department personnel at Design Workshops (managing and approving receipts, acting as system administrators).
2. User Personas
2.1. Employee (e.g., "Rick Williams")

Needs: Quick and easy way to submit receipts on the go, minimize manual input, track submission status.
2.2. Accountant/Admin (e.g., "Jennifer/Nate")

Needs: Clear overview of all submitted receipts, efficient way to review and manage them (edit, delete, change status), ability to correct errors, reliable data for reporting, manage system settings like categories, job codes, and export to Sage.
3. Product Features & User Stories
3.1. Employee Web Application (Mobile-First Responsive Design) 
3.1.1. Authentication & Profile

User Story: As an employee or accountant/admin, I want to sign in securely using a One-Time Password (OTP) sent via SMS (Twilio) so that my expense data is protected.
User Story: As an employee or accountant/admin, I want to have a simple profile (name, employee ID - potentially pre-filled) managed with supabsae.
3.1.2. Receipt Submission

User Story: As an employee, I want to take a photo of my receipt using my device camera or upload an existing image (standard image formats like JPG, PNG; PDF also supported, max 10MB) so I can submit it for reimbursement.
User Story: As an employee, I want the app to use OCR (Google Cloud Vision API) to automatically extract and pre-fill the Date, Amount, and potentially Description from the receipt image to save me time.
User Story: As an employee, I want to review and, if necessary, edit the auto-filled details (Date, Amount, Category, Description) before submitting.
User Story: As an employee, I must select an expense Category from a predefined list. If I select "Other," I must provide a Description.
User Story: As an employee, I want to see confirmation after successfully submitting a receipt.
3.1.3. Receipt Tracking

User Story: As an employee, I want to view a list of all my submitted receipts with their key details (Date, Amount, Status, link to view Photo).
User Story: As an employee, I want to see the status of my receipts (Pending, Approved, Rejected, Reimbursed).
3.1.4. Receipt Image Storage

System Requirement: Uploaded receipt images will be stored in a Supabase Storage bucket named `receipt-images`, organized by `user_id`. The application will store and display links to these images.
3.2. Accounting Dashboard (Web Application) - Accountant/Admin Role 3.2.1. Authentication & Profile
3.2.2. Receipt Management & Review (Full CRUD Capabilities)

User Story: As an accountant/admin, I want to see a dashboard overview (e.g., total receipts, pending review, approved, reimbursed counts/amounts).
User Story: As an accountant/admin, I want to view a comprehensive list of all submitted receipts from all employees.
User Story: As an accountant/admin, I want to filter receipts by status (All, Pending, Approved, Reimbursed, Rejected), employee, date range.
User Story: As an accountant/admin, I want to search for specific receipts (e.g., by employee name, description keywords).
User Story: As an accountant/admin, I want to view the details of a specific receipt, including the receipt image (linked from the Supabase `receipt-images` bucket).
User Story: As an accountant/admin, I want to be able to edit any field of a submitted receipt (Date, Amount, Category, Description, Status).
User Story: As an accountant/admin, I want to be able to delete receipts if necessary (e.g., duplicates, erroneous submissions).
User Story: As an accountant/admin, I want to Approve, Reject, or change the status of receipts (e.g., mark as Reimbursed). No mandatory reason is required for rejection.
User Story: As an accountant/admin, I want an efficient way to review multiple receipts (e.g., "Batch Receipt Review" interface).
User Story: As as accountant/admin, I want to be able to edit multiple columns at once.
3.2.3. Reporting

User Story: As an accountant/admin, I want to export receipt data (selected or all) to a CSV file.
3.2.4. System Administration (Accountant/Admin Role)

User Story: As an accountant/admin, I want to manage the predefined list of expense categories available to employees (add, edit, delete categories).
4. Technical Specifications 4.1. Frontend: React, ShadCN UI, Tailwind CSS. 4.2. Backend: Supabase. 4.3. Deployment: Vercel. 4.4. Authentication:

Employee App: Twilio (SMS OTP).
Accounting Dashboard: Microsoft OAuth.
4.5. Integrations:

Google Cloud Vision API (for OCR).
Supabase Storage (for receipt image storage, using a bucket named `receipt-images`).
(Consider email service for future admin notifications or password resets if OTP fails).
5. Data Management 5.1. Database: Supabase (PostgreSQL). Receipt metadata (date, amount, category, description, status, employee ID, path to image in Supabase Storage). 5.2. OCR Data Flow: Image upload -> Google Cloud Vision API -> Parsed data pre-fills app fields. 5.3. Image Storage: Original receipt images stored in the Supabase Storage bucket `receipt-images`, with their paths linked in the database. 5.4. Data Retention:

Receipt images in Supabase Storage (`receipt-images` bucket): Stored permanently.
Receipt metadata in Supabase DB: Retained for a minimum of 7 years (for active querying and legal compliance), with potential for archival beyond that.
6. Design & UX Considerations 6.1. Mobile-first responsive design for the employee web app. 
6.2. Clear, intuitive interfaces for both employee and accounting users (referencing provided screenshots as a style guide). 
6.3. Efficient workflows for common tasks (receipt submission, batch review). 
6.4. Clear visual indicators for receipt statuses.
7. Non-Functional Requirements 7.1. Performance:

Page load times: < 3 seconds.
OCR processing time: < 10 seconds per receipt.
7.2. Security:

Adherence to standard web security best practices (OWASP Top 10).
Secure handling of PII and financial data.
Secure API key management for external services (Google Cloud Vision, Twilio, Supabase Storage).
7.3. Scalability: System should be able to handle growth in the number of employees and receipts. 7.4. Reliability: High availability for both employee app and accounting dashboard.
8. Success Metrics (V1) 
8.1. Adoption rate by employees. 
8.2. Reduction in time spent by accounting on receipt processing and management. 
8.3. User satisfaction (measured via feedback from both employees and accountants). 
8.4. Accuracy of OCR data extraction (percentage of fields correctly auto-filled, minimizing accountant edits).
9. Out of Scope for V1 (Future Considerations) 
9.1. Employee Notifications: Email or SMS notifications to employees upon receipt status changes (Approved, Rejected). Decision: Postpone for V1, evaluate need based on usage.
9.2. Advanced in-app reporting and analytics beyond CSV export. 
9.4. Manager approval workflows or distinct user roles beyond Employee and Accountant/Admin.
9.5. Direct integration with accounting software (e.g., QuickBooks, Xero). 
9.6. Budget tracking or Job Code specific expense allocation. 
9.7. Detailed audit logs for all changes made by accountants (though Supabase may offer some inherent logging).

receipt date (date on receipt)
remove 'reimbursed'
upload images, not just take
duplicate checker


