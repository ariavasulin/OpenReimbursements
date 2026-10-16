import { beforeEach, describe, expect, it, vi } from "vitest";

// The route's only outside call is the server Supabase client: verifyOtp, then
// the person's own user_profiles row.
const client = vi.hoisted(() => ({
  verify: { data: {} as Record<string, unknown>, error: null as unknown },
  profile: { data: null as unknown, error: null as unknown },
  profileReads: 0,
}));

vi.mock("@/lib/supabaseServerClient", () => ({
  createSupabaseServerClient: async () => ({
    auth: { verifyOtp: async () => client.verify },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: async () => {
            client.profileReads += 1;
            return client.profile;
          },
        }),
      }),
    }),
  }),
}));

import { POST } from "./route";

const user = { id: "user-1", phone: "15555550199" };
const session = { access_token: "a", refresh_token: "r", user };

async function verify() {
  const response = await POST(new Request("http://localhost/api/auth/verify-otp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: "+15555550199", token: "1234" }),
  }));
  return { status: response.status, body: await response.json() };
}

describe("POST /api/auth/verify-otp needsName", () => {
  beforeEach(() => {
    client.verify = { data: { user, session }, error: null };
    client.profile = { data: { full_name: "Marco Reyes" }, error: null };
    client.profileReads = 0;
  });

  it("is false for a real name", async () => {
    const { status, body } = await verify();
    expect(status).toBe(200);
    expect(body).toMatchObject({ success: true, needsName: false });
  });

  it("is true for a placeholder name", async () => {
    client.profile = { data: { full_name: "+15555550199" }, error: null };
    expect((await verify()).body.needsName).toBe(true);
  });

  it("is true when there is no profile row yet", async () => {
    client.profile = { data: null, error: { code: "PGRST116" } };
    expect((await verify()).body.needsName).toBe(true);
  });

  it("is false on any other read error, so sign-in is not held up", async () => {
    client.profile = { data: null, error: { code: "57014" } };
    const { status, body } = await verify();
    expect(status).toBe(200);
    expect(body.needsName).toBe(false);
  });

  it("does not read the profile when the code is wrong", async () => {
    client.verify = { data: { user: null, session: null }, error: { message: "Token has expired or is invalid", status: 403 } };
    const { status, body } = await verify();
    expect(status).toBe(403);
    expect(body).not.toHaveProperty("needsName");
    expect(client.profileReads).toBe(0);
  });
});
