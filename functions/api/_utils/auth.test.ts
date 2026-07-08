import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./auth";

describe("password verification", () => {
  it("requires a configured password hash", async () => {
    await expect(verifyPassword("1234", null)).resolves.toBe(false);
    await expect(verifyPassword("1234", "")).resolves.toBe(false);
    await expect(verifyPassword("1234", "malformed")).resolves.toBe(false);
  });

  it("verifies PBKDF2 password hashes", async () => {
    const hash = await hashPassword("1234");

    await expect(verifyPassword("1234", hash)).resolves.toBe(true);
    await expect(verifyPassword("4321", hash)).resolves.toBe(false);
  });

  it("mints hashes at exactly 100k iterations — the deployed runtime's PBKDF2 cap", async () => {
    // Production workerd throws on anything above 100k ("Pbkdf2 failed:
    // iteration counts above 100000 are not supported"), while local dev does
    // not enforce the cap. This pin keeps setup/change-password deployable.
    const hash = await hashPassword("1234");
    expect(hash).toMatch(/^pbkdf2_sha256\$100000\$/);
  });
});
