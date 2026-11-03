"""What Apply Desk needs to fill a real application: who is hiring, when the
role starts, the user's standard answers, and their experience and education
laid out the way application forms ask for them. Everything comes from the
user's own profile, resume, and the posting; nothing is invented.
"""
from __future__ import annotations

import re
from datetime import date
from urllib.parse import urlparse

MONTHS = {name: i for i, names in enumerate([("jan", "january"), ("feb", "february"), ("mar", "march"), ("apr", "april"), ("may",),
                                              ("jun", "june"), ("jul", "july"), ("aug", "august"), ("sep", "sept", "september"),
                                              ("oct", "october"), ("nov", "november"), ("dec", "december")], start=1) for name in names}

# Questions most applications ask, the profile key that answers each, and the
# option labels that count as that answer in a dropdown or radio group. The
# first pattern that matches a question owns it, so specific questions come
# before general ones; a question whose answer is blank is left for the user.
# Voluntary self-identification (race, gender, veteran, disability) is never
# answered for the user.
STANDARD_QUESTIONS = [
    {"key": "us_citizen", "label": "U.S. citizen", "default": "",
     "pattern": r"are you (a |an )?(u\.? ?s\.?|united states) citizen|citizenship status|^(u\.? ?s\.? |united states )?citizen(ship)?$"},
    {"key": "authorized_us", "label": "Authorized to work in the U.S.", "default": "",
     "pattern": r"authori[sz]ed to work|eligib\w* (to work|for employment)|right to work|legally (able|permitted|eligible) to work|work authori[sz]ation"},
    {"key": "needs_sponsorship", "label": "Will need visa sponsorship", "default": "",
     "pattern": r"sponsor"},
    {"key": "clearance_eligible", "label": "Able to obtain a security clearance", "default": "",
     "pattern": r"\b(eligib\w*|able|willing)\b.{0,80}\b(obtain|get|apply for|be granted|receive|maintain)\b.{0,40}clearance|eligib\w* for .{0,30}clearance|clearance eligib"},
    {"key": "has_clearance", "label": "Hold a security clearance", "default": "",
     "pattern": r"clearance"},
    {"key": "foreign_official", "label": "Foreign government official, or close to one", "default": "",
     "pattern": r"foreign (government )?official|(non.?u\.? ?s\.?|foreign) government|official of a foreign|politically exposed"},
    {"key": "dod_official", "label": "Current or former DoD official", "default": "",
     "pattern": r"\bdod\b|department of defen[cs]e"},
    {"key": "government_employee", "label": "Ever employed by the U.S. government", "default": "",
     "pattern": r"post.?government|(employed|worked) (by|for|with) (the |a )?(u\.? ?s\.? |united states |federal )?government|government employ|federal (government )?(employ|service)|civil servant"},
    {"key": "heard_about", "label": "How you heard about roles", "default": "",
     "pattern": r"how did you (hear|learn|find)|hear about (us|this)|where did you (hear|find|learn)|referral source|^source$|candidate source"},
    {"key": "previously_employed", "label": "Previously worked for the employer", "default": "",
     "pattern": r"(previously|ever|formerly) (worked|been employed|employed)|former employee|worked (for|at) (this|our|the) (organization|company)|current or former (employee|intern)"},
    {"key": "phone_type", "label": "Phone type", "default": "Mobile", "pattern": r"phone (device )?type|type of phone"},
    {"key": "country", "label": "Country", "default": "United States of America", "pattern": r"^country( or region|/region)?$|country of residence"},
    {"key": "country_code", "label": "Country phone code", "default": "United States of America (+1)", "pattern": r"country (phone )?code|phone country"},
    {"key": "enrollment_status", "label": "Enrollment status", "default": "", "pattern": r"enrollment status|(degree|level) (are you )?(currently )?(pursuing|working towards?)|student status"},
    {"key": "currently_student", "label": "Currently a student", "default": "",
     "pattern": r"currently (working towards?|pursuing|enrolled|attending|a student)|are you (a )?(current )?(college |university )?student"},
    {"key": "degree_recent", "label": "Earned a degree in the last 2 years", "default": "",
     "pattern": r"(obtain|obtained|earn|earned|receive|received|complete|completed|graduate|graduated)( this| your| a)?( degree)? (with)?in the (last|past) \d+ (months|years)|recent graduate"},
    {"key": "gpa", "label": "GPA", "default": "", "pattern": r"\bgpa\b|grade point|overall result"},
    {"key": "over_18", "label": "18 or older", "default": "", "pattern": r"(18|eighteen) (years|or older)|at least 18|over (the age of )?18"},
    {"key": "relatives", "label": "Relatives employed there", "default": "", "pattern": r"relative|family members? (currently )?employed"},
    {"key": "relocate", "label": "Willing to relocate", "default": "", "pattern": r"relocat"},
]
STANDARD_KEYS = [q["key"] for q in STANDARD_QUESTIONS]

