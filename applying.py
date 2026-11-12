"""What Apply Desk needs to fill a real application: who is hiring, when the
role starts, the user's standard answers, and their experience and education
laid out the way application forms ask for them. Everything comes from the
user's own profile, resume, and the posting; nothing is invented.
"""
from __future__ import annotations

import json
import re
from datetime import date
from urllib.parse import parse_qsl, unquote, urlparse

import tailoring

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
     "pattern": r"are you (a |an )?(u\.? ?s\.?|united states) citizen|citizenship status|^(u\.? ?s\.? |united states )?citizen(ship)?$|^(?!.*\b(dual|other|another|additional|second|multiple)\b).*\bcitizen of (the )?(u\.? ?s\b|united states|usa\b|america)"},
    {"key": "authorized_us", "label": "Authorized to work in the U.S.", "default": "",
     "pattern": r"^(?!.*\b(uk|u\.k\.|united kingdom|britain|england|canada|canadian|europe|european|eu|eea|india|australia|germany|france|ireland|singapore|japan|china|mexico|netherlands|israel|switzerland|poland|spain|italy|brazil|korea)\b)(?!.{0,90}\b(require|requires|need|needs)\b.{0,40}sponsor).*(?:authori[sz]ed to work|eligib\w* (to work|for employment)|right to work|legally (able|permitted|eligible|entitled) to work|entitled to work|work authori[sz]ation)"},
    {"key": "needs_sponsorship", "label": "Will need visa sponsorship", "default": "",
     "pattern": r"^(?!.*\b(uk|u\.k\.|united kingdom|britain|england|canada|canadian|europe|european|eu|eea|india|australia|germany|france|ireland|singapore|japan|china|mexico|netherlands|israel|switzerland|poland|spain|italy|brazil|korea)\b).*sponsor"},
    # Having taken one, not being willing to ("willing to undergo a polygraph" is left for the user).
    {"key": "polygraph", "label": "Ever taken a polygraph", "default": "",
     "pattern": r"(have you|had|taken|passed|completed|current|active|hold|possess)[^.]{0,40}polygraph|polygraph (status|type|level|completed|date|history)"},
    {"key": "clearance_eligible", "label": "Able to obtain a security clearance", "default": "",
     "pattern": r"\b(eligib\w*|able|willing)\b.{0,80}\b(obtain|get|apply for|be granted|receive|maintain)\b.{0,40}clearance|eligib\w* for .{0,30}clearance|clearance eligib"},
    {"key": "has_clearance", "label": "Hold a security clearance", "default": "",
     "pattern": r"clearance"},
    {"key": "foreign_official", "label": "Foreign government official, or close to one", "default": "",
     "pattern": r"foreign (government )?official|(non.?u\.? ?s\.?|foreign) government|official of a foreign|politically exposed"},
    {"key": "dod_official", "label": "Current or former DoD official", "default": "",
     "pattern": r"\bdod\b|department of defen[cs]e"},
    {"key": "government_employee", "label": "Ever employed by the U.S. government", "default": "",
     "pattern": r"post.?government|(employed|worked) (by|for|with) (the |a )?(u\.? ?s\.? |united states |federal )?government|government employ|federal (government )?(employ|service)|civil servant|\b(current|former|currently|formerly)\b.{0,20}\b(u\.? ?s\.? )?federal\b.{0,80}\bemployee"},
    {"key": "heard_about", "label": "How you heard about roles", "default": "",
     "pattern": r"how did you (hear|learn|find)|how you (heard|learned|found)|hear about (us|this)|where did you (hear|find|learn)|referral source|^source$|candidate source"},
    {"key": "previously_employed", "label": "Previously worked for the employer", "default": "",
     "pattern": r"former .{0,40}(employee|contractor|intern)\b|(held|had|completed) (a |an |any )?(prior|previous|past) internship|^(?!.*\bapplied\b).*((previously|ever|formerly) (worked|interned|been employed|employed|work (for|at))|former employee)|worked (for|at) (this|our|the) (organization|company)|current or former (employee|intern)|(currently|presently) (employed|working) (by|for|at|with)"},
    {"key": "currently_employed", "label": "Currently employed", "default": "",
     "pattern": r"^(are you )?(currently|presently) (employed|working)$|^(current )?employment status$"},
    {"key": "current_employer", "label": "Current employer", "default": "",
     "pattern": r"^(?!.*(notice|reason|leav|permission|contact|aware|know)).*(current (employer|company)( name)?|who is your (current )?employer|where do you (currently )?work)"},
    {"key": "current_title", "label": "Current job title", "default": "", "pattern": r"current (job )?title|current (position|role)( title)?$"},
    {"key": "other_employment", "label": "Other or outside employment", "default": "",
     "pattern": r"(other|outside|additional|secondary) (employment|jobs?|work|business)|second job|moonlight|conflicts? of interest"},
    {"key": "phone_type", "label": "Phone type", "default": "Mobile", "pattern": r"phone (device )?type|type of phone"},
    {"key": "country", "label": "Country", "default": "United States of America", "pattern": r"^country( or region|/region)?$|country of residence"},
    {"key": "country_code", "label": "Country phone code", "default": "United States of America (+1)", "pattern": r"country (phone )?code|phone country"},
    {"key": "enrollment_status", "label": "Enrollment status", "default": "", "pattern": r"enrollment status|(degree|level) (are you )?(currently )?(pursuing|working towards?)|student status"},
    {"key": "born_in_us", "label": "Born in the U.S.", "default": "", "pattern": r"born in (the )?(u\.? ?s\b|united states|america)"},
    {"key": "agreements_note", "label": "If a form asks you to describe an NDA or noncompete", "default": "",
     "pattern": r"^(if (yes|so)\b|please (describe|explain|list|provide|specify)|describe|explain|list|provide)\b.{0,120}(non ?disclosure|\bnda\b|non ?compete|restrictive covenant|confidentiality agreement)"},
    {"key": "high_school", "label": "High school", "default": "", "pattern": r"^(name of (your )?)?high school( name| attended)?$|(which|what) high school|high school (did|do) you"},
    {"key": "high_school_year", "label": "Year you finished high school", "default": "", "pattern": r"(year|date) of high school graduation|high school graduation (year|date)|(when|what year) did you graduate (from )?high school"},
    # Before class_year and currently_student: "If you are currently enrolled..., what is your GPA?" is about GPA.
    {"key": "gpa", "label": "GPA", "default": "", "pattern": r"^(?!.*comment).*(\bgpa\b|grade point|overall result)"},
    {"key": "class_year", "label": "Year in school", "default": "",
     "pattern": r"year in (school|college|university)|class (standing|year|level)|academic (year|standing|classification)|current year of (study|school)|what year are you|year of study|grade level"},
    {"key": "currently_student", "label": "Currently a student", "default": "",
     "pattern": r"^(?!.*(which|what) (university|school|college|institution)).*(currently (working towards?|pursuing|enrolled|attending|a student)|are you (a )?(current )?(college |university )?student)"},
    {"key": "degree_recent", "label": "Earned a degree in the last 2 years", "default": "",
     "pattern": r"(obtain|obtained|earn|earned|receive|received|complete|completed|graduate|graduated)( this| your| a)?( degree)? (with)?in the (last|past) \d+ (months|years)|recent graduate"},
    {"key": "over_18", "label": "18 or older", "default": "", "pattern": r"(18|eighteen) (years|or older)|at least 18|over (the age of )?18"},
    {"key": "relatives", "label": "Relatives employed there", "default": "", "pattern": r"relative|family members?|close personal relationship"},
    {"key": "location_preference", "label": "Work locations you'd take", "default": "",
     "pattern": r"location preference|preferred (work )?locations?|(which|what) (of (our|these|the following) )?(locations?|offices?|sites?)|where would you (like|prefer|want) to (work|be located|be based)|indicate your location|desired (work )?locations?"},
    {"key": "relocate", "label": "Willing to relocate", "default": "", "pattern": r"relocat"},
    {"key": "work_onsite", "label": "Can work on-site or hybrid", "default": "",
     "pattern": r"(hybrid|on.?site|in the office).{0,120}(are you|can you|able|willing)|(able|willing|comfortable) to (work|commute|report|be)[^.]{0,40}(on.?site|in.?person|in the office|hybrid|office)|work (on.?site|in.?person|hybrid)( schedule| basis)?\b"},
]
STANDARD_KEYS = [q["key"] for q in STANDARD_QUESTIONS]

