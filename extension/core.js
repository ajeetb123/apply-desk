export const FIELD_RULES = {
  email: ["email", "e-mail"],
  phone: ["phone", "mobile", "telephone", "cell number"],
  first_name: ["first name", "given name", "forename"],
  last_name: ["last name", "family name", "surname"],
  full_name: ["full name", "legal name", "your name", "candidate name"],
  address: ["street address", "address line 1", "address1", "home address", "mailing address", "address"],
  city: ["city", "town"],
  state: ["state", "province", "region"],
  postal_code: ["zip code", "postal code", "zip/postal"],
  school: ["university", "college", "school", "institution"],
  degree: ["degree", "education level"],
  graduation: ["graduation date", "expected graduation", "graduation year", "date of graduation"]
};

export function normalize(text) {
  return String(text ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().replace(/[_-]+/g, " ").replace(/[^a-z0-9@+ ]/g, " ").replace(/\s+/g, " ").trim();
}

export function inferField(label) {
  const value = normalize(label);
  if (!value || /password|resume|cover letter|linkedin|portfolio|website|url|visa|sponsor|work authorization|authorized to work|disability|veteran|gender|ethnicity|salary|compensation|date of birth|social security|ssn|emergency contact|current employer|supervisor|reference/.test(value)) return null;
  // Keep the more specific name and address variants ahead of broad matches.
  const order = ["first_name", "last_name", "full_name", "email", "phone", "address", "postal_code", "city", "school", "state", "degree", "graduation"];
  for (const key of order) {
    if (FIELD_RULES[key].some(term => value === term || value.startsWith(`${term} `) || value.endsWith(` ${term}`) || value.includes(` ${term} `))) return key;
  }
  return null;
}

export function parseCommand(input) {
  const text = normalize(input);
  if (!text) return { action: "empty" };
  if (/^(help|commands|what can you do)$/.test(text)) return { action: "help" };
  if (/\b(fill|autofill|apply|enter my details)\b/.test(text)) return { action: "fill" };
  if (/\b(scan|inspect|read)\b/.test(text)) return { action: "scan" };
  if (/\b(tailor|match|fit|review|evaluate)\b/.test(text)) return { action: "tailor" };
  return { action: "unknown" };
}

export function mapProfileValue(field, profile) {
  profile ||= {};
  if (field === "first_name") return String(profile.name || "").trim().split(/\s+/)[0] || "";
  if (field === "last_name") return String(profile.name || "").trim().split(/\s+/).slice(1).join(" ");
  if (field === "full_name") return profile.name || "";
  return profile[field] || "";
}

export function prepareFillPlan(fields, profile) {
  profile ||= {};
  const plan = [];
  const skippedExisting = [];
  for (const field of fields || []) {
    if (!field || typeof field !== "object") continue;
    if (field.disabled || field.readOnly || field.hidden || field.checked || ["hidden", "password", "file", "checkbox", "radio", "submit", "button", "reset"].includes(String(field.type || "").toLowerCase())) continue;
    if (String(field.value || "").trim()) {
      if (inferField(field.label)) skippedExisting.push(inferField(field.label));
      continue;
    }
    const key = inferField(field.label);
    if (!key) continue;
    const value = mapProfileValue(key, profile);
    if (!value) continue;
    // Date, number, select, and other typed inputs can require a format or a
    // deliberate choice. Fill only ordinary text plus email and phone fields.
    const type = String(field.type || "text").toLowerCase();
    if (!["text", "email", "tel", "textarea"].includes(type)) continue;
    if (type === "email" && key !== "email") continue;
    if (type === "tel" && key !== "phone") continue;
    plan.push({ index: field.index, key, value: String(value) });
  }
  return { plan, skippedExisting };
}
