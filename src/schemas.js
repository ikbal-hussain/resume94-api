import { z } from "zod";

const shortText = (max = 200) => z.string().trim().max(max).default("");
const bullets = z.array(z.string().trim().max(500)).max(12).default([]);
/** Free-form on purpose: real resumes use "2021", "Mar 2021", "Present". */
const dateText = z.string().trim().max(30).default("");

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1).max(128),
});

export const updateProfileSchema = z.object({ name: z.string().trim().min(1).max(100) });

export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

export const resetPasswordSchema = z.object({
  token: z.string().trim().min(20).max(200),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});

export const experienceItemSchema = z.object({
  company: shortText(120),
  role: shortText(120),
  location: shortText(100),
  startDate: dateText,
  endDate: dateText,
  current: z.boolean().default(false),
  bullets,
});

export const educationItemSchema = z.object({
  institution: shortText(150),
  degree: shortText(120),
  field: shortText(120),
  location: shortText(100),
  startDate: dateText,
  endDate: dateText,
  grade: shortText(40),
});

export const projectItemSchema = z.object({
  name: shortText(120),
  role: shortText(120),
  link: shortText(300),
  startDate: dateText,
  endDate: dateText,
  bullets,
});

export const certificationItemSchema = z.object({
  name: shortText(150),
  issuer: shortText(120),
  date: dateText,
  link: shortText(300),
});

/** Grouped so templates can render "Languages: Go, Rust" rather than one long blob. */
export const skillGroupSchema = z.object({
  category: shortText(60),
  items: z.array(z.string().trim().max(60)).max(40).default([]),
});

export const TEMPLATE_IDS = ["classic", "modern", "minimal", "compact"];

export const resumeDataSchema = z.object({
  name: shortText(100),
  headline: shortText(120),
  email: shortText(254),
  phone: shortText(30),
  location: shortText(100),
  website: shortText(200),
  github: shortText(200),
  linkedin: shortText(200),
  summary: z.string().max(3000).default(""),

  experience: z.array(experienceItemSchema).max(20).default([]),
  education: z.array(educationItemSchema).max(20).default([]),
  projects: z.array(projectItemSchema).max(20).default([]),
  certifications: z.array(certificationItemSchema).max(20).default([]),
  skills: z.array(skillGroupSchema).max(12).default([]),

  // Data URL; ~1.4MB of base64 ≈ 1MB image.
  profileImage: z
    .string()
    .max(1_400_000)
    .regex(/^data:image\/(png|jpe?g|webp);base64,/, "Must be a PNG, JPEG or WebP data URL")
    .nullable()
    .default(null),

  templateId: z.enum(TEMPLATE_IDS).default("classic"),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex colour like #2563eb")
    .default("#2563eb"),
  sectionOrder: z.array(z.string().max(40)).max(20).default([]),
});

export const resumeBodySchema = z.object({
  title: z.string().trim().min(1).max(100),
  data: resumeDataSchema,
});

/**
 * Plain text extracted from a resume the user already has.
 *
 * The extraction happens in the browser, which already ships pdf.js for the preview —
 * so this endpoint never handles a file, only text. That keeps the serverless function
 * free of multipart parsing and keeps a 5 MB PDF from ever crossing the wire.
 *
 * The floor rejects a PDF that yielded almost nothing, which is what a rasterised
 * resume looks like from here. The ceiling is cost control: a dense two-page CV is
 * around 6k characters, and provider spend scales with input length.
 */
export const importResumeSchema = z.object({
  text: z.string().trim().min(200).max(20_000),
});

/* ------------------------------------------------------------------ *
 * Parsing the model's answer.
 *
 * Everything below describes output from a language model, not a person filling in a
 * form, so the failure mode is what matters. A model that returns a paragraph where a
 * list belongs, a number where a string belongs, or thirteen bullets where twelve are
 * allowed should cost the user that one field — never the whole import, which is forty
 * seconds of their time and a provider call that has already been paid for.
 *
 * So these are deliberately permissive where resumeDataSchema is strict: they coerce
 * and truncate instead of rejecting. The result is handed back through the ordinary
 * create/update path afterwards, where resumeDataSchema does apply, so nothing skips
 * validation on its way into the database.
 * ------------------------------------------------------------------ */