# Voluntary self-identification (EEO pages). Answered only from what the user
# picks in Profile; when they pick nothing, the form's own "I don't wish to
# answer" option is chosen. These answers are never learned from forms.
DECLINE = ["I do not wish to answer", "I don't wish to answer", "I do not want to answer", "I don't want to answer",
           "I do not wish to self-identify", "I don't wish to self-identify", "Decline to self-identify", "Decline to self identify",
           "Decline to answer", "Decline to state", "I choose not to self-identify", "I choose not to disclose", "Prefer not to say",
           "Prefer not to answer", "Prefer not to disclose", "Not declared", "Not specified", "I decline to self-identify",
           "I decline to answer", "I decline", "Decline"]
DISCLOSURE_QUESTIONS = [
    {"key": "eeo_hispanic", "label": "Hispanic or Latino", "choices": ["Yes", "No"], "pattern": r"hispanic|latin[oax]"},
    {"key": "eeo_race", "label": "Race or ethnicity",
     "choices": ["American Indian or Alaska Native", "Asian", "Asian Indian", "Black or African American", "Native Hawaiian or Other Pacific Islander", "White", "Two or More Races"],
     "pattern": r"\brace\b|ethnic"},
    {"key": "eeo_pronouns", "label": "Pronouns", "choices": ["He/Him", "She/Her", "They/Them"], "pattern": r"\bpronouns?\b"},
    {"key": "eeo_gender", "label": "Gender", "choices": ["Male", "Female", "Non-binary"], "pattern": r"\bgender\b|^sex$|what is your sex"},
    {"key": "eeo_veteran", "label": "Veteran status", "choices": ["I am not a protected veteran", "I identify as a protected veteran"],
     "pattern": r"veteran|military status"},
    {"key": "eeo_disability", "label": "Disability", "choices": ["No, I do not have a disability", "Yes, I have a disability"], "pattern": r"disab"},
]
DISCLOSURE_KEYS = [q["key"] for q in DISCLOSURE_QUESTIONS]
DISCLOSURE_VARIANTS = {
    # Only the Hispanic or Latino question has Yes/No answers.
    "No": ["No", "Not Hispanic or Latino", "No, not Hispanic or Latino"], "Yes": ["Yes", "Hispanic or Latino", "Yes, Hispanic or Latino"],
    # The most specific race option a form has, else the broader one.
    "Asian Indian": ["Asian Indian", "Indian", "South Asian", "Asian"],
    "He/Him": ["He/Him", "He / Him", "He, Him", "He Him", "He"], "She/Her": ["She/Her", "She / Her", "She, Her", "She Her", "She"],
    "They/Them": ["They/Them", "They / Them", "They, Them", "They Them", "They"],
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
NEVER = r"race|ethnic|hispanic|latin[oax]|gender|sex\b|lgbt|sexual orientation|transgender|accommodat|\bpronouns?\b|pronounc|pronunciation|disab|veteran|military status|social security|\bssn\b|date of birth|birth ?date|password|verification code|security code|one.?time (code|pass)|salary|compensation|pay expectation|signature|captcha"

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
    if key == "relatives" and lower in {"none", "no", "n/a", "na"}:
        return ["None", "No", "N/A", "Not applicable"]
    if key in {"polygraph", "other_employment"} and (no or lower in {"none", "n/a"}):
        return ["No", "None", "I have not", "Never", "N/A", "Not applicable"]
    if key == "currently_employed" and yes:
        return ["Yes", "Employed", "Currently employed"]
    if key == "location_preference":
        if re.search(r"open|any|all|flexib|no pref|anywhere", lower):
            return ["No preference", "Any", "Any location", "All locations", "Open to all", "Open to any location", "Flexible", "Anywhere", "All"]
        return [place.strip() for place in answer.split(";") if place.strip()]  # "Texas; Utah": each place on its own
    if key == "work_onsite" and yes:
        return ["Yes", "On-site", "Onsite", "Hybrid", "In person"]
    if key == "class_year":
        years = {"freshman": ["Freshman", "First Year", "First-year", "1st Year", "Year 1"], "sophomore": ["Sophomore", "Second Year", "Second-year", "2nd Year", "Year 2"],
                 "junior": ["Junior", "Third Year", "Third-year", "3rd Year", "Year 3"], "senior": ["Senior", "Fourth Year", "Fourth-year", "4th Year", "Year 4"]}
        return years.get(lower, [answer])
    if key == "gpa" and lower in {"n/a", "na", "none"}:
        return ["N/A", "NA", "Not applicable", "No GPA", "I do not have", "I don't have", "None", "0"]
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
        options = option_variants(question["key"], answer)
        # A form with GPA brackets and no N/A: the filler picks the bracket closest to the user's range.
        gpa_range = (profile.get("gpa_range") or "").strip()
        if question["key"] == "gpa" and gpa_range:
            answer = answer or gpa_range
            options = [option for option in options if option not in {"0", gpa_range}] + [gpa_range]
        # Unanswered questions stay in the list so a later, looser pattern
        # can't claim them; the filler leaves them for the user.
        out.append({"key": question["key"], "pattern": question["pattern"], "answer": answer, "options": options})
    return out


# Questions whose answer follows from another Profile answer, so there's
# nothing more to ask: a U.S. citizen is a "U.S. person" under export rules
# and enters "N/A" where only non-citizens list their countries; a student
# in school now can't start a job within a few weeks. They come before the
# standard questions so they own their questions.
FOLLOW_UPS = [
    # Apply Desk never picks "Other" for these, so its "please specify" is N/A.
    ("other_followup", r"^if (you )?(selected|answered|chose|checked|picked)? ?.{0,12}\bother\b.{0,60}(specify|explain|describe|list)", "", "", "N/A", ["N/A", "Not applicable"]),
    ("citizenship_followup", r"if you (answered|selected|chose|checked) .{0,40}(no|yes|other|protected individual).{0,160}(countr|citizen|national|status|specify|explain)",
     "us_citizen", "Yes", "N/A", ["N/A", "Not applicable"]),
    ("international_followup", r"if international|\(international (applicants?|candidates?|students?)( only)?\)|international (applicants?|students?) only", "us_citizen", "Yes", "N/A", ["N/A", "Not applicable"]),
    ("sponsorship_followup", r"^if (yes|so)\b.{0,60}sponsor|type of (visa )?sponsorship", "needs_sponsorship", "No", "N/A", ["N/A", "Not applicable", "None"]),
    ("export_control", r"export control|\bu\.? ?s\.? person\b|\bitar\b|\bear\b.{0,20}regulat|lawful permanent resident|protected individual",
     "us_citizen", "Yes", "Yes", ["Yes", "A citizen of the U.S.", "U.S. Citizen", "US Citizen", "Citizen", "U.S. person"]),
    ("citizenship_country", r"countr(y|ies) of (current )?citizenship|citizenship countr|(which|what) countr(y|ies) .{0,30}(citizen|national)",
     "us_citizen", "Yes", "United States of America", ["United States of America", "United States", "USA", "US"]),
    ("refugee_status", r"refugee|asylee|asylum", "us_citizen", "Yes", "No", ["No", "N/A", "Not applicable"]),
    ("start_soon", r"start within \d+ ?(days?|weeks?)|(able|available) to start (immediately|right away|now|asap)|immediate(ly)? (start|availab)",
     "currently_student", "Yes", "No", ["No"]),
]


def follow_up_answers(profile: dict) -> list[dict]:
    out = []
    for key, pattern, source, when, answer, options in FOLLOW_UPS:
        if not source or (profile.get(source) or "").strip().lower() == when.lower():
            out.append({"key": key, "pattern": pattern, "answer": answer, "options": options})
    return out


# Screening questions with one sensible answer for someone with the user's
# profile (a student who told Apply Desk: U.S. citizen, never in government or
# the military, nothing else on file). `assumed` ones are a standard answer
# rather than something the user said, and the filler flags them in the
# review. They come after the user's own answers, which always win.
YES, NO = ["Yes"], ["No"]
PRESUMED = [
    # (key, question pattern, answer, option labels, assumed, profile condition)
    ("criminal", r"convicted|felony|misdemeanor|criminal (record|history|offen[cs]e|charge)|plead(ed)? guilty|no contest", "No", NO, True, None),
    # The user won't disclose an employer's confidential information and isn't held back by any agreement.
    ("confidentiality_promise", r"^(?=.*(confidential|proprietary|trade secret|(former|previous|prior|past) employer)).*\bnot\b.{0,60}(disclose|use|bring|share|reveal|retain)|(willing|agree|able) to (sign|execute|enter).{0,60}(non ?disclosure|\bnda\b|confidentiality)",
     "Yes", ["Yes", "I agree", "Agree", "I accept", "Accept", "I acknowledge", "Acknowledge", "I understand", "True"], False, None),
    ("noncompete", r"^(?!.*(willing|able) to sign).*(non ?compete|non ?solicit|non ?disclosure|\bnda\b|confidentiality (agreement|obligation)|restrictive covenant|(agreement|contract|obligation)s? .{0,80}(restrict|prevent|limit|prohibit|conflict)|bound by (any|an) )", "No", NO + ["N/A", "None"], False, None),
    ("terminated", r"(terminated|discharged|fired|dismissed|asked to resign|involuntarily (separated|terminated))", "No", NO, True, None),
    ("discipline", r"disciplinary action|academic (misconduct|probation|dishonesty)|been (suspended|expelled)", "No", NO, True, None),
    ("debarred", r"debarred|excluded .{0,40}(federal|government) (program|contract)", "No", NO, True, None),
    ("military_service", r"(have you|did you) (ever )?serve|served in the|armed forces status|military service|currently serving|member of the (u\.? ?s\.? )?(armed forces|military|national guard|reserves?)",
     "No", ["No", "I have not served", "Never served", "None", "Not applicable", "N/A"], True, None),
    ("military_spouse", r"military spouse|spouse of .{0,40}(service member|veteran|military)", "No", NO, True, None),
    ("unable_contribute", r"reasons? (why )?you (would|could|may|might) not be able to|unable to (fully )?(contribute|support|perform)|anything that would prevent you", "No", NO, True, None),
    ("other_citizenship", r"dual (citizen|national)|(second|additional|multiple) (citizenship|nationalit)|citizen(ship)? (of|in) any other|other (citizenship|nationalit)|hold citizenship (in|of) (any|another)|citizen of (any )?(another|other) countr|(citizenship|permanent residen\w+) (in|of) (another|any other) countr",
     "No", NO + ["None", "N/A"], False, ("us_citizen", "yes")),
    ("birth_country", r"(country|place) of birth|birth ?country|country of origin|where were you born|(which|what) country were you born",
     "United States of America", ["United States of America", "United States", "USA", "US", "U.S."], False, ("born_in_us", "yes")),
    ("naturalized", r"naturali[sz]ed", "No", NO, False, ("born_in_us", "yes")),
    ("citizen_how", r"(how|basis).{0,40}(citizenship|citizen)|citizen(ship)? (by|through)", "By birth", ["By birth", "Birth", "Born in the U.S.", "Born in the United States", "Native born", "Natural born"], False, ("born_in_us", "yes")),
    ("visa_status", r"are you (currently )?(on|in|under|a holder of|holding) (a |an )?.{0,30}(visa|f 1|opt|cpt|h 1b)|(visa|immigration) (status|type)|what (type of )?visa",
     "U.S. Citizen", ["U.S. Citizen", "US Citizen", "Citizen", "Not applicable", "N/A", "None", "No"], False, ("us_citizen", "yes")),
    ("other_country_work", r"(right|authori[sz]\w+|eligib\w+|permit\w*|legally (able|allowed)) to work in (the )?(uk|u\.k\.|united kingdom|canada|europe|eu|european union|india|australia|germany|france|ireland|singapore|japan|china|mexico|netherlands)",
     "No", NO, False, ("us_citizen", "yes")),
    ("verify_identity", r"(provide|show|present|submit).{0,40}(verification|proof|documentation).{0,40}(identity|eligibility)|verification of (your )?identity", "Yes", YES, True, None),
    ("offer_deadline", r"offer deadlines?|competing offers?", "No", NO + ["None"], True, None),
    ("final_internship", r"(final|last) internship", "No", NO, False, ("class_year", "freshman")),
    ("background_check", r"background (check|investigation|screen)|drug (test|screen)|pre employment (screen|check)", "Yes", YES, True, None),
    ("essential_functions", r"essential (job )?functions|perform the (essential )?(duties|functions)", "Yes", YES, True, None),
    ("return_to_school", r"return(ing)? to (school|university|college|your (degree|studies|program|campus))|continu(e|ing) your (education|studies|degree)|still be (enrolled|a student)|enrolled .{0,60}(after|following|upon completion of) (the|your|this) (internship|program|co op)",
     "Yes", YES, False, ("currently_student", "yes")),
    ("enrolled", r"enrolled (in|at) (a |an )?(accredited|college|university|degree|bachelor|undergraduate|four year|4 year)|accredited (college|university|institution|program)|(pursuing|working towards?|seeking|completing) (a |an )?(bachelor|undergraduate|degree|bs\b|b\.s)",
     "Yes", YES, False, ("currently_student", "yes")),
    ("full_availability", r"(available|commit|able to work|participate) .{0,80}(full time|40 hours|entire|duration|full (length|program)|whole|\d+ weeks?)|available (for|during) the (entire|full|whole)", "Yes", YES, True, None),
    ("referred", r"were you referred|referred by (a|an|any) |did (a|an|any)(one| employee)? .{0,20}refer", "No", NO, True, None),
    ("travel", r"willing(ness)? to travel|able to travel|travel (up to|required|requirement)", "Yes", YES, True, None),
    ("transportation", r"reliable (means of )?transportation", "Yes", YES, True, None),
    ("flexible_hours", r"(willing|able|available) to work .{0,60}(overtime|weekends?|nights?|evenings?|shifts?|holidays|flexible hours|extended hours)", "Yes", YES, True, None),
    ("meets_requirements", r"meet (the |all |all of the )?(minimum|basic|required) (qualifications|requirements)|read (and (understood|understand) )?the (job|position) description", "Yes", YES, True, None),
    ("under_18", r"under (the age of )?18|are you a minor", "No", NO, False, ("over_18", "yes")),
    ("english", r"fluent in english|english (proficiency|fluency|language)|proficien\w+ in english|speak(ing)? english|read,? write,? and speak english",
     "Yes", ["Yes", "Fluent", "Native", "Native or bilingual", "Native / Bilingual", "Advanced", "Full professional"], False, None),
    # English is the only language the user speaks.
    ("other_languages", r"languages? other than english|(other|additional|second|foreign|another) languages?|bilingual|multilingual", "No", NO + ["None", "N/A"], False, None),
    ("languages", r"(what|which) languages? (do you|are you|can you)|languages? (spoken|you speak|fluent|proficiency)|language skills?|^languages?$", "English", ["English"], False, None),
    ("notice", r"notice period|how much notice", "N/A", ["N/A", "None", "Not applicable", "Immediately", "No notice", "2 weeks", "Two weeks"], True, None),
    ("hours_per_week", r"how many hours (per|a|each) week|hours per week (are you|can you|you can)", "40", ["40", "40 hours", "Full time", "35 40", "40+"], True, None),
    ("degrees_completed", r"degrees? (have you|you have|you've) (already )?(completed|earned|obtained)|completed (any )?degrees?|already completed",
     "I have not yet completed a degree", ["I have not yet completed a degree", "None", "No degree", "N/A", "Not applicable", "High School"], False, ("degree_recent", "no")),
    ("highest_education", r"^(?!.*(once|after|upon|when) (you.ve |you have |you )?(graduat|complet)).*(highest (level of )?education|education level|highest degree (completed|obtained|earned|attained)|level of education)",
     "High School", ["High School Diploma", "High School", "High school or equivalent", "High School/GED", "Secondary", "Some College", "GED"], False, ("degree_recent", "no")),
]


def experience_months(experience: list[dict]) -> int:
    """Months of work on the resume, counting a current job up to today."""
    today = date.today()
    total = 0
    for job in experience:
        start, end = job.get("start") or {}, job.get("end") or {}
        if not start.get("year"):
            continue
        last = (int(end["year"]), int(end["month"])) if end.get("year") else (today.year, today.month)
        total += max(1, (last[0] - int(start["year"])) * 12 + last[1] - int(start["month"]))
    return total


def program_years(school: dict) -> float:
    """A degree's length in years, counted in fall and spring semesters from the
    start through graduation: August 2026 to December 2028 is 5 semesters, 2.5 years."""
    start, end = school.get("start") or {}, school.get("end") or {}
    if not start.get("year") or not end.get("year"):
        return 0
    term = lambda d: int(d["year"]) * 2 + (1 if int(d.get("month") or 1) >= 7 else 0)
    semesters = term(end) - term(start) + 1
    return semesters / 2 if semesters > 0 else 0


def presumed_answers(profile: dict, education: list[dict], experience: list[dict], applied_before: bool = False) -> list[dict]:
    out = []
    school = education[0] if education else {}
    if school.get("degree_options"):
        # "What is your Current Degree Program?": the degree and field ("Bachelor of Science in Computer Science").
        program = f"{school['degree_options'][0]} in {school['field']}" if school.get("field") else school["degree_options"][0]
        out.append({"key": "degree_program", "answer": program, "options": [program] + school["degree_options"] + ["Undergraduate"], "assumed": False,
                    "pattern": r"^(what is )?(your )?current (degree|program)( program)?$|(what|which) (degree|degree program|program) are you (currently )?(enrolled in|pursuing|in)\b|^(current )?degree program$"})
    length = program_years(school)
    if length:
        # "How long is your degree program?": fall and spring semesters from the start to graduation, two to a year.
        text = f"{length:g} years"
        out.append({"key": "program_length", "answer": text, "options": [text, f"{length:g}"], "assumed": False,
                    "pattern": r"(how long|length|duration) (is |of )?(your )?(degree|program|course of study|studies|academic program)|(how many|number of) years? (is|will|does) your (degree|program)|years? (to|until you) (complete|finish) your (degree|program)"})
    if education and education[0].get("degree_options"):
        out.append({"key": "degree_after_graduating", "pattern": r"(level of education|degree).{0,40}(once|after|upon|when) (you.ve |you have |you )?(graduat|complet)",
                    "answer": education[0]["degree_options"][0], "options": education[0]["degree_options"], "assumed": False})
    if (profile.get("agreements_note") or "").strip():
        out.append({"key": "nda_signed", "pattern": r"(have|did) you (ever )?(signed|executed|entered|been party).{0,60}(non ?disclosure|\bnda\b|confidentiality)",
                    "answer": "Yes", "options": YES, "assumed": False})
    for key, pattern, answer, options, assumed, condition in PRESUMED:
        if condition and (profile.get(condition[0]) or "").strip().lower() != condition[1]:
            continue
        out.append({"key": key, "pattern": pattern, "answer": answer, "options": options, "assumed": assumed})
    field = ((education[0].get("field") if education else "") or "").lower()
    if re.search(r"comput|software|engineer|data|math|information", field):
        out.append({"key": "related_degree", "answer": "Yes", "options": YES, "assumed": False,
                    "pattern": r"(degree|major|majoring|studying|pursuing|enrolled).{0,100}(computer science|software engineering|computer engineering|related (technical |stem |engineering )?(field|discipline|major|degree))"})
    out.append({"key": "applied_before", "answer": "Yes" if applied_before else "No", "options": YES if applied_before else NO, "assumed": True,
                "pattern": r"(previously|ever|before|already) applied|applied (to|for|with|at|here) .{0,60}(before|previously|in the past|past \d+)|have you applied|or applied before"})
    months = experience_months(experience)
    years = months / 12
    label = "Less than 1 year" if years < 1 else f"{round(years)} year{'s' if round(years) != 1 else ''}"
    options = ([label, "Less than 1", "<1", "0 1", "Under 1 year", "0", "1"] if years < 1
               else [label, str(round(years)), f"{int(years)} {int(years) + 1}", f"{int(years)}+"])
    out.append({"key": "years_experience", "pattern": r"years of .{0,60}experience|how many years", "answer": label, "options": options,
                "number": str(1 if 6 <= months < 12 else round(years)), "assumed": True})
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
        # Ashby sometimes puts the organization's id, not its name, in the URL.
        return "" if re.fullmatch(r"[0-9a-f-]{20,}", slug) else slug
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


LEGAL_SUFFIX = r"(inc|incorporated|llc|l\.l\.c|ltd|limited|limited partnership|lp|l\.p|llp|corp|corporation|co|plc|gmbh|n\.a|s\.a)\.?$"
ENTITY_LABEL = r"^corp\b|corporate office|headquarters|\bhq\b|business unit|\bdivision\b"
SITE_WORDS = r"\b(external|internal|career|careers|campus|site|jobs?|university|students?|early|global|us|usa|en)\b"


INTRO_SKIP = {"at least", "at the", "at this", "at our", "at that", "at times", "at all", "at any", "at a", "at an", "at minimum", "at home", "at work", "at scale"}


def company_from_intro(text: str) -> str:
    """The company a posting names when it introduces itself: "At RTX, we...",
    "At HP IQ, our team..." (Workday listings often have no company field)."""
    text = (text or "")[:20000]
    for found in re.finditer(r"(?:^|[\n.!?]\s*)At ([A-Z][A-Za-z0-9&.'-]*(?: [A-Z][A-Za-z0-9&.'-]*){0,3}),\s", text):
        name = found.group(1).strip(" .")
        if f"at {name.split()[0].lower()}" not in INTRO_SKIP and len(re.findall(re.escape(name), text)) >= 2:
            return name
    # "HP IQ's AI Machine Learning team is building...", opening a paragraph.
    for found in re.finditer(r"(?:^|\n)\s*([A-Z][A-Za-z0-9&.-]*(?: [A-Z][A-Za-z0-9&.-]*){0,3})['’]s ", text):
        name = found.group(1).strip(" .")
        if name.split()[0].lower() not in {"the", "our", "this", "your", "we", "it", "that", "today"} and len(re.findall(re.escape(name), text)) >= 3:
            return name
    # "If selected for employment with Shield AI, ...", "a great fit at Shield AI".
    for found in re.finditer(r"\b(?:employment|career|careers|fit|working|work|role|position|join us|internship) (?:with|at) ([A-Z][A-Za-z0-9&-]*(?: [A-Z][A-Za-z0-9&-]*){0,2})", text):
        name = found.group(1).strip(" .")
        if len(re.findall(re.escape(name), text)) >= 3:
            return name
    return ""


def company_name(raw: str, url: str, text: str) -> str:
    """The name people know a company by. Workday reads it from a legal
    entity: "00100 LEIDOS, INC." → "Leidos", "1000 KLA Corporation" → "KLA",
    and "0090 CORP-Corporate Office" names no company at all, so the careers
    site's own name ("northrop_grumman_external_site") stands in for it."""
    raw = (raw or "").strip()
    name = re.sub(r"^\d{2,}\s*[-–]?\s*", "", raw)
    coded = name != raw
    # ", Inc." and ", Limited Partnership" go; "Example Corp" stays unless Workday's code came with it.
    suffix = (r",?\s+" if coded else r",\s*") + LEGAL_SUFFIX
    for _ in range(2):
        shorter = re.sub(suffix, "", name, flags=re.I).strip(" ,")
        name = shorter if len(shorter) >= 2 else name
    if not name or (coded and re.search(ENTITY_LABEL, name, re.I)):
        parts = urlparse(url or "")
        path = [p for p in parts.path.split("/") if p and not re.fullmatch(r"[a-z]{2}-[A-Z]{2}", p)]
        site = re.sub(SITE_WORDS, " ", re.sub(r"[_-]+", " ", path[0].lower())).strip() if "myworkdayjobs.com" in parts.netloc and path else ""
        for slug in (site, company_from_host(url)):
            letters = re.sub(r"[^a-z0-9]", "", slug)
            if len(letters) >= 3 and re.search(r"[\s\-.&']?".join(map(re.escape, letters)), text or "", re.I):
                return proper_name(slug, text)
        return company_from_intro(text) or name
    # "LEIDOS" as the posting writes it: "Leidos".
    if name.isupper() and len(name) > 4:
        found = re.search(re.escape(name), text or "", re.I)
        if found and not found.group(0).isupper():
            name = found.group(0)
    return name


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
        company = company_from_intro(text)
    if not company:
        company = proper_name(company_from_host(url), text)
    company = company_name(company, url, text)
    # A careers-site slug ("Externalcareersite", "Globalhr") the posting never uses isn't a name.
    if company and "myworkdayjobs.com" in url and company.lower() not in text.lower():
        company = company_from_intro(text) or company

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


def program_start(description: str, term: str = "", preferred: str = "") -> tuple[dict, str]:
    """When the internship or role starts: the user's preferred date for a summer or
    unnamed term (in that term's year), else the posting or its term ("Fall 2027"), else today."""
    text = description or ""
    wanted = parse_month_year(preferred)
    other_term = re.search(r"\b(spring|fall|autumn|winter)\b", term or "", re.I)
    if wanted and not other_term:
        year = re.search(r"\b(20\d{2})\b", term or "")
        return date_formats((int(year.group(1)) if year else wanted[0], wanted[1], wanted[2])), "your preferred start date"
    range_match = re.search(r"([A-Z][a-z]{2,8}\.? \d{1,2}(?:st|nd|rd|th)?,? 20\d{2})\s*(?:-|–|—|to|through)\s*[A-Z][a-z]{2,8}\.? \d{1,2}", text)
    if range_match:
        return date_formats(parse_month_year(range_match.group(1))), "the program dates in the posting"
    start_match = re.search(r"(?:start(?:s|ing)?(?: date)?|begins?|beginning)\s*(?:on|:|in)?\s*([A-Z][a-z]{2,8}\.? (?:\d{1,2}(?:st|nd|rd|th)?,? )?20\d{2})", text)
    if start_match:
        return date_formats(parse_month_year(start_match.group(1))), "the start date in the posting"
    season = re.search(r"\b(spring|summer|fall|autumn|winter)\s+(20\d{2})\b", term or "", re.I)
    if season:
        month = {"spring": 1, "summer": 6, "fall": 9, "autumn": 9, "winter": 1}[season.group(1).lower()]
        return date_formats((int(season.group(2)), month, 1)), f"the {season.group(1).lower()} {season.group(2)} term in the posting"
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
            out[0]["end"] = graduation or out[0]["end"]
        else:
            out.append({"school": profile.get("school", ""), "location": "", "degree": profile.get("degree", ""), "start": {}, "end": graduation})
    # No start date on the resume: Profile's "Started college" (a bare year is
    # that year's August), else the fall they started, from their year in
    # school (a first-year student in November 2026 started in August 2026).
    started = parse_month_year(profile.get("college_start", ""))
    if out and not out[0]["start"] and started:
        out[0]["start"] = date_formats((started[0], started[1] or 8, started[2]))
    years_in = {"freshman": 0, "sophomore": 1, "junior": 2, "senior": 3}.get((profile.get("class_year") or "").strip().lower())
    if out and not out[0]["start"] and years_in is not None:
        today = date.today()
        out[0]["start"] = date_formats(((today.year if today.month >= 8 else today.year - 1) - years_in, 8, None))
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


# ---------------------------------------------------------------------------
# Drafts for required short-answer questions

# Readable names for tailoring.THEMES, in the same order.
THEME_NAMES = ["data", "AI", "automation", "web interfaces", "backend systems", "cloud infrastructure", "embedded systems", "mobile apps"]
DRAFT_QUESTIONS = [
    ("cover", r"cover letter|letter of (interest|motivation)|motivation letter"),
    ("about", r"tell (us|me) (a (little|bit) )?(more )?about yourself|about yourself|introduce yourself|describe yourself|personal (summary|statement)|professional summary|brief (bio|introduction)|summary of (your )?(background|experience|qualifications)"),
    ("accomplishments", r"accomplishment|achievement|proud(est)? of|strongest (technical )?(work|project)|technical (experience|background|projects)|relevant (experience|projects)|what have you built"),
    ("project", r"(a|one|your) (favorite |recent |personal |side |technical |past )?project|something you('ve| have)? (built|made|created)"),
    ("availability", r"dates? of (internship |co.?op )?availability|availability dates|(start|end) dates? .{0,30}availab|availab\w* .{0,40}(start|end) dates?|when (are|will) you (be )?available"),
    ("plans", r"plans? (after|following|post) ?graduat|after (you )?graduat|career (goals|plans|aspirations)|where do you see yourself|long.term goals|what are your (career )?goals"),
    ("why", r"^(?!.*\b(development|programming|technolog\w*|frameworks?|languages?)\b).*(\bwhy\b.{0,60}(interest|want|work|join|apply|choose|chose|role|position|internship|company)|(what|that|which) (interests|interested|excites|excited|draws|drew|attracts|attracted|motivates|motivated) you|why are you interested)"),
]


def _join(items: list[str]) -> str:
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]


