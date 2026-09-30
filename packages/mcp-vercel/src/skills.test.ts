import { describe, expect, it } from "vitest";
import { resolveGrantedSkills } from "./skills.js";

const resolve = (query: string) =>
  resolveGrantedSkills(new URLSearchParams(query));

describe("resolveGrantedSkills", () => {
  it("grants every active skill when nothing is asked", () => {
    const r = resolve("");
    expect(r.ok && [...r.grantedSkills].sort()).toEqual([
      "inspect",
      "project-management",
      "seer",
      "triage",
    ]);
  });

  it("lets ?skills replace the set", () => {
    const r = resolve("skills=inspect,triage");
    expect(r.ok && [...r.grantedSkills].sort()).toEqual(["inspect", "triage"]);
  });

  it("lets ?disable-skills remove from the default", () => {
    const r = resolve("disable-skills=project-management,seer");
    expect(r.ok && [...r.grantedSkills].sort()).toEqual(["inspect", "triage"]);
  });

  it("refuses an unknown skill instead of dropping it", () => {
    expect(resolve("skills=inspect,triag")).toEqual({
      ok: false,
      message: "skills provided invalid skills: triag",
    });
  });

  it("refuses an empty skills list instead of granting everything", () => {
    expect(resolve("skills=").ok).toBe(false);
  });

  it("refuses to disable everything", () => {
    expect(resolve("skills=inspect&disable-skills=inspect").ok).toBe(false);
  });

  it("refuses an unknown disable-skills entry", () => {
    expect(resolve("disable-skills=nope").ok).toBe(false);
  });
});