/** Coerces to a trimmed string and truncates. Cannot fail. */
const loose = (max) =>
  z.preprocess(
    (v) => (typeof v === "number" ? String(v) : typeof v === "string" ? v.trim().slice(0, max) : ""),
    z.string().default("")
  );

/** Accepts a list, or a newline-separated block, and strips any bullet glyph. */
const looseList = (max, maxLen) =>
  z.preprocess((v) => {
    const raw = typeof v === "string" ? v.split(/\r?\n/) : Array.isArray(v) ? v : [];
    return raw
      .filter((s) => typeof s === "string" || typeof s === "number")
      .map((s) => String(s).replace(/^\s*[-•*·]\s*/, "").trim().slice(0, maxLen))
      .filter(Boolean)
      .slice(0, max);
  }, z.array(z.string()).default([]));

const looseBool = z.preprocess((v) => v === true || v === "true" || v === "yes", z.boolean().default(false));

/**
 * Parses each entry on its own, dropping any that is not an object at all.
 *
 * The target is `z.array(item)` rather than `z.array(z.any())`, even though the
 * preprocess has already parsed every entry. Re-parsing is idempotent — each field
 * coerces to itself the second time — and it means the generated OpenAPI schema
 * describes the real entry shape instead of "an array of anything".
 */
const looseEntries = (item, max) =>
  z.preprocess((v) => {
    if (!Array.isArray(v)) return [];
    const kept = [];
    for (const entry of v) {
      const parsed = item.safeParse(entry);
      if (parsed.success) kept.push(parsed.data);
      if (kept.length === max) break;
    }
    return kept;
  }, z.array(item).default([]));

const parsedExperienceSchema = z.object({
  company: loose(120),
  role: loose(120),
  location: loose(100),
  startDate: loose(30),
  endDate: loose(30),
  current: looseBool,
  bullets: looseList(12, 500),
});

const parsedEducationSchema = z.object({
  institution: loose(150),
  degree: loose(120),
  field: loose(120),
  location: loose(100),
  startDate: loose(30),
  endDate: loose(30),
  grade: loose(40),
});

const parsedProjectSchema = z.object({
  name: loose(120),
  role: loose(120),
  link: loose(300),
  startDate: loose(30),
  endDate: loose(30),
  bullets: looseList(12, 500),
});

const parsedCertificationSchema = z.object({
  name: loose(150),
  issuer: loose(120),
  date: loose(30),
  link: loose(300),
});

const parsedSkillGroupSchema = z.object({
  category: loose(60),
  items: looseList(40, 60),
});

/**
 * Content fields only. Template, accent colour, section order and profile photo are
 * presentation, and an imported document keeps whatever the user had chosen rather
 * than having a model guess at it.
 */
export const parsedResumeSchema = z.object({
  name: loose(100),
  headline: loose(120),
  email: loose(254),
  phone: loose(30),
  location: loose(100),
  website: loose(200),
  github: loose(200),
  linkedin: loose(200),
  summary: loose(3000),

  experience: looseEntries(parsedExperienceSchema, 20),
  education: looseEntries(parsedEducationSchema, 20),
  projects: looseEntries(parsedProjectSchema, 20),
  certifications: looseEntries(parsedCertificationSchema, 20),
  skills: looseEntries(parsedSkillGroupSchema, 12),
});

export const summaryRequestSchema = z.object({
  role: z.string().trim().min(1).max(100),
  experience: z.string().trim().min(1).max(50),
  keySkills: z.string().trim().min(1).max(500),
});

export const improveRequestSchema = z.object({
  section: z.enum(["projects", "education", "experience", "certifications"]),
  content: z.string().trim().min(1).max(2000),
});
