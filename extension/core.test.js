import test from "node:test";
import assert from "node:assert/strict";
import { inferField, mapProfileValue, normalize, parseCommand, prepareFillPlan } from "./core.js";

test("normalization handles missing and noisy labels", () => {
  assert.equal(normalize(null), "");
  assert.equal(normalize(" First_Name / Email "), "first name email");
  assert.equal(normalize("ZIP—Code"), "zip code");
  assert.equal(normalize("postalCode"), "postal code");
});

test("command parser accepts plain-language commands and rejects unrelated text", () => {
  for (const phrase of ["scan", "scan this job", "read this page"]) assert.equal(parseCommand(phrase).action, "scan");
  for (const phrase of ["tailor", "fit this job", "review the posting", "match job"]) assert.equal(parseCommand(phrase).action, "tailor");
  for (const phrase of ["fill", "autofill my details", "apply", "enter my details"]) assert.equal(parseCommand(phrase).action, "fill");
  assert.equal(parseCommand("   ").action, "empty");
  assert.equal(parseCommand("write me a cover letter").action, "unknown");
  assert.equal(parseCommand("help").action, "help");
});

test("field matching recognizes common ATS label variants", () => {
  const cases = new Map([
    ["First name", "first_name"], ["legal last_name", "last_name"],
    ["Candidate legal name", "full_name"], ["Email address", "email"],
    ["Mobile telephone", "phone"], ["Street Address (Line 1)", "address"],
    ["City / Town", "city"], ["State / Province", "state"],
    ["Postal Code", "postal_code"], ["College or university", "school"],
    ["Highest degree", "degree"], ["Expected graduation date", "graduation"]
  ]);
  for (const [label, expected] of cases) assert.equal(inferField(label), expected, label);
});

test("field matching refuses screening, credential, demographic, and essay fields", () => {
  for (const label of ["Password", "Resume upload", "LinkedIn URL", "Visa sponsorship", "Work authorization", "Gender", "Date of birth", "Social Security number", "Salary expectation", "Why do you want to work here?", "Current employer", "Reference name"]) {
    assert.equal(inferField(label), null, label);
  }
});

test("field matching fails closed on ambiguous labels", () => {
  for (const label of ["", "Other", "Text field", "Tell us about yourself", "Company", "Job title", "Country", "Are you authorized? Work authorization details"]) {
    assert.equal(inferField(label), null, label);
  }
  assert.equal(inferField("Township"), null);
  assert.equal(inferField("State University"), "school");
});

test("profile mapping handles multi-part and incomplete names safely", () => {
  const profile = { name: "Taylor Example", email: "a@example.com" };
  assert.equal(mapProfileValue("first_name", profile), "Taylor");
  assert.equal(mapProfileValue("last_name", profile), "Example");
  assert.equal(mapProfileValue("full_name", profile), "Taylor Example");
  assert.equal(mapProfileValue("phone", profile), "");
  assert.equal(mapProfileValue("first_name", { name: "Sam" }), "Sam");
  assert.equal(mapProfileValue("last_name", { name: "Sam" }), "");
  assert.equal(mapProfileValue("email", null), "");
});

test("fill plan uses only empty, editable, safe, clearly labelled fields", () => {
  const fields = [
    { index: 0, type: "text", label: "First name", value: "", disabled: false, readOnly: false },
    { index: 1, type: "email", label: "Email", value: "", disabled: false, readOnly: false },
    { index: 2, type: "text", label: "Phone number", value: "existing phone", disabled: false, readOnly: false },
    { index: 3, type: "text", label: "Work authorization", value: "", disabled: false, readOnly: false },
    { index: 4, type: "password", label: "Password", value: "", disabled: false, readOnly: false },
    { index: 5, type: "text", label: "First name", value: "", disabled: true, readOnly: false },
    { index: 6, type: "text", label: "Tell us about yourself", value: "", disabled: false, readOnly: false },
    { index: 7, type: "date", label: "Graduation date", value: "", disabled: false, readOnly: false },
    { index: 8, type: "text", label: "City", value: "", disabled: false, readOnly: true },
    { index: 9, type: "text", label: "State", value: "", disabled: false, readOnly: false },
    { index: 10, type: "tel", label: "Email", value: "", disabled: false, readOnly: false },
    null
  ];
  const result = prepareFillPlan(fields, { name: "Taylor Example", email: "a@example.com", phone: "555-0100", state: "VA" });
  assert.deepEqual(result.plan, [
    { index: 0, key: "first_name", value: "Taylor" },
    { index: 1, key: "email", value: "a@example.com" },
    { index: 9, key: "state", value: "VA" }
  ]);
  assert.deepEqual(result.skippedExisting, ["phone"]);
  assert.deepEqual(prepareFillPlan(null, null), { plan: [], skippedExisting: [] });
});