YEAR_WORDS = {"freshman": "first-year", "sophomore": "second-year", "junior": "third-year", "senior": "fourth-year"}
PAST_VERBS = {"built", "found", "wrote", "led", "ran", "made", "won", "taught", "grew", "cut", "set", "sent", "kept", "held", "drove", "took",
              "gave", "began", "chose", "spoke", "met", "got", "did", "saw", "brought", "sold", "read", "spent", "put", "rebuilt", "rewrote",
              "oversaw", "dealt", "drew", "ran", "shrank", "sped", "stood", "caught", "fought", "sought", "thought", "understood"}


def first_person(bullet: str) -> str:
    """A resume bullet as a plain sentence, in the resume's own words:
    "Built an API; added tests" → "I built an API and added tests."."""
    text = re.sub(r"\s+", " ", bullet or "").strip().rstrip(".")
    if not text:
        return ""
    first = text.split()[0]
    word = re.sub(r"[^a-z-]", "", first.lower())
    if re.match(r"team of\b", text, re.I):
        text = "My t" + text[1:]
    elif word in PAST_VERBS or re.search(r"[a-z]{2}ed$", word):
        text = f"I {first[0].lower()}{first[1:]}{text[len(first):]}"
    text = re.sub(r";\s+(?=[a-z])", " and ", text)
    return text if text[-1] in "?!”\"" else text + "."


