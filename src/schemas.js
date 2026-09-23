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

export const summaryRequestSchema = z.object({
  role: z.string().trim().min(1).max(100),
  experience: z.string().trim().min(1).max(50),
  keySkills: z.string().trim().min(1).max(500),
});

export const improveRequestSchema = z.object({
  section: z.enum(["projects", "education", "experience", "certifications"]),
  content: z.string().trim().min(1).max(2000),
});
