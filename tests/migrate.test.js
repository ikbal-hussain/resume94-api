import { describe, it, expect } from "vitest";
import { migrateResumeData } from "../src/migrateResume.js";

describe("legacy resume migration", () => {
  it("splits an experience string into role, company and dates", () => {
    const { experience } = migrateResumeData({
      experience: ["Senior Engineer at Acme Corp (2021 - Present)\nLed the billing rewrite\nMentored three juniors"],
    });
    expect(experience[0]).toMatchObject({
      role: "Senior Engineer",
      company: "Acme Corp",
      startDate: "2021",
      endDate: "Present",
      current: true,
      bullets: ["Led the billing rewrite", "Mentored three juniors"],
    });
  });

  it("never loses text it cannot parse", () => {
    const blob = "did a bunch of freelance work over several years";
    const { experience } = migrateResumeData({ experience: [blob] });
    expect(experience[0].company).toBe(blob);
    expect(JSON.stringify(experience)).toContain("freelance");
  });

  it("parses education, projects and certifications", () => {
    const out = migrateResumeData({
      education: ["BSc Computer Science at MIT (2016-2020)"],
      projects: ["Resume94 - an AI resume builder https://resume-94.vercel.app"],
      certifications: ["AWS Solutions Architect at Amazon 2023"],
    });
    expect(out.education[0]).toMatchObject({ degree: "BSc Computer Science", institution: "MIT", startDate: "2016", endDate: "2020" });
    expect(out.projects[0]).toMatchObject({ name: "Resume94", link: "https://resume-94.vercel.app" });
    expect(out.projects[0].bullets[0]).toContain("AI resume builder");
    expect(out.certifications[0]).toMatchObject({ name: "AWS Solutions Architect", issuer: "Amazon", date: "2023" });
  });

  it("converts a comma-separated skills blob into a group", () => {
    const { skills } = migrateResumeData({ skills: "React, Node.js, MongoDB" });
    expect(skills).toEqual([{ category: "", items: ["React", "Node.js", "MongoDB"] }]);
  });

  it("keeps skill categories when present", () => {
    const { skills } = migrateResumeData({ skills: "Languages: Go, Rust\nTools: Docker" });
    expect(skills).toEqual([
      { category: "Languages", items: ["Go", "Rust"] },
      { category: "Tools", items: ["Docker"] },
    ]);
  });

  it("leaves already-migrated data untouched (idempotent)", () => {
    const modern = migrateResumeData({
      name: "Ada",
      experience: [{ company: "Acme", role: "Dev", startDate: "2020", endDate: "2022", current: false, bullets: ["Shipped it"] }],
      skills: [{ category: "Core", items: ["Go"] }],
    });
    expect(migrateResumeData(modern)).toEqual(modern);
    expect(modern.experience[0].company).toBe("Acme");
  });

  it("applies defaults and survives junk input", () => {
    for (const junk of [null, undefined, "nonsense", 42, []]) {
      const out = migrateResumeData(junk);
      expect(out.templateId).toBe("classic");
      expect(out.experience).toEqual([]);
    }
  });

  it("drops unknown fields rather than storing them", () => {
    const out = migrateResumeData({ name: "Ada", evil: "<script>" });
    expect(out.name).toBe("Ada");
    expect(out.evil).toBeUndefined();
  });
});