def _lower_first(sentence: str) -> str:
    return sentence if sentence.startswith("I ") or sentence[:2].isupper() else sentence[:1].lower() + sentence[1:]


def story_entries(experience: list[dict], sections) -> list[dict]:
    """The user's jobs and projects as short first-person stories ("At Acme,
    I built ..."), made only of their resume's own lines, for essay drafts."""
    out = []
    for job in experience:
        lines = [first_person(line.lstrip("• ").strip()) for line in job["description"].splitlines() if line.strip()]
        if lines and job.get("company"):
            out.append({"name": job["company"], "kind": "job", "lead": f"At {job['company']}", "sentences": lines})
    for section in sections:
        if section["kind"] != "projects":
            continue
        for entry in section["entries"]:
            bullets = [b["text"] if isinstance(b, dict) else b for b in entry["bullets"]]
            name = re.split(r"\s+\|\s+|\s{3,}", entry["header"][0])[0].strip() if entry["header"] else ""
            if name and bullets:
                out.append({"name": name, "kind": "project", "lead": f"For my project {name}", "sentences": [first_person(b) for b in bullets]})
    for story in out:
        story["text"] = " ".join([f"{story['lead']}, {_lower_first(story['sentences'][0])}"] + story["sentences"][1:2])
    return out[:8]


