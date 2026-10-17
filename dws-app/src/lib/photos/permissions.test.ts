import { describe, expect, it } from "vitest";
import {
  canDeleteAlbum,
  canTrashPhoto,
  isPhotoAdmin,
  trashActionLabel,
  trashableIds,
  TRASH_RULE_MESSAGE,
} from "./permissions";

const now = Date.parse("2026-10-12T12:00:00Z");
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
const me = { user_id: "me", photo_admin: false };
const admin = { user_id: "admin", photo_admin: true };

describe("canTrashPhoto (mirrors SQL photo_can_trash)", () => {
  it("lets an uploader trash their own upload for 30 days, and not after", () => {
    expect(canTrashPhoto(me, { uploader_id: "me", created_at: daysAgo(29) }, now)).toBe(true);
    expect(canTrashPhoto(me, { uploader_id: "me", created_at: daysAgo(31) }, now)).toBe(false);
  });
  it("never lets an employee trash a colleague's photo, however new", () => {
    expect(canTrashPhoto(me, { uploader_id: "someone", created_at: daysAgo(0) }, now)).toBe(false);
  });
  it("lets a photo admin trash anything", () => {
    expect(canTrashPhoto(admin, { uploader_id: "someone", created_at: daysAgo(400) }, now)).toBe(true);
  });
  it("offers nothing before the permissions load or on a bad date", () => {
    expect(canTrashPhoto(undefined, { uploader_id: "me", created_at: daysAgo(1) }, now)).toBe(false);
    expect(canTrashPhoto(me, { uploader_id: "me", created_at: "not a date" }, now)).toBe(false);
  });
  it("says the rule plainly", () => {
    expect(TRASH_RULE_MESSAGE).toBe("You can only delete photos you uploaded in the last 30 days.");
  });
});

describe("canDeleteAlbum and isPhotoAdmin", () => {
  it("lets the album's maker or a photo admin delete it", () => {
    expect(canDeleteAlbum(me, { created_by: "me" })).toBe(true);
    expect(canDeleteAlbum(me, { created_by: "someone" })).toBe(false);
    expect(canDeleteAlbum(me, { created_by: null })).toBe(false);
    expect(canDeleteAlbum(admin, { created_by: "someone" })).toBe(true);
    expect(canDeleteAlbum(undefined, { created_by: "me" })).toBe(false);
  });
  it("is true only for a loaded photo admin", () => {
    expect(isPhotoAdmin(admin)).toBe(true);
    expect(isPhotoAdmin(me)).toBe(false);
    expect(isPhotoAdmin(undefined)).toBe(false);
  });
});

describe("trashableIds and trashActionLabel (the selection bar's Trash)", () => {
  const mineNew = { id: "mine-new", uploader_id: "me", created_at: daysAgo(2) };
  const mineOld = { id: "mine-old", uploader_id: "me", created_at: daysAgo(45) };
  const theirs = { id: "theirs", uploader_id: "someone", created_at: daysAgo(1) };
  const loaded = [mineNew, mineOld, theirs];
  const label = (actor: typeof me | undefined, selected: string[], rows = loaded) =>
    trashActionLabel(trashableIds(actor, selected, rows, now).length, new Set(selected).size);

  it("gives a photo admin plain Trash for every selection, loaded or not", () => {
    expect(trashableIds(admin, ["theirs", "mine-old"], loaded, now)).toEqual(["theirs", "mine-old"]);
    expect(label(admin, ["theirs", "mine-old"])).toBe("Trash");
    expect(label(admin, ["theirs"])).toBe("Trash");
    expect(label(admin, ["not-loaded-1", "not-loaded-2"])).toBe("Trash");
    expect(label(admin, ["theirs"], [])).toBe("Trash");
  });

  it("gives an employee Trash only when every selected photo is theirs and new", () => {
    expect(label(me, ["mine-new"])).toBe("Trash");
  });

  it("names how many an employee may trash in a mixed selection, and takes only those", () => {
    expect(trashableIds(me, ["mine-new", "theirs", "mine-old"], loaded, now)).toEqual(["mine-new"]);
    expect(label(me, ["mine-new", "theirs", "mine-old"])).toBe("Trash the 1 you can delete");
  });

  it("offers an employee nothing when none qualify", () => {
    expect(label(me, ["theirs", "mine-old"])).toBeNull();
  });

  it("offers photos not loaded yet (Select all past the loaded pages); the server refuses per photo", () => {
    expect(trashableIds(me, ["theirs", "unloaded"], loaded, now)).toEqual(["unloaded"]);
    expect(label(me, ["theirs", "unloaded"])).toBe("Trash the 1 you can delete");
    expect(label(me, ["mine-new", "unloaded"])).toBe("Trash");
  });

  it("counts a photo shown twice (tag groups) once", () => {
    const twice = [mineNew, theirs, mineNew, theirs];
    expect(trashableIds(admin, ["mine-new", "theirs"], twice, now)).toHaveLength(2);
    expect(trashableIds(me, ["mine-new", "theirs"], twice, now)).toEqual(["mine-new"]);
    expect(trashableIds(me, ["mine-new", "mine-new"], twice, now)).toEqual(["mine-new"]);
  });

  it("reads a map of the loaded photos by id the same as the list", () => {
    const byId = new Map(loaded.map((photo) => [photo.id, photo]));
    expect(trashableIds(me, ["mine-new", "theirs", "mine-old", "unloaded"], byId, now)).toEqual([
      "mine-new",
      "unloaded",
    ]);
    expect(trashableIds(admin, ["theirs", "mine-old"], byId, now)).toEqual(["theirs", "mine-old"]);
    expect(trashableIds(undefined, ["mine-new"], byId, now)).toEqual([]);
  });

  it("offers nothing before the permissions load", () => {
    expect(trashableIds(undefined, ["mine-new"], loaded, now)).toEqual([]);
    expect(label(undefined, ["mine-new"])).toBeNull();
  });

  it("writes big counts with commas", () => {
    expect(trashActionLabel(1200, 5000)).toBe("Trash the 1,200 you can delete");
    expect(trashActionLabel(0, 3)).toBeNull();
  });
});
