# Plan: DWS Photo App, client feedback round 1

You are in a fresh OpenReimbursements worktree. Read AGENTS.md first (it starts with a vercel/supabase login preflight). Run the personal planning front-end in order: `/plan-research-questions`, then `/plan-research`, then `/plan-author`. Insert `/plan-design` between research and author only if the research leaves real design choices open. Those skills were written for the demo repo and mention `plans/refs/authoring.md` and `python/investigations/`, which do not exist here: use `plans/active/dws-hosted-mcp/` as the plan-format reference and `Docs/` (Architecture, Database, Employee-Features, Admin-Features, photos-runbook) as the codebase map. Write everything under `plans/active/dws-photos-client-feedback/`.

## The client
The owner of DWS. Nontechnical. His notes below are what he said; the job is to work out what he wants. Some items are already shipped, some are small changes, some are real features, some are unclear. For every item the research must establish current state in the app, then classify it: shipped / small / feature / needs design / unclear. Ari (the engineer) can answer questions about intent; batch them into one list at the end of research rather than asking one at a time.

## Client notes, verbatim
Per our discussion, below are the initial comments and feedback for the DWS Photo App:

Blank Slate
- Delete entire current test library of projects, photos, and trash bin
- Add admin ability to clean trash

Restrictions
- start with users able to delete only their own photos that they uploaded in last 30days.
- yana, you and I will start as the full admins until we get this going.

Organization
- I can see the tag list getting bigger and bigger over time. Can we have it so each project has it own custom tag list that its not part of the main tag options for all the other projects?
- Add ability to select entire project for batch deleting and editing – sim to photo and groups
- See if we can connect to Database for project naming, in the meantime add ability to rename project names
- Not all projects will be in Photos, but all Photos will belong to a project. We will have to make designated project numbers for misc shared marketing and DWS events.
- add 'Uploader' and 'File Type' as new Group by options
- Each group to sort up and down
- Albums will need ability to random organize – no preset sort
- Will the system reject duplicates automatically? Sometimes we get professional photo sets in multiple file formats..

Naming
- Can the system create and rename uploaded files per a set standard. If so, the desired naming should be [Project Number] – [Date Taken YYMMDD] Space [Time Taken HHMMSS]. Example 3962 – 260923 160432

Viewing
- Stretch and maximize photo size when viewing on phone and desktop. See if possible, to eliminate app other GUI with additional click, sim to Apple photos.
- See if you can add a slide show option for selected criteria, project or Album.

Search
- Add ability to search by a mixed search criteria.
- Add ability to download or save to an existing/new album a search results.

I'll be happy to review again when you ready.

## Reading between the lines (inferred, verify)
- "Connect to Database for project naming": DWS has a company system that owns project numbers and names; he wants the app to pull from it, and rename by hand until then.
- "Albums random organize – no preset sort": manual drag ordering, not shuffle.
- "Reject duplicates": the same photo delivered as JPG and RAW/HEIC should be caught, so this is content matching, not filename matching.
- "Eliminate app other GUI with additional click": an immersive viewer that hides chrome on tap, like Apple Photos.
- "Blank slate" and "full admins" describe launch operations, not features; they may belong in a runbook step rather than the plan's build phases.

## Deliverable
A plan under plans/active/dws-photos-client-feedback/ with the research questions, the research, and the authored plan, plus the batched list of questions for Ari. Then `/peprkit:handoff`. Do not implement anything.