def plain_title(title: str) -> str:
    """A posting's title the way you'd say it: "Summer 2027 - Software Engineer
    Intern" and "2027 Software Engineer Intern - Reston VA" → "Software Engineer Intern"."""
    text = re.sub(r"\(?\b(summer|fall|autumn|spring|winter)\s*(of\s*)?20\d{2}\)?|\b20\d{2}\b", " ", title or "", flags=re.I)
    parts = [part.strip(" ,-–()") for part in re.split(r"\s+[-–|]\s+", text) if part.strip(" ,-–()")]
    if len(parts) > 1 and parts[0].lower() in {"intern", "internship", "co-op"}:
        parts = [f"{parts[1]} Intern"]  # "Intern - Cloud Engineer"
    best = next((part for part in parts if re.search(TITLE_WORDS, part, re.I)), parts[0] if parts else "")
    return re.sub(r"\s+", " ", best).strip() or (title or "").strip()


def honor_lines(sections) -> list[str]:
    """Awards as the resume states them: "1st Place, Sponsor Track at VT Hacks"."""
    out = []
    for section in sections:
        if re.search(r"honor|award|competition|achievement|hackathon", section["title"], re.I):
            for entry in section["entries"]:
                lines = entry["header"][:1] or [b["text"] if isinstance(b, dict) else b for b in entry["bullets"][:1]]
                out += [re.sub(r"\s+\|\s+", " at ", line).strip().rstrip(".") for line in lines if line.strip()]
    return out[:3]


