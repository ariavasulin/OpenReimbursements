import { describe, expect, it } from "vitest";
import { canDeleteAlbum, canTrashPhoto, isPhotoAdmin, TRASH_RULE_MESSAGE } from "./permissions";

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
