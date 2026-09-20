# Albums, optional projects, and sharing — request and context

Frozen input for `../plan.md`. Do not edit; record later rulings in the plan.

## User request (verbatim, 2026-09-20)

1. [Image #1] move this leftover xmp to trash
2. Remove sheets as a first party primitive/tag. We don't need it as a field
3. We need to change the core ontology/object primitives. Project is a field that accepts null. When photos are uploaded they must belong to either an album or have a non-null project field. Think of google photos. A project is a field like date or uploader, an album is a collection of photos. Within the UI, we need to rethink the core UI on both mobile and UI to support Viewing photos by project or albums. Think google photos. This also needs to be supported on the mcp migration route.
4. Albums and Projects need optional shareable links
5. Users should be able to add new tags and have a dropdown of existing tags.
6. Tagging, adding to album, bulk select, etc should be bulk options available on both mobile and desktop
7. The bulk migration flow followed via mcp should also be available in the desktop version of the app
8. For now, there remains no admin/non admin distinction on the photos app and mcp. All users with valid logins can access photos.design-workshops.app

The image in item 1 did not arrive with the message. Production holds exactly one
`.xmp` photo row, so the target is unambiguous: photo
`8219970d-57f5-40a3-92c9-bbd262ddb8bc`, `IMG_1856.xmp`, 1,469 bytes, `kind='file'`,
project 3990 (EC Retail Reimagine - 3EC), uploaded 2026-08-23, with no matching
`IMG_1856` image.

## Client context (verbatim, 2026-09-20)

Generally speaking, the client is coming from mylio and is having difficulty thinking of file storage outside the context of folders. We have communicated the whole object primitives such that photos belong to albums and have (or dont have) project/job numbres. Generally he seems open to it, but there is confusion in folder vs tag vs field,etc. Obviously in a gcs bucket and pg db, therre are no "folders" per se, but the migration and design language/ui, etc should be intuitive for a boomer coming from this perspective of somebody who organizes by folders and mylio.

I gave him the analogy and example of playlists and tracks (he is also a dj) but he still technically has songs in folders not just 'the library' since storage is centralized, this is challenging. Having shareable links for albums, jobs, etc should help. And the ability to make new albums, etc. I just say this as some context over what inspired these changes. He's having a hard time with the whole "no folders thing"

example edge cases to think through

they might have a marketing collection of photos from different jobs.
they might have photos in a folder from a christmas party, which have no "job"
they might want to tag photos as "professional" or "field dimension" or "shop drawing" etc. and filter, group, etc.

Again this app is for non-technical people. Do not overcomplicate; keep things simple and intuitive. I just say this all as abstract context to shape your plan

## User rulings (2026-09-20)

- **Who can trash:** "Anyone can trash anything."
- **Photos address:** include the move to `photos.design-workshops.app` in this plan.
  "photos.design-workshops.app should serve the apps page that is a mistake add that
  to this plan. you can do all of this with vercel cli"
- **Sub-folders and tagging during import:** "Generally this is not a cut and dry
  question. also do they tag on bulk migration? in bulk? put on your ux designer
  product hat" — delegated to the plan's design (see plan Decisions 9 and 10).
