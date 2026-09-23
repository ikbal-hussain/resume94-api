import { resumeDataSchema } from "./schemas.js";

/**
 * Resumes were originally stored with free-text sections: `experience` etc. were
 * arrays of strings and `skills` was one comma-separated blob. Templates need real
 * fields, so stored documents are upgraded on read. Nothing is discarded — text we
 * cannot confidently split is preserved as a bullet, so no user loses content.
 */

// "Senior Engineer at Acme (2021-2023)" → role / company / dates where possible.
const HEADLINE = /^\s*(?:-\s*)?(.+?)\s+(?:at|@|,)\s+(.+?)\s*(?:[([]([^)\]]*)[)\]])?\s*$/i;
const DATE_RANGE = /((?:\w{3,9}\.?\s*)?\d{4})\s*(?:-|–|—|to)\s*((?:\w{3,9}\.?\s*)?\d{4}|present|current)/i;

const lines = (text) =>
  String(text)
    .split(/\r?\n|(?:^|\s)[•·]\s*/)
    .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
    .filter(Boolean);

function splitDates(text) {
  const m = DATE_RANGE.exec(text);
  if (!m) return { startDate: "", endDate: "", rest: text };
  return {
    startDate: m[1].trim(),
    endDate: m[2].trim(),
    rest: text.replace(m[0], "").replace(/[([]\s*[)\]]/g, "").trim(),
  };
}

function legacyExperience(entry) {
  const [first, ...others] = lines(entry);
  if (!first) return null;
  const { startDate, endDate, rest } = splitDates(first);
  const m = HEADLINE.exec(rest);
  const bullets = others.length ? others : m ? [] : [first];
  return {
    role: m ? m[1].trim() : "",
    company: m ? m[2].trim() : rest,
    location: "",
    startDate,
    endDate,
    current: /present|current/i.test(endDate),
    bullets,
  };
}

function legacyEducation(entry) {
  const [first, ...others] = lines(entry);
  if (!first) return null;
  const { startDate, endDate, rest } = splitDates(first);
  const m = HEADLINE.exec(rest);
  return {
    degree: m ? m[1].trim() : rest,
    institution: m ? m[2].trim() : others[0] || "",
    field: "",
    location: "",
    startDate,
    endDate,
    grade: "",
  };
}

function legacyProject(entry) {
  const [first, ...others] = lines(entry);
  if (!first) return null;
  const { startDate, endDate, rest } = splitDates(first);
  const [name, ...tail] = rest.split(/\s*[-–—:]\s*/);
  const inline = tail.join(" - ").trim();
  return {
    name: (name || rest).trim(),
    role: "",
    link: /https?:\/\/\S+/.exec(entry)?.[0] || "",
    startDate,
    endDate,
    bullets: [...(inline ? [inline] : []), ...others],
  };
}

function legacyCertification(entry) {
  const [first] = lines(entry);
  if (!first) return null;
  const date = /\b(19|20)\d{2}\b/.exec(first)?.[0] || "";
  const m = HEADLINE.exec(first.replace(date, "").trim());
  return {
    name: m ? m[1].trim() : first.replace(date, "").trim(),
    issuer: m ? m[2].trim() : "",
    date,
    link: /https?:\/\/\S+/.exec(entry)?.[0] || "",
  };
}

// "React, Node" → one unnamed group. "Languages: Go, Rust" → a named group.
function legacySkills(text) {
  return String(text)
    .split(/\r?\n|;/)
    .map((line) => {
      const [head, tail] = line.split(/:(.+)/);
      const hasCategory = tail !== undefined;
      const items = (hasCategory ? tail : head)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return items.length ? { category: hasCategory ? head.trim() : "", items } : null;
    })
    .filter(Boolean);
}

const mapLegacy = (value, fn) =>
  Array.isArray(value) ? value.filter((e) => typeof e === "string").map(fn).filter(Boolean) : [];

const isLegacyList = (v) => Array.isArray(v) && v.some((e) => typeof e === "string");

/** Upgrades a stored resume document to the current shape. Safe to run repeatedly. */
export function migrateResumeData(data) {
  if (!data || typeof data !== "object") return resumeDataSchema.parse({});
  const out = { ...data };

  if (isLegacyList(out.experience)) out.experience = mapLegacy(out.experience, legacyExperience);
  if (isLegacyList(out.education)) out.education = mapLegacy(out.education, legacyEducation);
  if (isLegacyList(out.projects)) out.projects = mapLegacy(out.projects, legacyProject);
  if (isLegacyList(out.certifications)) out.certifications = mapLegacy(out.certifications, legacyCertification);
  if (typeof out.skills === "string") out.skills = legacySkills(out.skills);

  // Unknown keys are dropped and missing ones defaulted, so a migrated document
  // always satisfies the current schema.
  const parsed = resumeDataSchema.safeParse(out);
  return parsed.success ? parsed.data : resumeDataSchema.parse({});
}
