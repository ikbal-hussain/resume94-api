import { z } from "zod";

const entry = z.string().max(2000);
const shortText = (max = 200) => z.string().trim().max(max).default("");

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

export const resumeDataSchema = z.object({
  name: shortText(100),
  email: shortText(254),
  phone: shortText(30),
  location: shortText(100),
  github: shortText(200),
  linkedin: shortText(200),
  summary: z.string().max(3000).default(""),
  skills: z.string().max(2000).default(""),
  education: z.array(entry).max(20).default([]),
  experience: z.array(entry).max(20).default([]),
  projects: z.array(entry).max(20).default([]),
  certifications: z.array(entry).max(20).default([]),
  // Data URL; ~1.4MB of base64 ≈ 1MB image.
  profileImage: z
    .string()
    .max(1_400_000)
    .regex(/^data:image\/(png|jpe?g|webp);base64,/, "Must be a PNG, JPEG or WebP data URL")
    .nullable()
    .default(null),
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
