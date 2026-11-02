import { parseCommand, prepareFillPlan } from "./core.js";

const API = "http://127.0.0.1:8787";
const $ = selector => document.querySelector(selector);
const message = $("#message"), result = $("#result"), form = $("#command-form"), input = $("#command");

function say(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

async function checkConnection() {
  const status = $("#connection");
  try {
    const response = await fetch(`${API}/api/health`, { cache: "no-store" });
    if (!response.ok) throw new Error();
    const data = await response.json();
    status.className = "status ok";
    status.innerHTML = "<i></i> local app connected";
    say(data.resume_loaded ? `Resume loaded: ${data.resume_filename}` : "Connected. Import your resume in profile settings to review job fit.");
  } catch {
    status.className = "status bad";
    status.innerHTML = "<i></i> app offline";
    say("Start the local Apply Desk app, then check the connection again.", true);
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("I can’t access the current tab. Open a normal job page and try again.");
  return tab;
}

async function readJobPage(tabId) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const clean = node => (node?.innerText || "").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      const title = clean(document.querySelector("h1")) || document.title || "";
      const company = document.querySelector('meta[property="og:site_name"]')?.content || "";
      const candidates = ["[itemprop='description']", "#jobDescriptionText", "[data-testid*='description']", "article", "main", "[role='main']"];
      let description = "";
      for (const selector of candidates) {
        const text = clean(document.querySelector(selector));
        if (text.length >= 180) { description = text; break; }
      }
      if (!description) description = clean(document.body);
      return { title: title.slice(0, 200), company: company.slice(0, 200), url: location.href, description: description.slice(0, 30000) };
    }
  });
  return injection?.result;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function safeHref(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? esc(url.href) : "#";
  } catch { return "#"; }
}

function showEvaluation(data) {
  const evidence = data.evidence?.length ? `<ul class="evidence">${data.evidence.map(line => `<li>${esc(line)}</li>`).join("")}</ul>` : `<p class="muted">No matching resume lines found. Check your resume manually.</p>`;
  const chips = (items, good = false) => (items || []).slice(0, 8).map(item => `<span class="chip ${good ? "good" : ""}">${esc(item)}</span>`).join("") || `<span class="muted">None found</span>`;
  const saved = data.saved_job_id ? `<p class="muted">Saved to your local job list. Use “top 5” to compare saved roles.</p>` : "";
  result.innerHTML = `<article class="card"><div class="job-title">${esc(data.title || "Job posting")}</div><div class="job-sub">${esc(data.company || data.url || "Current page")}</div><div class="score-line"><span class="score">${Number(data.score) || 0}%</span><span class="score-caption">rough keyword overlap</span><span class="voice">${esc(data.voice)}</span></div><p>${esc(data.note)}</p>${saved}</article><article class="card"><h2>Already in your resume</h2><div class="chips">${chips(data.matched, true)}</div>${evidence}</article><article class="card"><h2>Check before adding</h2><p>Only use these if your experience supports them.</p><div class="chips">${chips(data.missing)}</div></article>`;
  result.hidden = false;
}