def drafts(profile: dict, education: list[dict], experience: list[dict], skills: list[str], role: dict | None, posting: str,
           stories: list[dict] | None = None, honors: list[str] | None = None) -> list[dict]:
    """Drafts for the questions that need writing ("why this role", "tell us
    about yourself", "your strongest accomplishments", a cover letter), in
    plain first person and built only from the user's profile, their resume's
    own lines, and the posting. The filler marks every one as a draft."""
    stories, honors = stories or [], honors or []
    school = (profile.get("school") or (education[0]["school"] if education else "")).strip()
    field = ((education[0].get("field") if education else "") or "computer science").lower()
    # Sentences say "May 2029", even when Profile has the exact day.
    graduation = re.sub(r"\b([A-Za-z]{3,9})\.? \d{1,2}(?:st|nd|rd|th)?,? (\d{4})\b", r"\1 \2", (profile.get("graduation") or "").strip())
    year = YEAR_WORDS.get((profile.get("class_year") or "").strip().lower(), "")
    me = f"I'm a {year + ' ' if year else ''}{field} student{f' at {school}' if school else ''}"
    goals = [g.strip() for g in re.split(r"[,;\n]", profile.get("career_goals", "")) if g.strip()][:2]
    themes = [name for (pattern, _), name in zip(tailoring.THEMES, THEME_NAMES) if re.search(pattern, posting or "", re.I)][:2]
    jobs = [story for story in stories if story["kind"] == "job"]
    projects = [story for story in stories if story["kind"] == "project"]
    title, company = plain_title((role or {}).get("title") or ""), (role or {}).get("company") or ""
    patterns = dict(DRAFT_QUESTIONS)
    out = []

    def add(key: str, text: str, short: str = ""):
        if text.strip():
            out.append({"key": key, "pattern": patterns[key], "text": text.strip(), "short": (short or text).strip()})

    focus = goals or themes
    add("plans", f"After I graduate{f' from {school}' if school else ''}{f' in {graduation}' if graduation else ''}, I want to work as a software engineer"
                 f"{f', ideally on {_join(focus)}' if focus else ''}. Between now and then I'm trying to get as much real experience as I can, "
                 "which is why I'm applying for internships like this one.")
    # Availability: the posting's own program dates, or the usual summer
    # break when it only names a summer term.
    dates = re.search(r"([A-Z][a-z]{2,8}\.? \d{1,2}(?:st|nd|rd|th)?,? 20\d{2})\s*(?:-|–|—|to|through)\s*([A-Z][a-z]{2,8}\.? \d{1,2}(?:st|nd|rd|th)?,? 20\d{2})", posting or "")
    term = listing_facts((role or {}).get("title") or "", posting or "", "")["term"]
    available = ""
    if dates:
        available = f"I'm available for the full program, {dates.group(1)} – {dates.group(2)}."
    elif term.startswith("Summer"):
        available = f"I'm available from mid-May {term.split()[1]} through mid-August {term.split()[1]}, after my spring semester ends."
    add("availability", available)

    # What I've done, in my resume's words: the current job first, then a project.
    work = f"{jobs[0]['lead']}, {_lower_first(jobs[0]['sentences'][0])}" if jobs else ""
    side = f"Outside of work, {_lower_first(projects[0]['sentences'][0])}" if projects and jobs else (projects[0]["text"] if projects else "")
    done = " ".join(part for part in (work, side) if part)
    # A reason only from the role's own title and the user's own work: a posting's passing mention isn't either.
    mine = [name for (pattern, _), name in zip(tailoring.THEMES, THEME_NAMES) if re.search(pattern, title or "", re.I) and re.search(pattern, done, re.I)][:2]
    reason = (f"the work is in {_join(mine)}, which is what I've spent most of my time on so far" if mine
              else "I want to spend my time building software that people actually use")
    if company:
        opening = f"{me}. I'm applying for the {title or 'open'} role at {company} because {reason}."
        closing = f"I'd like to keep doing that kind of work on a bigger team, and {company} looks like a good place to learn how."
        add("why", "\n\n".join(part for part in (opening, done, closing) if part), short=opening)
        letter = [f"Dear {company} Hiring Team,", opening, done,
                  " ".join(part for part in (f"I expect to graduate in {graduation}." if graduation else "", available) if part),
                  f"Thank you for reading. I'd be glad to talk more about the role.\n\n{profile.get('name', '').strip()}"]
        add("cover", "\n\n".join(part for part in letter if part.strip()))
    before = f"Before that I worked at {jobs[1]['name']}." if len(jobs) > 1 else ""
    now = (f"Right now I work at {jobs[0]['name']}, where {_lower_first(jobs[0]['sentences'][0])}" if jobs and experience and experience[0].get("current")
           else work)
    add("about", " ".join(part for part in (f"{me}{f', graduating in {graduation}' if graduation else ''}.", now, before, side) if part),
        short=f"{me}{f', graduating in {graduation}' if graduation else ''}.")
    # Strongest work: one short paragraph per job or project, then any award.
    proud = [story["text"] for story in (jobs[:1] + projects[:2] + jobs[1:2])[:3]]
    if honors:
        proud.append(f"I also earned {honors[0]}.")
    add("accomplishments", "\n\n".join(proud), short=proud[0] if proud else "")
    add("project", " ".join([projects[0]["text"]] + projects[0]["sentences"][2:3]) if projects else "")
    return out


# ---------------------------------------------------------------------------
# Questions for a model running on this Mac (Ollama). It sees only what's
# already on this computer, answers what the rules above couldn't, and every
# answer is checked here before the filler uses it.

MODEL_RULES = """You fill in a job application for one person. Use only the FACTS, RESUME, and JOB POSTING below. Reply with JSON only: one entry per question id.

Every question has a "kind". A question of kind "essay" must get a written answer in "answer" unless it asks whether the person has done something and the resume doesn't show it. Only that case, and the fact questions below, may be left empty.

FACT QUESTIONS (kinds "choice", "multi", and "text" about the person: GPA, licenses, clearances, memberships, dates, numbers, history):
- Answer only when the facts or resume state it. Otherwise leave "answer" empty and "choices" empty. Never guess.

PREFERENCE QUESTIONS (what they want, prefer, or are most interested in: a team, desk, area, location, shift):
- Always choose. Pick the option closest to the work on the resume and in the posting.

FORMAT:
- "choice": "answer" is one option copied exactly. "multi": "choices" lists each option that applies, copied exactly. "text": a few words.

ESSAYS are drafts the person will edit. Questions about interests, goals, reasons, or what they hope to learn are about what the person wants: tie the answer to the resume and the posting, and don't claim experience the resume lacks. A "have you done this" essay: if the resume shows it, say so and describe it in one to three sentences; if it doesn't, leave it empty. Write like a college student writing quickly and honestly, not like an AI:
- First person, 70 to 120 words, plain words, mostly short sentences. Start by answering the question directly.
- Use one or two specific things from the resume, and keep the resume's own wording for what was done. Do not upgrade it: "Team of 4 built" means "my team of 4 built", never "I led". Do not add results, numbers, tools, or feelings the resume doesn't state.
- End on a concrete detail. No closing sentence that sums up, sells, or says what the experience shows or taught.
- Never use: passionate, passion, leverage, excited, thrilled, delve, honed, stands out, aligns, journey, eager, confident, commitment, rigorous, fast-paced, cutting-edge, innovative, impactful, testament, I believe.
- No em dashes, semicolons, bullet points, headings, or questions. Do not flatter the company or repeat its mission."""
MODEL_SCHEMA = {"type": "object", "required": ["answers"], "properties": {"answers": {"type": "array", "items": {
    "type": "object", "required": ["id", "answer", "choices"],
    "properties": {"id": {"type": "integer"}, "answer": {"type": "string"}, "choices": {"type": "array", "items": {"type": "string"}}}}}}}