# Voluntary self-identification (EEO pages). Answered only from what the user
# picks in Profile; when they pick nothing, the form's own "I don't wish to
# answer" option is chosen. These answers are never learned from forms.
DECLINE = ["I do not wish to answer", "I don't wish to answer", "I do not want to answer", "I don't want to answer",
           "I do not wish to self-identify", "I don't wish to self-identify", "Decline to self-identify", "Decline to self identify",
           "Decline to answer", "Decline to state", "I choose not to self-identify", "I choose not to disclose", "Prefer not to say",
           "Prefer not to answer", "Prefer not to disclose", "Not declared", "Not specified", "Decline"]
DISCLOSURE_QUESTIONS = [
    {"key": "eeo_hispanic", "label": "Hispanic or Latino", "choices": ["Yes", "No"], "pattern": r"hispanic|latin[oax]"},
    {"key": "eeo_race", "label": "Race or ethnicity",
     "choices": ["American Indian or Alaska Native", "Asian", "Black or African American", "Native Hawaiian or Other Pacific Islander", "White", "Two or More Races"],
     "pattern": r"\brace\b|ethnic"},
    {"key": "eeo_gender", "label": "Gender", "choices": ["Male", "Female", "Non-binary"], "pattern": r"\bgender\b|^sex$|what is your sex"},
    {"key": "eeo_veteran", "label": "Veteran status", "choices": ["I am not a protected veteran", "I identify as a protected veteran"],
     "pattern": r"veteran|military status"},
    {"key": "eeo_disability", "label": "Disability", "choices": ["No, I do not have a disability", "Yes, I have a disability"], "pattern": r"disab"},
]
DISCLOSURE_KEYS = [q["key"] for q in DISCLOSURE_QUESTIONS]
DISCLOSURE_VARIANTS = {
    "Male": ["Male", "Man"], "Female": ["Female", "Woman"], "Non-binary": ["Non-binary", "Nonbinary", "Non binary", "Genderqueer"],
    "I am not a protected veteran": ["I am not a protected veteran", "I am not a veteran", "Not a protected veteran", "Not a veteran", "No"],
    "I identify as a protected veteran": ["I identify as one or more of the classifications of protected veteran", "I identify as a protected veteran",
                                          "Protected veteran", "Yes"],
    "No, I do not have a disability": ["No, I do not have a disability", "No, I don't have a disability", "No"],
    "Yes, I have a disability": ["Yes, I have a disability", "Yes"],
}


def disclosure_answers(profile: dict) -> list[dict]:
    """Options to pick for each self-identification question: the user's own
    answer, or the form's decline option when they left it blank."""
    out = []
    for question in DISCLOSURE_QUESTIONS:
        answer = (profile.get(question["key"]) or "").strip()
        options = DISCLOSURE_VARIANTS.get(answer, [answer]) if answer else DECLINE
        if question["key"] == "eeo_race" and answer:
            options = options + [f"{answer} (Not Hispanic or Latino)"]
        if question["key"] == "eeo_race" and (profile.get("eeo_hispanic") or "").lower() == "yes":
            options = ["Hispanic or Latino"] + (options if answer else [])
        out.append({"key": question["key"], "label": question["label"], "pattern": question["pattern"],
                    "answer": answer or "I don't wish to answer", "options": options, "declined": not answer})
    return out