async function rankSavedJobs(limit = 10) {
  say("Ranking roles saved from job pages…");
  const response = await fetch(`${API}/api/jobs?limit=${encodeURIComponent(limit)}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load saved roles.");
  const data = await response.json();
  if (!data.jobs?.length) {
    result.innerHTML = `<article class="card"><h2>No saved roles yet</h2><p>Open a job listing and run “scan job” to add it to your local list.</p></article>`;
  } else {
    result.innerHTML = `<article class="card"><h2>Your top ${data.jobs.length} saved roles</h2><p class="muted">Ranked by text overlap only. Check role eligibility, deadline, and actual fit on each employer page.</p>${data.jobs.map((job, index) => `<div class="rank-row"><span class="rank-num">${index + 1}</span><div class="rank-info"><b>${esc(job.title || "Untitled role")}</b><span>${esc(job.company || "Company")}</span><a href="${safeHref(job.url)}" target="_blank" rel="noreferrer">Open employer listing ↗</a></div><b class="rank-score">${Number(job.score) || 0}%</b></div>`).join("")}</article>`;
  }
  result.hidden = false;
  say(`${data.count} saved role(s). Scan more job pages to build your list.`);
}

async function evaluateCurrentPage() {
  say("Reading the current job page…");
  const tab = await activeTab();
  const job = await readJobPage(tab.id);
  if (!job?.description || job.description.length < 80) throw new Error("I couldn’t find a job description on this page. Open the full listing or use the local app to paste its description.");
  const response = await fetch(`${API}/api/evaluate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(job) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not evaluate this job.");
  showEvaluation(data);
  say(data.resume_loaded ? "Review the evidence and gaps below. The overlap score is only a rough comparison." : "Job scanned. Import your resume in profile settings to compare experience.");
}

async function fillCurrentForm() {
  const tab = await activeTab();
  let destination;
  try { destination = new URL(tab.url).hostname; } catch { throw new Error("I can’t verify this page’s destination. Open a normal job application page and try again."); }
  const confirmText = `Send your name, email, phone, street address, and education details to ${destination} by filling clearly labelled empty fields? Some sites may save fields automatically. Nothing will be submitted. Continue?`;
  if (!window.confirm(confirmText)) return;
  say("Loading your local profile…");
  const profileResponse = await fetch(`${API}/api/profile`, { cache: "no-store" });
  if (!profileResponse.ok) throw new Error("Could not load your local profile.");
  const profile = await profileResponse.json();
  const [scan] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => [...document.querySelectorAll("input,textarea")].map((el, index) => ({
    index, type: el instanceof HTMLTextAreaElement ? "textarea" : (el.type || "text"), disabled: el.disabled, readOnly: el.readOnly, hidden: el.type === "hidden", checked: el.checked, value: el.value,
    label: [el.labels ? [...el.labels].map(item => item.innerText).join(" ") : "", el.getAttribute("aria-label"), el.placeholder, el.name, el.id].filter(Boolean).join(" ")
  })) });
  const { plan, skippedExisting } = prepareFillPlan(scan?.result || [], profile);
  const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [plan], func: actions => {
    const elements = [...document.querySelectorAll("input,textarea")], filled = [];
    for (const action of actions) {
      const el = elements[action.index];
      if (!el || el.disabled || el.readOnly || el.value?.trim()) continue;
      const type = el instanceof HTMLTextAreaElement ? "textarea" : (el.type || "text");
      if (!["text", "email", "tel", "textarea"].includes(type)) continue;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
      if (setter) setter.call(el, action.value); else el.value = action.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.style.outline = "2px solid #398463";
      filled.push(action.key);
    }
    return { filled, page: location.hostname };
  } });
  const outcome = injection?.result || { filled: [], page: "current page" };
  result.innerHTML = `<article class="card"><h2>Field fill complete</h2><p>Filled ${outcome.filled.length} clearly matched empty field(s) on ${esc(outcome.page)}.</p><div class="chips">${outcome.filled.map(esc).map(key => `<span class="chip good">${key.replaceAll("_", " ")}</span>`).join("") || "<span class='muted'>No safe matches found</span>"}</div><p>Left ${skippedExisting.length} matching field(s) unchanged because they already had a value. Screening questions, work authorization choices, and submit buttons were not touched.</p><p class="muted">Check each value on the page before continuing.</p></article>`;
  result.hidden = false;
  say("Review the filled fields on the page. Nothing was submitted.");
}

async function executeCommand(raw) {
  result.hidden = true;
  const parsed = parseCommand(raw);
  if (parsed.action === "scan" || parsed.action === "tailor") return evaluateCurrentPage();
  if (parsed.action === "rank") return rankSavedJobs(parsed.limit);
  if (parsed.action === "fill") return fillCurrentForm();
  if (parsed.action === "help") return say("Try “scan job”, “tailor resume”, “top 5”, or “fill fields”. Fill is limited to clearly labelled empty fields; it never submits.");
  if (parsed.action === "empty") return say("Type scan, tailor, or fill.", true);
  throw new Error("I don’t recognize that. Try scan, tailor, or fill.");
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("#run");
  button.disabled = true;
  try { await executeCommand(input.value); }
  catch (error) { say(error?.message || "Something went wrong. Try again.", true); }
  finally { button.disabled = false; }
});
document.querySelectorAll("[data-command]").forEach(button => button.addEventListener("click", () => { input.value = button.dataset.command; form.requestSubmit(); }));
$("#refresh").addEventListener("click", checkConnection);
checkConnection();