# Never put to a model: self-identification, IDs, contact details, other people, pay, GPA, consent.
MODEL_NEVER = NEVER + r"|linkedin|twitter|website|portfolio|github|\burl\b|e ?mail|phone|address|zip|postal|\bgpa\b|grade point|reference|emergency|agree|consent|certif|acknowledg"
ESSAY_TELLS = r"passion|leverag|excit|thrill|delv|\bhoned\b|stands? out|\balign|journey|\beager|confident|commitment|rigorous|fast.paced|cutting.edge|innovative|impactful|testament|i believe|resonat|leader in|industry.leading|world.class|renowned|prestigious|reputation"
# Sentences that sum up or sell ("These projects show my ability to ...").
ESSAY_CLOSERS = r"^(these|this|such|overall|ultimately|in (conclusion|short|summary)|all of this|together)\b.{0,60}\b(show|shows|showed|demonstrat\w+|reflect\w*|taught|teach\w*|help\w*|allow\w*|prepar\w+|ma(de|kes?) me|highlight\w*|prove\w*)\b"
# Words that claim more than a resume line may say; kept only when the resume uses them.
CLAIM_WORDS = r"\b(led|lead|leading|managed|founded|spearheaded|architected|pioneered|published|patented|president|captain|director|increased|reduced|improved|saved|grew|doubled|tripled|optimized|award.winning|expert|expertise|proficient|mastered|extensive)\b"


def model_questions(questions) -> list[dict]:
    """The questions a model may be asked: cleaned up, and never the ones in MODEL_NEVER."""
    out = []
    for item in (questions if isinstance(questions, list) else [])[:16]:
        if not isinstance(item, dict):
            continue
        question = re.sub(r"\s+", " ", str(item.get("question") or "")).strip()[:700]
        kind = item.get("kind") if item.get("kind") in {"essay", "text", "choice", "multi"} else ""
        options = [re.sub(r"\s+", " ", str(option)).strip()[:140] for option in (item.get("options") or [])[:40] if str(option).strip()]
        try:
            number = int(item.get("id"))
        except (TypeError, ValueError):
            continue
        if not question or not kind or re.search(MODEL_NEVER, question, re.I) or (kind in {"choice", "multi"} and len(options) < 2):
            continue
        out.append({"id": number, "kind": kind, "question": question, **({"options": options} if kind in {"choice", "multi"} else {})})
    return out


def model_prompt(facts: list[str], resume_text: str, posting: str, questions: list[dict]) -> str:
    return ("FACTS\n" + "\n".join(f"- {fact}" for fact in facts) + f"\n\nRESUME\n{resume_text[:6000]}\n\nJOB POSTING\n{(posting or 'Not available.')[:5000]}"
            + "\n\nQUESTIONS\n" + json.dumps(questions, indent=1, ensure_ascii=False))


def clean_essay(text: str, source: str, shortest: int = 25) -> str:
    """A model's draft with the sentences that give it away or overstate
    removed: stock phrases, closing lines that sell, numbers the user's own
    material doesn't contain, and claims ("led", "improved") the resume
    doesn't make. Empty when too little is left to be a draft."""
    # Dashes used as punctuation become commas; a range like "2007–2026" stays.
    text = re.sub(r"\s*—\s*|\s+–\s+", ", ", re.sub(r"\s+", " ", text or "")).replace(";", ",").strip().strip('"')
    text = re.sub(r"resonates (the )?most with me", "matters most to me", text, flags=re.I)
    known = source.lower()
    kept = []
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        lower = sentence.lower()
        if not sentence.strip() or sentence.rstrip().endswith("?") or re.search(ESSAY_TELLS, lower) or re.search(ESSAY_CLOSERS, lower):
            continue
        if any(number not in known for number in re.findall(r"\d[\d,.]*\d|\d", sentence)):
            continue
        if any(not re.search(rf"\b{re.escape(claim)}", known) for claim in re.findall(CLAIM_WORDS, lower)):
            continue
        kept.append(sentence.strip())
    result = " ".join(kept)
    return result if (len(kept) >= 2 or shortest < 25) and len(result.split()) >= shortest else ""


def check_answers(questions: list[dict], answers, source: str) -> list[dict]:
    """A model's answers, kept only when they pass: choices must be the
    form's own options, short answers must not carry a number or link the
    user's material doesn't, and essays go through clean_essay()."""
    asked = {question["id"]: question for question in questions}
    out = []
    for item in answers if isinstance(answers, list) else []:
        question = asked.get(item.get("id")) if isinstance(item, dict) else None
        if not question:
            continue
        answer = str(item.get("answer") or "").strip()
        choices = [str(choice).strip() for choice in (item.get("choices") or []) if str(choice).strip()]
        options = {re.sub(r"\W+", " ", option.lower()).strip(): option for option in question.get("options", [])}
        pick = lambda value: options.get(re.sub(r"\W+", " ", value.lower()).strip())
        if question["kind"] == "choice":
            # "Select your top three" on a one-answer field: its first pick.
            chosen = pick(answer) or next(filter(None, map(pick, choices)), None)
            if chosen:
                out.append({"id": question["id"], "answer": chosen, "choices": []})
        elif question["kind"] == "multi":
            chosen = [option for option in dict.fromkeys(filter(None, map(pick, choices or [answer])))]
            if chosen:
                out.append({"id": question["id"], "answer": "", "choices": chosen})
        elif question["kind"] == "essay":
            # "Have you built an app?" can be answered in a sentence.
            draft = clean_essay(answer, source, 10 if re.match(r"\s*(have|did|do|are|can)\b", question["question"], re.I) else 25)
            if draft:
                out.append({"id": question["id"], "answer": draft, "choices": []})
        elif answer and len(answer) <= 160 and not re.search(r"https?://|www\.|@", answer) \
                and all(number in source.lower() for number in re.findall(r"\d[\d,.]*\d|\d", answer)):
            out.append({"id": question["id"], "answer": answer.rstrip("."), "choices": []})
    return out


# ---------------------------------------------------------------------------
# Answers the listing itself gives

# (key, question pattern, fact): "Which position are you applying for?" and the like.
LISTING_QUESTIONS = [
    ("listing_position", r"(which|what) (position|job|role|opening)s? (are you )?(applying|interested)|position (title )?(you are |you're )?applying for|(job|position) (title )?applied for", "title"),
    ("listing_job_id", r"(job|requisition|req|posting) (id|number|#|no)|requisition", "job_id"),
    ("listing_term", r"(which|what) (term|season|semester|session)|(internship|co.?op) (term|session|period|season)|term (are you )?(applying|available|interested)", "term"),
    # "Are you interested in an Intern position or a Co-op position?", not "...during the internship or co-op?"
    ("listing_kind", r"(interested in|prefer|applying (for|to)|looking for|seeking|which|what type of).{0,30}\b(intern|co.?op)\w*.{0,50}\bor\b.{0,20}\b(co.?op|intern|full.?time|part.?time)", "kind"),
]


STATE_NAMES = "|".join(sorted((re.escape(name) for name in STATES.values()), key=len, reverse=True))