# Labels that never get a saved answer and are never learned.
NEVER = r"race|ethnic|hispanic|latin[oax]|gender|sex\b|pronoun|disab|veteran|military status|social security|\bssn\b|date of birth|birth ?date|password|salary|compensation|pay expectation|signature|captcha"

ORG_WORDS = r"\b(university|college|institute|school|inc|llc|ltd|corp|corporation|company|co\.|labs?|laboratory|technologies|systems|group|foundation|department|library|center|centre|agency|bank|hospital)\b"
TITLE_WORDS = r"\b(intern|engineer|developer|assistant|analyst|researcher|technician|lead|manager|associate|fellow|consultant|scientist|designer|tutor|instructor|specialist|coordinator|officer|president|founder|volunteer|representative|cashier|counselor)\b"


# "How did you hear about us" needs an answer but rarely the exact one: these
# are tried in order after the user's own, most relevant for a student first.
HEARD_ABOUT = ["University Career Center", "Career Center", "Campus", "University", "College", "Career Fair", "Handshake",
               "School", "Student", "Job Board", "LinkedIn", "Indeed", "Company Website", "Careers Website", "Career Site",
               "Website", "Internet", "Online", "Other"]


def option_variants(key: str, answer: str) -> list[str]:
    """Option labels that mean `answer` for a standard question."""
    answer = answer.strip()
    if not answer:
        return []
    lower = answer.lower()
    yes, no = lower in {"yes", "y", "true"}, lower in {"no", "n", "false"}
    if key == "has_clearance" and (no or lower in {"none", "n/a"}):
        return ["No", "None", "Not applicable", "N/A", "I do not", "I have never"]
    if key in {"government_employee", "dod_official", "foreign_official"} and no:
        return ["No", "I have never", "I am not", "Never", "None", "Not applicable", "N/A"]
    if key == "clearance_eligible" and yes:
        return ["Yes", "I am eligible", "Eligible"]
    if key == "us_citizen" and yes:
        return ["Yes", "U.S. Citizen", "US Citizen", "Citizen"]
    if key == "heard_about":
        return [answer] + [option for option in HEARD_ABOUT if option.lower() != lower]
    if key == "authorized_us" and yes:
        return ["Yes", "I am authorized", "Authorized"]
    if key == "needs_sponsorship" and no:
        return ["No", "I will not", "I do not"]
    if key == "country":
        return [answer, "United States", "USA", "US"] if "united states" in lower else [answer]
    if key == "country_code":
        return [answer, "United States of America (+1)", "+1", "United States"] if "+1" in answer or "united states" in lower else [answer]
    if key == "enrollment_status" and "bachelor" in lower:
        return [answer, "Bachelor", "Bachelor's", "Undergraduate"]
    if key == "phone_type" and lower in {"mobile", "cell"}:
        return ["Mobile", "Cell", "Cellular", "Personal Cell"]
    if key == "gpa" and lower in {"n/a", "na", "none"}:
        return ["N/A", "Not applicable", "0"]
    if yes:
        return ["Yes"]
    if no:
        return ["No"]
    return [answer]


def standard_answers(profile: dict) -> list[dict]:
    """The standard questions the user has answered, ready for the filler."""
    out = []
    for question in STANDARD_QUESTIONS:
        answer = (profile.get(question["key"]) or question["default"]).strip()
        if question["key"] == "enrollment_status" and not answer and re.search(r"\bb\.?s\.?\b|bachelor", profile.get("degree", ""), re.I):
            answer = "Bachelor's"
        # Unanswered questions stay in the list so a later, looser pattern
        # can't claim them; the filler leaves them for the user.
        out.append({"key": question["key"], "pattern": question["pattern"], "answer": answer, "options": option_variants(question["key"], answer)})
    return out


def normalize_question(text: str) -> str:
    text = re.sub(r"[*:?()\[\]]", " ", (text or "").lower())
    text = re.sub(r"\b(required|optional|select one)\b", " ", text)
    return re.sub(r"\s+", " ", text).strip()[:300]


def learnable(question: str, answer: str) -> bool:
    """Short, reusable answers the user typed; never essays or sensitive fields."""
    q, a = normalize_question(question), (answer or "").strip()
    if not q or not a or len(q) < 3 or len(a) > 160 or a.lower() in {"select one", "select", "choose"}:
        return False
    return not (re.search(NEVER, q) or re.search(r"\bwhy\b|describe|statement|cover letter|tell us|essay|explain", q))


def standard_key(question: str) -> str | None:
    """The standard question a form label asks, if any."""
    q = normalize_question(question)
    return next((spec["key"] for spec in STANDARD_QUESTIONS if re.search(spec["pattern"], q)), None)


# ---------------------------------------------------------------------------
# Who is hiring, and for what

GENERIC_HEADINGS = r"^(careers?|jobs?|join (us|our team)|open (positions|roles)|current openings|work with us|job search|search (for )?jobs)\b|^careers? at |careers?$"


def company_from_host(url: str) -> str:
    parsed = urlparse(url or "")
    host, parts = parsed.netloc.lower(), [p for p in parsed.path.split("/") if p]
    if any(h in host for h in ("greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "smartrecruiters.com", "breezy.hr", "recruitee.com")) and parts:
        slug = parts[1] if parts[0] in {"embed", "v1"} and len(parts) > 1 else parts[0]
        return slug
    match = re.match(r"([a-z0-9-]+)\.(wd\d+\.)?myworkdayjobs\.com", host)
    if match:
        return match.group(1)
    match = re.match(r"(?:careers|jobs)\.([a-z0-9-]+)\.", host)
    return match.group(1) if match else ""


def proper_name(slug: str, text: str) -> str:
    """The company's own spelling of a URL slug, found in the page text."""
    if not slug:
        return ""
    letters = re.sub(r"[^a-z0-9]", "", slug.lower())
    if len(letters) < 3:
        return ""
    pattern = r"\b" + r"[\s\-.&']?".join(re.escape(c) for c in letters) + r"\b"
    match = re.search(pattern, text or "", re.IGNORECASE)
    if match and any(c.isupper() for c in match.group(0)):
        return match.group(0).strip()
    return " ".join(word.capitalize() for word in re.split(r"[-_]+", slug) if word)


def identify_role(data: dict, description: str) -> tuple[str, str]:
    """Best title and company for a posting from everything the page offered."""
    url = str(data.get("url", ""))
    signals = {key: re.sub(r"\s+", " ", str(data.get(key, "") or "")).strip()[:300]
               for key in ("title", "company", "ld_title", "ld_company", "heading", "page_title", "og_title", "site_name")}
    text = description or ""
    company = signals["ld_company"] or signals["company"]
    for source in (signals["heading"], signals["page_title"], signals["og_title"], signals["title"], text[:400]):
        match = re.search(r"\bcareers? (?:at|with) ([A-Z][\w&.,' -]{1,60}?)(?:\s*[|\-–]|$|\n|\s{2})", source)
        if match and not company:
            company = match.group(1).strip()
    if not company:
        for source in (signals["page_title"], signals["og_title"], signals["title"]):
            match = re.search(r"(?: at | @ )([A-Z][\w&.,' -]{1,60})$", source)
            if match:
                company = match.group(1).strip()
                break
    if not company and signals["site_name"] and not re.search(r"greenhouse|lever|workday|ashby|linkedin|indeed", signals["site_name"], re.I):
        company = signals["site_name"]
    if not company:
        company = proper_name(company_from_host(url), text)

    title = ""
    workday = re.search(r"^\s*(.{3,120}?) page is loaded\s*$", text, re.MULTILINE)
    for candidate in (signals["ld_title"], workday.group(1) if workday else "", signals["heading"], signals["title"], signals["og_title"], signals["page_title"]):
        candidate = re.sub(r"^job application for\s+", "", candidate or "", flags=re.I).strip()
        if candidate and not re.search(GENERIC_HEADINGS, candidate, re.I):
            title = candidate
            break
    if not title:
        match = re.search(r"\bAs an? ([A-Z][\w /&+-]{3,60}?), you\b", text)
        title = match.group(1) if match else ""
    if company and title:
        # "Shield AI - Summer 2027 Intern" → "Summer 2027 Intern"; "X at Shield AI" → "X".
        name = re.escape(company)
        title = re.sub(rf"^{name}\s*[-–|:]\s*|\s*(?:[-–|]|\bat\b|@)\s*{name}\s*$", "", title, flags=re.I).strip() or title
    return title[:200], company[:200]


# ---------------------------------------------------------------------------
# Dates

def parse_month_year(text: str):
    """(year, month, day or None) from "Jan. 2025", "May 24th, 2027", "05/2026"."""
    text = (text or "").strip()
    match = re.search(r"\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2}|19\d{2})\b", text)
    if match and match.group(1).lower() in MONTHS:
        return int(match.group(3)), MONTHS[match.group(1).lower()], int(match.group(2))
    match = re.search(r"\b([A-Za-z]{3,9})\.?,?\s+(20\d{2}|19\d{2})\b", text)
    if match and match.group(1).lower() in MONTHS:
        return int(match.group(2)), MONTHS[match.group(1).lower()], None
    match = re.search(r"\b(\d{1,2})/(\d{1,2})/(20\d{2})\b", text)
    if match:
        return int(match.group(3)), int(match.group(1)), int(match.group(2))
    match = re.search(r"\b(\d{1,2})/(20\d{2})\b", text)
    if match:
        return int(match.group(2)), int(match.group(1)), None
    match = re.search(r"\b(20\d{2}|19\d{2})\b", text)
    return (int(match.group(1)), None, None) if match else None


def date_formats(parsed, default_day: int = 1) -> dict:
    """A date in the shapes forms ask for (MM/YYYY, MM/DD/YYYY, ISO, parts)."""
    if not parsed:
        return {}
    year, month, day = parsed
    month = month or 1
    day = day or default_day
    return {"year": f"{year}", "month": f"{month:02d}", "day": f"{day:02d}", "mm_yyyy": f"{month:02d}/{year}",
            "mm_dd_yyyy": f"{month:02d}/{day:02d}/{year}", "iso": f"{year}-{month:02d}-{day:02d}", "iso_month": f"{year}-{month:02d}"}


def program_start(description: str) -> tuple[dict, str]:
    """When the internship or role starts, from the posting; today otherwise."""
    text = description or ""
    range_match = re.search(r"([A-Z][a-z]{2,8}\.? \d{1,2}(?:st|nd|rd|th)?,? 20\d{2})\s*(?:-|–|—|to|through)\s*[A-Z][a-z]{2,8}\.? \d{1,2}", text)
    if range_match:
        return date_formats(parse_month_year(range_match.group(1))), "the program dates in the posting"
    start_match = re.search(r"(?:start(?:s|ing)?(?: date)?|begins?|beginning)\s*(?:on|:|in)?\s*([A-Z][a-z]{2,8}\.? (?:\d{1,2}(?:st|nd|rd|th)?,? )?20\d{2})", text)
    if start_match:
        return date_formats(parse_month_year(start_match.group(1))), "the start date in the posting"
    today = date.today()
    return date_formats((today.year, today.month, today.day)), "today's date (the posting gives no start date)"


def date_range(text: str):
    """(start, end, current) from "Jan. 2025 – Present" or "Sep. 2024 – Dec. 2024"."""
    parts = re.split(r"\s*(?:–|—|-{1,2}|\bto\b)\s*", text or "", maxsplit=1)
    start = parse_month_year(parts[0]) if parts else None
    current = bool(re.search(r"present|current|now", text or "", re.I))
    end = None if current or len(parts) < 2 else parse_month_year(parts[1])
    return start, end, current


# ---------------------------------------------------------------------------
# Experience and education, the way application forms ask for them

def split_columns(line: str) -> tuple[str, str]:
    left, gap, right = line.rpartition("    ")
    return (left.strip(), right.strip()) if gap and left.strip() else (line.strip(), "")


def experience_entries(sections) -> list[dict]:
    """Work entries (not projects) from a resume outline, newest first."""
    entries = []
    for section in sections:
        if section["kind"] != "experience" or re.search(r"project|award|honor|skill|certif|publication", section["title"], re.I):
            continue
        for entry in section["entries"]:
            if not entry["header"]:
                continue
            first = split_columns(entry["header"][0])
            second = split_columns(entry["header"][1]) if len(entry["header"]) > 1 else ("", "")
            title, company = first[0], second[0]
            if re.search(ORG_WORDS, title, re.I) and re.search(TITLE_WORDS, company, re.I) or (re.search(TITLE_WORDS, company, re.I) and not re.search(TITLE_WORDS, title, re.I)):
                title, company = company, title
            dated = next((col for col in (first[1], second[1]) if re.search(r"\b(19|20)\d{2}\b", col)), "")
            location = next((col for col in (second[1], first[1]) if col and col != dated), "")
            start, end, current = date_range(dated)
            bullets = [b["text"] if isinstance(b, dict) else b for b in entry["bullets"]]
            entries.append({"title": title, "company": company, "location": location, "current": current,
                            "start": date_formats(start), "end": date_formats(end) if end else {},
                            "description": "\n".join(f"• {b}" for b in bullets)})
    return entries[:6]


def education_entries(sections, profile: dict) -> list[dict]:
    out = []
    for section in sections:
        if section["kind"] != "education":
            continue
        for entry in section["entries"]:
            if not entry["header"]:
                continue
            first = split_columns(entry["header"][0])
            second = split_columns(entry["header"][1]) if len(entry["header"]) > 1 else ("", "")
            dated = next((col for col in (second[1], first[1]) if re.search(r"\b(19|20)\d{2}\b", col)), "")
            start, end, current = date_range(dated)
            if start and not end and not current and not re.search(r"–|—|-|to", dated):
                start, end = None, start  # "May 2028" alone is the graduation date
            out.append({"school": first[0], "location": first[1] if first[1] != dated else "", "degree": second[0],
                        "start": date_formats(start), "end": date_formats(end) if end else {}})
    if profile.get("school") or profile.get("degree"):
        graduation = date_formats(parse_month_year(profile.get("graduation", "")))
        if out:
            if profile.get("school"):
                out[0]["school"] = profile["school"]
            # Keep the resume's degree when the profile's names no degree type.
            if profile.get("degree") and (degree_options(profile["degree"]) != [profile["degree"]] or not out[0]["degree"]):
                out[0]["degree"] = profile["degree"]
            out[0]["end"] = out[0]["end"] or graduation
        else:
            out.append({"school": profile.get("school", ""), "location": "", "degree": profile.get("degree", ""), "start": {}, "end": graduation})
    for item in out:
        item["school_options"] = school_options(item["school"])
        item["degree_options"] = degree_options(item["degree"])
        item["field"] = field_of_study(item["degree"])
        item["field_options"] = field_options(item["field"])
        item["gpa"] = (profile.get("gpa") or "").strip()
    return out[:3]


# Forms list schools by official name; resumes use the everyday one.
SCHOOL_NAMES = {
    "virginia tech": "Virginia Polytechnic Institute and State University", "vt": "Virginia Polytechnic Institute and State University",
    "georgia tech": "Georgia Institute of Technology", "mit": "Massachusetts Institute of Technology",
    "caltech": "California Institute of Technology", "cmu": "Carnegie Mellon University",
    "uva": "University of Virginia", "gmu": "George Mason University", "jmu": "James Madison University",
    "vcu": "Virginia Commonwealth University", "odu": "Old Dominion University", "william & mary": "College of William and Mary",
    "william and mary": "College of William and Mary", "umd": "University of Maryland, College Park",
    "uiuc": "University of Illinois Urbana-Champaign", "ut austin": "The University of Texas at Austin",
    "uc berkeley": "University of California, Berkeley", "berkeley": "University of California, Berkeley",
    "ucla": "University of California, Los Angeles", "ucsd": "University of California, San Diego",
    "usc": "University of Southern California", "nc state": "North Carolina State University",
    "penn state": "The Pennsylvania State University", "unc": "University of North Carolina at Chapel Hill",
    "upenn": "University of Pennsylvania", "penn": "University of Pennsylvania", "umich": "University of Michigan",
    "nyu": "New York University", "rpi": "Rensselaer Polytechnic Institute", "wpi": "Worcester Polytechnic Institute",
    "rit": "Rochester Institute of Technology", "texas a&m": "Texas A&M University", "purdue": "Purdue University",
}


def school_options(school: str) -> list[str]:
    """The school's official name first, then the name as the user wrote it,
    each also spelled with "&" or "and"."""
    school = (school or "").strip()
    names = [SCHOOL_NAMES.get(school.lower(), ""), school]
    out = []
    for name in filter(None, names):
        for spelling in (name, name.replace(" and ", " & "), name.replace(" & ", " and ")):
            if spelling not in out:
                out.append(spelling)
    return out


def field_options(field: str) -> list[str]:
    """Names forms use for the user's field of study; close names only, never
    a longer different program ("Computer Science and Engineering Technology")."""
    field = (field or "").strip()
    if re.fullmatch(r"computer sciences?", field, re.I):
        return ["Computer Science", "Computer Sciences", "Computer and Information Science", "Computer and Information Sciences"]
    return [field] if field else []


def degree_options(degree: str) -> list[str]:
    lower = (degree or "").lower()
    if re.search(r"\bb\.?s\.?\b|bachelor of science", lower):
        return ["Bachelor of Science", "Bachelor's Degree", "Bachelors", "Bachelor", "BS", "B.S."]
    if re.search(r"\bb\.?a\.?\b|bachelor of arts", lower):
        return ["Bachelor of Arts", "Bachelor's Degree", "Bachelors", "Bachelor", "BA", "B.A."]
    if re.search(r"\bm\.?s\.?\b|master", lower):
        return ["Master of Science", "Master's Degree", "Masters", "Master", "MS", "M.S."]
    if re.search(r"ph\.?d|doctor", lower):
        return ["Doctor of Philosophy", "PhD", "Doctorate"]
    return [degree] if degree else []


def field_of_study(degree: str) -> str:
    degree = re.sub(r"\s*\(.*?\)|\bintended:?\s*", " ", degree or "", flags=re.I).strip()
    match = re.search(r"\bin\s+([A-Z][A-Za-z &]+?)(?:,|$|\s+minor|\s+with)", degree or "")
    if match:
        return match.group(1).strip()
    stripped = re.sub(r"^(bachelor of (science|arts)|master of (science|arts)|b\.?s\.?|b\.?a\.?|m\.?s\.?)(?![a-z])[\s,]*(in\s+)?", "", degree or "", flags=re.I).strip(" ,")
    return stripped.split(",")[0].strip()


STATES = {"AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado", "CT": "Connecticut",
          "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
          "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
          "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
          "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
          "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
          "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas", "UT": "Utah",
          "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming"}


def state_options(state: str) -> list[str]:
    state = (state or "").strip()
    if state.upper() in STATES:
        return [STATES[state.upper()], state.upper()]
    code = next((code for code, name in STATES.items() if name.lower() == state.lower()), "")
    return [state, code] if code else ([state] if state else [])