def listing_locations(title: str, description: str, url: str) -> list[str]:
    """Where the posting says the job is, most specific first: its own
    "Location" line, then every "City, ST" it names, then Workday's URL."""
    places: list[str] = []

    def add(place: str):
        place = re.sub(r",? (United States of America|United States|USA)$", "", re.sub(r"\s+", " ", place).strip(" ,.-"))
        if place and place.lower() not in [known.lower() for known in places]:
            places.append(place)

    state = rf"(?:{'|'.join(STATES)}|{STATE_NAMES})"
    text = f"{title}\n{description or ''}"
    for found in re.finditer(r"(?im)^\s*locations?\s*:?\s*\n+\s*(.{3,80})$", text):
        if re.search(rf",\s*{state}\b", found.group(1)):
            add(found.group(1))
    for found in re.finditer(rf"\b([A-Z][a-zA-Z.'-]+(?: [A-Z][a-zA-Z.'-]+){{0,2}}),\s*({state})\b", text):
        city = re.sub(r"^(?:(?:Also|In|At|The|Our|Located|Based|From|To|And|Or|Near|Location|Locations|Office|Offices|Intern|Internship) )+", "", found.group(1))
        add(f"{city}, {found.group(2)}")
    slug = re.search(r"/job/(?:US-+)?([A-Za-z-]+?)-+(" + "|".join(STATES) + r")/", unquote(url or ""))
    if slug and not places:
        add(f"{slug.group(1).replace('-', ' ')}, {slug.group(2)}")
    if re.search(r"\bremote\b", text, re.I):
        add("Remote")
    return places[:4]


def listing_pay(description: str) -> dict:
    """The pay the posting itself states: {"hourly": 55.0, "text": "$55 an hour"}
    (the middle of a range), or {"annual": ...}; empty when it states none."""
    text = description or ""
    amount = r"\$\s?(\d{2,3}(?:\.\d{1,2})?)"
    per_hour = r"\s*(?:/|per|an|a)\s*(?:hr|hour)"
    found = re.search(rf"{amount}\s*(?:-|–|—|to)\s*{amount}{per_hour}", text, re.I)
    if found:
        low, high = float(found.group(1)), float(found.group(2))
        return {"hourly": round((low + high) / 2, 2), "text": f"${low:g} an hour" if f"{low:g}" == f"{high:g}" else f"${low:g}–${high:g} an hour"}
    found = re.search(rf"{amount}{per_hour}", text, re.I)
    if found:
        return {"hourly": float(found.group(1)), "text": f"${float(found.group(1)):g} an hour"}
    found = re.search(r"\$\s?(\d{2,3}),(\d{3})(?:\.\d\d)?\s*(?:-|–|—|to)\s*\$\s?(\d{2,3}),(\d{3})", text)
    if found:
        low, high = int(found.group(1) + found.group(2)), int(found.group(3) + found.group(4))
        return {"annual": round((low + high) / 2), "text": f"${low:,}–${high:,} a year"}
    return {}


def listing_facts(title: str, description: str, url: str) -> dict:
    """What the posting says about itself: its title, requisition ID, term
    ("Summer 2027"), work locations ("Reston, VA", "Remote"), and pay."""
    text = f"{title}\n{description}"
    term = re.search(r"\b(summer|fall|autumn|spring|winter)\s*(?:of\s*)?(20\d{2})\b", text, re.I)
    job_id = (re.search(r"_((?:R|JR|REQ)-?\d{4,}(?:-\d+)?)(?:$|[/?#])", url or "")
              or re.search(r"(?:job|requisition|req|posting)\s*(?:id|#|number|no\.?)\s*[:#]?\s*([A-Z]{0,4}-?\d{4,}(?:-\d+)?)", text, re.I))
    kind = "Co-op" if re.search(r"\bco.?op\b", title or "", re.I) else "Intern" if re.search(r"\bintern", title or "", re.I) else ""
    if not term and kind == "Intern":
        # An internship that names no term is a summer one: the coming summer.
        today = date.today()
        term = re.match(r"(summer)\s*(\d{4})", f"summer {today.year + (1 if today.month >= 6 else 0)}", re.I)
    return {"title": title or "", "kind": kind, "term": f"{term.group(1).title()} {term.group(2)}" if term else "",
            "job_id": job_id.group(1) if job_id else "", "locations": listing_locations(title, description, url),
            "pay": listing_pay(description)}


# ---------- One role per posting ----------
APPLY_STEPS = r"/(apply|application|applymanually|usemylastapplication|autofillwithresume)(/.*)?$"
ID_PARAMS = {"gh_jid", "jobid", "job_id", "jid", "pid", "id", "req", "reqid", "requisitionid", "postingid"}
JOB_BOARDS = r"linkedin\.|indeed\.|handshake\.|glassdoor\.|ziprecruiter\.|simplify\.jobs|wellfound\.|builtin\.|github\.|dice\.|levels\.fyi|workatastartup\.|google\."
COMPANY_FILLER = {"inc", "llc", "ltd", "corp", "corporation", "corporate", "company", "office", "the", "group", "holdings",
                  "limited", "partnership", "technologies", "technology", "labs", "systems", "international", "global"}


def posting_key(url: str) -> str:
    """The same key for every way a posting's URL is written: Workday adds a
    locale (/en-US/), writes "Arlington, VA" as "Arlington%2C-VA" or
    "Arlington-VA", and puts the application steps under the listing."""
    parts = urlparse(url or "")
    host = parts.netloc.lower().removeprefix("www.")
    if not host:
        return ""
    path = re.sub(r"^/[a-z]{2}-[a-z]{2}(?=/)", "", unquote(parts.path).lower().rstrip("/"))
    path = re.sub(APPLY_STEPS, "", path)
    workday = re.search(r"/job/(?:.*/)?[^/]*_([a-z]*-?\d[\w-]*)$", path)
    if "myworkdayjobs.com" in host and workday:
        return f"{host}|{workday.group(1)}"  # the requisition: ..._R-00195980
    ids = sorted(f"{key.lower()}={value}" for key, value in parse_qsl(parts.query) if key.lower() in ID_PARAMS)
    return f"{host}|{re.sub(r'[^a-z0-9/]', '', path)}|{'&'.join(ids)}"


def same_posting(a: dict, b: dict) -> bool:
    """Two saved roles are one posting: the same URL however written, or the
    same title and text found on two sites (a job board and the company's
    page). Two openings on one site with their own URLs stay apart."""
    key_a, key_b = posting_key(a.get("url", "")), posting_key(b.get("url", ""))
    if key_a and key_a == key_b:
        return True
    if key_a and key_b and key_a.split("|")[0] == key_b.split("|")[0]:
        return False
    if re.sub(r"\W+", " ", (a.get("title") or "").lower()).strip() != re.sub(r"\W+", " ", (b.get("title") or "").lower()).strip():
        return False
    ids = [listing_facts("", item.get("description", ""), item.get("url", ""))["job_id"].upper() for item in (a, b)]
    if all(ids) and ids[0] != ids[1]:
        return False
    words = [set(re.findall(r"[a-z]{4,}", (item.get("description") or "").lower())) for item in (a, b)]
    return min(map(len, words)) >= 40 and len(words[0] & words[1]) >= 0.9 * min(map(len, words))


def better_url(saved: str, new: str) -> str:
    """The URL a role keeps: the company's own posting over a job board's."""
    board = lambda url: bool(re.search(JOB_BOARDS, urlparse(url or "").netloc.lower()))
    return new if new and (not saved or (board(saved) and not board(new))) else saved


def company_word(company: str) -> str:
    """The distinctive word of a company name: "00100 ACME, INC." → "acme"."""
    return next((word for word in re.findall(r"[a-z][a-z0-9]{2,}", (company or "").lower()) if word not in COMPANY_FILLER), "")


def page_belongs(role: dict, page_url: str) -> bool:
    """Whether an application page can belong to a saved role: the same site,
    a listing found on a job board, or the company's own site. A different
    company's form (another site after a Workday listing)
    never gets that role's resume."""
    host = urlparse(page_url or "").netloc.lower()
    role_host = urlparse(role.get("url") or "").netloc.lower()
    if not host:
        return False
    if role_host and (role_host == host or re.search(JOB_BOARDS, role_host)):
        return True
    word = company_word(role.get("company", ""))
    return bool(word) and word in host


def listing_answers(facts: dict) -> list[dict]:
    out = []
    for key, pattern, fact in LISTING_QUESTIONS:
        value = facts.get(fact, "")
        if value:
            out.append({"key": key, "pattern": pattern, "answer": value, "options": [value] + ([value.split()[0]] if fact == "term" else [])})
    return out
