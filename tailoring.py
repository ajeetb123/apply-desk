"""How a resume is tuned for one kind of job, and the technology names it knows.

Tuning only puts things in order: the posting picks the job type (frontend,
backend, ML...), and that type orders the skills and projects, most important
first. No line is reworded, nothing is added, and experience keeps the
resume's own order. Rule sources are listed in README.md ("Resume-writing choices").
"""
from __future__ import annotations

import re

# Spellings of the same technology, so "Postgres" in a resume and "PostgreSQL"
# in a posting count as one skill.
SPELLINGS = [
    ["PostgreSQL", "Postgres", "Postgresql"],
    ["JavaScript", "JS"],
    ["TypeScript", "TS"],
    ["Node.js", "NodeJS", "Nodejs", "Node JS"],
    ["React", "React.js", "ReactJS"],
    ["Vue.js", "VueJS", "Vue"],
    ["Next.js", "NextJS"],
    ["Express.js", "ExpressJS"],
    ["Kubernetes", "K8s", "k8s"],
    ["CI/CD", "CICD"],
    ["MongoDB", "Mongo"],
    ["GitHub", "Github"],
    ["GitLab", "Gitlab"],
    ["GitHub Actions", "Github Actions"],
    ["GraphQL"],
    ["PyTorch"],
    ["TensorFlow"],
    ["scikit-learn", "sklearn"],
    ["NumPy"],
    ["pandas"],
    ["FastAPI", "Fast API"],
    ["Spring Boot", "SpringBoot"],
    ["Tailwind CSS", "TailwindCSS"],
    ["Amazon Web Services", "AWS"],
    ["Google Cloud Platform", "GCP", "Google Cloud"],
    ["Microsoft Azure", "Azure"],
    ["C#", "C Sharp"],
    ["macOS", "Mac OS", "OS X"],
    ["MySQL"],
    ["DynamoDB", "Dynamo DB"],
    ["SQL Server", "MSSQL", "MS SQL"],
    ["Redis"],
    ["Docker"],
    ["Terraform"],
    ["Jenkins"],
    ["Kafka", "Apache Kafka"],
    ["Spark", "Apache Spark"],
    ["Airflow", "Apache Airflow"],
    ["OpenCV"],
    ["gRPC", "GRPC"],
    ["REST API", "RESTful API"],
    ["REST APIs", "RESTful APIs"],
    ["Linux"],
    ["Bash"],
    ["HTML/CSS"],
    ["Java"],
    ["Python"],
    ["Rust"],
    ["Kotlin"],
    ["Swift"],
    ["SwiftUI"],
    ["Django"],
    ["Flask"],
    ["Angular"],
    ["Snowflake"],
    ["Jira", "JIRA"],
]

# Technology names by kind, for finding tools named in a resume.
LANGUAGES = {"python", "java", "c", "c++", "c#", "go", "golang", "rust", "javascript", "typescript", "sql", "kotlin", "swift",
             "ruby", "php", "scala", "r", "bash", "shell", "html", "css", "html/css", "matlab", "dart", "haskell", "lua", "perl",
             "objective-c", "solidity", "verilog", "vhdl", "assembly", "elixir", "julia"}
FRAMEWORKS = {"react", "angular", "vue.js", "next.js", "node.js", "express.js", "django", "flask", "fastapi", "spring", "spring boot",
              ".net", "asp.net", "rails", "ruby on rails", "pytorch", "tensorflow", "keras", "jax", "junit", "pytest", "jest",
              "tailwind css", "svelte", "flutter", "react native", "swiftui", "laravel", "material-ui", "bootstrap"}
LIBRARIES = {"pandas", "numpy", "matplotlib", "scikit-learn", "opencv", "langchain", "hugging face", "transformers", "seaborn",
             "scipy", "pydantic", "sqlalchemy"}

# When a posting names no tools, its themes still say which skills matter.
THEMES = [
    (r"\bdata\b|analytics|reporting|dashboard|power bi|tableau|\bbi\b|insight|statistic",
     {"python", "sql", "pandas", "numpy", "statsmodels", "r", "excel", "power bi", "tableau", "postgresql", "mysql", "matplotlib", "scipy", "spark"}),
    (r"\bai\b|artificial intelligence|machine learning|\bml\b|\bllm|agent|model|neural|deep learning",
     {"python", "pytorch", "tensorflow", "scikit-learn", "pandas", "numpy", "langchain", "hugging face", "transformers", "statsmodels", "jax"}),
    (r"automat|scripting|workflow|tooling|internal tools",
     {"python", "bash", "shell", "github actions", "pytest", "docker", "jenkins"}),
    (r"front ?end|web app|user interface|\bui\b|full ?stack|browser",
     {"javascript", "typescript", "react", "node.js", "html/css", "html", "css", "next.js", "vue.js", "vite", "tailwind css"}),
    (r"back ?end|\bapis?\b|microservices|web services|server[- ]side|databases?\b|distributed systems",
     {"java", "go", "python", "node.js", "express", "sql", "postgresql", "redis", "docker", "spring boot", "flask", "fastapi", "supabase"}),
    (r"cloud|devops|infrastructure|deploy|kubernetes|aws|azure|gcp",
     {"docker", "kubernetes", "terraform", "amazon web services", "aws", "google cloud platform", "microsoft azure", "linux", "github actions"}),
    (r"embedded|firmware|hardware|real-time|rtos|microcontroller",
     {"c", "c++", "rust", "assembly", "python", "linux", "verilog"}),
    (r"mobile|ios|android", {"swift", "swiftui", "kotlin", "java", "react native", "flutter"}),
]


def skill_relevance(skill: str, posting: str) -> float:
    """Lower is more relevant: 0 named in the posting, about 1 fits its themes
    (the more themes, the lower), 2 a language, 3 anything else."""
    rules = Rules(posting, [])
    if rules.mentions(posting, skill):
        return 0
    name = skill.lower()
    lower = posting.lower()
    themes = sum(1 for pattern, skills in THEMES if name in skills and re.search(pattern, lower))
    if themes:
        return 1 - themes / 10
    return 2 if name in LANGUAGES else 3


def case_sensitive(variant: str) -> bool:
    # Acronyms ("JS", "AWS") and capitalized single words ("React", "Swift",
    # "Flask") only count as technology names when written that way, so
    # "react quickly" or a lab "flask" never match.
    return (len(variant) <= 4 and variant.isupper()) or (variant.isalpha() and variant[0].isupper() and variant[1:].islower())


def names_pattern(names) -> re.Pattern:
    # Longest first so "Google Cloud Platform" wins over "Google Cloud", with
    # boundaries that respect names like "Node.js", "C#", and "CI/CD".
    parts = [re.escape(name) if case_sensitive(name) else f"(?i:{re.escape(name)})" for name in sorted(names, key=len, reverse=True)]
    return re.compile(r"(?<![\w.+#/-])(?:" + "|".join(parts) + r")(?![\w+#/]|\.\w)")


GROUPS = [(group, names_pattern(group)) for group in SPELLINGS]


def group_for(skill: str):
    return next((entry for entry in GROUPS if any(name.lower() == skill.lower() for name in entry[0])), None)


class Rules:
    """What a posting names."""

    def __init__(self, posting: str, declared_skills: list[str] | None = None):
        self.posting = posting

    def mentions(self, text: str, skill: str) -> bool:
        entry = group_for(skill)
        pattern = entry[1] if entry else names_pattern([skill])
        return bool(pattern.search(text))


# ---------------------------------------------------------------------------
# Tailoring by job type: like keeping a frontend, a backend, and an ML version
# of one resume. The posting picks the type, and the type puts the skills and
# projects in order, most important first. Nothing is reworded or added, and
# experience keeps the resume's own order.

# (type, title pattern, skills most important first, project words)
JOB_TYPES = [
    ("mobile", r"\b(ios|android|mobile)\b",
     ["swift", "swiftui", "kotlin", "java", "objective-c", "react native", "flutter", "dart", "typescript", "javascript", "react", "firebase", "sql", "git"],
     r"\b(ios|android|mobile|app store|swift|kotlin)\b"),
    ("ml", r"machine learning|\bml\b|\bai\b|artificial intelligence|deep learning|\bllms?\b|computer vision|\bnlp\b|data scien|(applied|research) scien",
     ["python", "pytorch", "tensorflow", "scikit-learn", "jax", "keras", "pandas", "numpy", "statsmodels", "scipy", "langchain", "hugging face",
      "transformers", "opencv", "sql", "r", "matlab", "fastapi", "pytest", "jupyter", "yfinance", "java", "c++"],
     r"\b(models?|machine learning|ml|ai|llms?|agents?|eval\w*|predict\w*|train\w*|neural|regression|classif\w*|statistic\w*|signal)\b"),
    ("data", r"\bdata\b|analytics|\banalyst\b|business intelligence",
     ["python", "sql", "pandas", "numpy", "statsmodels", "r", "excel", "tableau", "power bi", "postgresql", "mysql", "spark", "airflow",
      "snowflake", "scipy", "matplotlib", "yfinance", "jupyter"],
     r"\b(data|datasets?|analy\w+|statistic\w*|sql|dashboards?|reports?|correlation\w*|regression)\b"),
    ("fullstack", r"full[ -]?stack",
     ["typescript", "javascript", "react", "next.js", "node.js", "express", "python", "fastapi", "django", "flask", "sql", "postgresql",
      "supabase", "mongodb", "html/css", "vite", "docker", "git"],
     r"\b(web app|frontend|front end|backend|back end|apis?|database|full stack|react|express)\b"),
    ("frontend", r"front[ -]?end|\bui\b|\bux\b|web (developer|engineer)|user interface",
     ["typescript", "javascript", "react", "next.js", "vue.js", "angular", "html/css", "html", "css", "tailwind css", "vite", "node.js",
      "express", "mapbox", "deck.gl", "figma", "jest", "git"],
     r"\b(web app|frontend|front end|ui|interface|react|maps?|render\w*|browser|vite)\b"),
    ("backend", r"back[ -]?end|\bapis?\b|platform|infrastructure|distributed|server|cloud|devops|\bsre\b|site reliability",
     ["python", "java", "go", "c#", "sql", "postgresql", "mysql", "fastapi", "flask", "django", "spring boot", "node.js", "express", "typescript",
      "javascript", "supabase", "redis", "docker", "kubernetes", "aws", "git", "pytest", "unittest", "linux"],
     r"\b(apis?|endpoints?|servers?|database|backend|back end|services?|schema|postgres\w*|express|fastapi|json)\b"),
    ("systems", r"embedded|firmware|\bsystems?\b|hardware|kernel|robotics|\brtos\b",
     ["c", "c++", "rust", "assembly", "python", "java", "linux", "bash", "git", "matlab", "verilog"],
     r"\b(embedded|firmware|hardware|kernel|memory|performance|real.time|c\+\+)\b"),
]
TYPE_NAMES = {"mobile": "mobile", "ml": "machine learning and AI", "data": "data", "fullstack": "full-stack", "frontend": "frontend",
              "backend": "backend", "systems": "systems", "general": "general software engineering"}


def skill_key(name: str) -> str:
    """One spelling per skill: "Express.js" and "Express", "Postgres" and "PostgreSQL" match."""
    entry = group_for(name.strip())
    key = re.sub(r"[^a-z0-9+#]", "", (entry[0][0] if entry else name).lower())
    return "postgresql" if key == "postgres" else re.sub(r"^(.{2,})js$", r"\1", key)


def job_type(title: str, description: str = "") -> str:
    """The kind of job: the title decides when it names one, else the posting's
    most frequent kind (named at least twice), else general."""
    for kind, pattern, _, _ in JOB_TYPES:
        if re.search(pattern, title or "", re.I):
            return kind
    counts = [(len(re.findall(pattern, description or "", re.I)), -i, kind) for i, (kind, pattern, _, _) in enumerate(JOB_TYPES)]
    hits, _, kind = max(counts)
    return kind if hits >= 2 else "general"


def type_rank(skill: str, kind: str) -> int:
    ranked = next((skills for name, _, skills, _ in JOB_TYPES if name == kind), [])
    keys = [skill_key(name) for name in ranked]
    key = skill_key(skill)
    return keys.index(key) if key in keys else len(keys)


def order_skills(items: list[str], kind: str, posting: str) -> list[str]:
    """Most important first for this kind of job; the posting's own skills
    break ties, then the resume's order."""
    rules = Rules(posting, [])
    return [item for _, item in sorted(enumerate(items), key=lambda pair: (
        type_rank(pair[1], kind), 0 if posting and rules.mentions(posting, re.sub(r"\s*\(.*?\)", "", pair[1]).strip() or pair[1]) else 1, pair[0]))]


def project_score(text: str, kind: str, posting_terms: list[str]) -> float:
    """How much one project shows this kind of work: the kind of work it
    describes and the posting's own terms count most, then the type's skills
    it uses (the more important, the more; capped, so a long tech list alone
    can't win)."""
    spec = next((entry for entry in JOB_TYPES if entry[0] == kind), None)
    score = 0.0
    if spec:
        _, _, skills, words = spec
        used = sum(2 * (len(skills) - rank) / len(skills) for rank, skill in enumerate(skills)
                   if Rules("").mentions(text, skill) or (skill == "postgresql" and re.search(r"postgres", text, re.I)))
        score += min(used, 4)
        # "predict" and "predictive" are one kind of work.
        score += 1.5 * len({match.lower()[:5] for match in re.findall(words, text, re.I)})
    lower = text.lower()
    score += sum(1 for term in posting_terms if re.search(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])", lower))
    return score


# Tools named in a resume's projects and bullets that count as skills for a
# form's skills field (the Skills section's own items always count).
EXTRA_TOOLS = ["Excel", "Vite", "Mapbox", "deck.gl", "Supabase", "yfinance", "statsmodels", "unittest", "pytest", "Tableau", "Power BI",
               "Figma", "Firebase", "Vercel", "Jupyter", "LaTeX", "Postman", "Selenium", "Playwright", "Jest", "Next.js", "Express",
               "SQL", "Pandas", "NumPy", "Matplotlib", "SciPy", "OpenCV", "Swift", "Kotlin", "C++", "HTML", "CSS", "Spring Boot"]


# Names that are also everyday words ("swift delivery", "bootstrap a team")
# count only in the Skills section or a project's tech list.
EVERYDAY = {"swift", "rust", "go", "golang", "dart", "shell", "assembly", "spring", "bootstrap", "flutter", "julia", "rails", "ruby", "perl",
            "elixir", "scala", "lua", "haskell", "r", "c", "jax", "solidity"}


def known_tools() -> list[str]:
    """Tool names to look for in a resume's text, one spelling each."""
    names = {}
    for name in [group[0] for group in SPELLINGS] + EXTRA_TOOLS + sorted(LANGUAGES | FRAMEWORKS | LIBRARIES):
        if name.lower() not in EVERYDAY and len(name) > 1:
            names.setdefault(name.lower(), name)
    return list(names.values())


# ---------------------------------------------------------------------------
# A posting's skills, matched to the user's work. Each skill is either named on
# the resume, shown by an experience or project without being named (believable:
# "REST APIs" from an Express API), or not shown at all (AWS with no cloud work):
# only shown ones may be added, at most two, to the entry that shows them best.

# (name, how a posting asks for it, how a resume names it, what on a resume shows
#  it, category for the Skills section, weight: core skills 1, softer ones less).
# Only LISTABLE ones are ever added (to a Skills line): the rest read oddly in a
# skills list ("Debugging") and are only shown on the role page.
CONCEPTS = [
    ("REST APIs", r"(?-i:\bREST(ful)?\b)|\brestful\b|\bweb (apis?|services)\b", r"(?-i:\bREST(ful)?\b)|\brestful\b", r"\bapis?\b|endpoints?\b|\bexpress\b|fastapi|flask|django|spring boot|\bhttp\b", "tools", 1),
    ("Unit testing", r"unit test|automated test|test.driven|\btdd\b|testing frameworks?", r"unit test", r"pytest|unittest|\bjest\b|junit|unit tests?|test (cases|suites?)", "tools", 1),
    ("SQL", r"\bsql\b|relational databases?", r"\bsql\b", r"postgres|mysql|sqlite|supabase|sql server", "languages", 1),
    ("Data analysis", r"data analy|analy[sz]e (large )?data|analytics", r"data analy", r"pandas|statsmodels|numpy|analy[sz]ed|correlation|regression", "tools", 1),
    ("Statistics", r"statistic", r"statistic", r"statsmodels|regression|permutation tests?|hypothesis|correlation", "tools", 0.8),
    ("Machine learning", r"machine learning|\bml\b", r"machine learning", r"pytorch|tensorflow|scikit|keras|neural|trained (a |the )?models?|classifiers?", "tools", 1),
    ("LLMs", r"\bllms?\b|large language models?|generative ai|\bgen ?ai\b", r"\bllms?\b|language models?", r"\bgpt\b|prompts?|\bagents?\b|tool.calling", "tools", 1),
    ("AI agents", r"\bai agents?\b|agentic|\bagents?\b", r"\bagents?\b", r"tool.calling|\bllms?\b", "tools", 0.8),
    ("Data visualization", r"visuali[sz]|dashboards?", r"visuali[sz]", r"dashboards?|charts?|plots?|matplotlib|\bd3\b|deck\.gl|mapbox|rendered", "tools", 0.8),
    ("Front-end development", r"front.?end|user interfaces?", r"front.?end", r"\breact\b|\bvue\b|angular|\bvite\b|\bhtml\b|\bcss\b|web app", "tools", 0.8),
    ("Back-end development", r"back.?end|server.side", r"back.?end", r"\bexpress\b|fastapi|flask|django|spring|\bapis?\b|endpoints?\b", "tools", 0.8),
    ("Debugging", r"debug|troubleshoot", r"debug", r"\bbugs?\b|troubleshoot|\bfixed\b", "tools", 0.5),
    ("Object-oriented programming", r"object.oriented|\boop\b", r"object.oriented", r"software design|\bclasses\b|\bjava\b|c\+\+|c#", "tools", 0.8),
    ("Data structures and algorithms", r"data structures|algorithms", r"data structures|algorithms", r"data structures|algorithms", "tools", 0.8),
    ("CI/CD", r"ci/?cd|continuous (integration|delivery|deployment)|github actions|jenkins", r"ci/?cd|continuous integration", r"github actions|jenkins|pipelines?", "tools", 1),
    ("Agile", r"\bagile\b|\bscrum\b", r"\bagile\b|\bscrum\b", r"sprints?|stand.?ups?", "tools", 0.5),
    ("Geospatial data", r"geospatial|\bgis\b|mapping", r"geospatial|\bgis\b", r"mapbox|geocod|\bmaps?\b", "tools", 0.8),
    ("3D graphics", r"\b3d\b|computer graphics|rendering", r"\b3d\b", r"meshe?s?\b|deck\.gl|three\.js|rendered", "tools", 0.8),
    ("JSON", r"\bjson\b", r"\bjson\b", r"\bjson\b", "tools", 0.5),
    ("Technical writing", r"technical writing|documentation", r"technical writing", r"\barticle\b|documented|co.authored|published", "tools", 0.5),
]
# Tools a posting names that the resume shows through another tool.
LISTABLE = {"REST APIs", "Unit testing", "SQL", "Data analysis", "Statistics", "Machine learning", "LLMs", "Data visualization",
            "Object-oriented programming", "Data structures and algorithms", "CI/CD", "Agile"}
RELATED = {"github": r"\bgit\b|github\.com", "javascript": r"typescript|\breact\b|\bexpress\b|node", "node.js": r"\bexpress\b", "postgresql": r"supabase|postgres",
           "html": r"\breact\b|\bvite\b", "css": r"\breact\b|tailwind", "html/css": r"\breact\b|\bvite\b", "numpy": r"pandas",
           "typescript": r"\bangular\b"}

# Posting sections: requirements count most, preferred skills next, the rest once.
REQUIRED = re.compile(r"basic qualif|minimum qualif|required qualif|requirements|qualifications you must|must have|you must|what we.re looking for|"
                      r"what you.ll (need|bring)|who you are|you have|top skills|qualifications:?$", re.I)
PREFERRED = re.compile(r"prefer|nice to have|bonus|pluses|\bplus\b|would be (awesome|great|nice)|desired|ideal", re.I)
DUTIES = re.compile(r"what you.ll do|what you will (do|learn)|responsibilit|about the (role|job|team)|day to day|benefits|perks|about us", re.I)


def posting_sections(title: str, description: str) -> list[tuple[str, str]]:
    """The posting in pieces with how much each counts: ("title" | "required" | "preferred" | "other", text)."""
    out, current = [("title", title or "")], "other"
    for line in (description or "").splitlines():
        text = line.strip()
        if not text:
            continue
        heading = len(text) <= 70 and not text.endswith(".") and len(text.split()) <= 9
        if heading and PREFERRED.search(text):
            current = "preferred"
        elif heading and REQUIRED.search(text):
            current = "required"
        elif heading and DUTIES.search(text):
            current = "other"
        out.append((current, text))
    return out


SECTION_WEIGHT = {"title": 3, "required": 3, "preferred": 2, "other": 1}


def posting_skills(title: str, description: str) -> list[dict]:
    """Every skill the posting asks for, most important first: where it's asked
    ("required", "preferred", "mentioned") and a score from how often and where."""
    sections = posting_sections(title, description)
    found: dict[str, dict] = {}

    def note(name, kind, category, weight, named, shows, spelled=False):
        for section, text in sections:
            text = split_slashes(text)
            seen = re.findall(kind, text, re.I) if isinstance(kind, str) else [m.group(0) for m in kind.finditer(text)]
            if not seen:
                continue
            hits = len(seen)
            # A tool goes by the posting's own spelling ("AWS", not "Amazon Web Services").
            item = found.setdefault(skill_key(name), {"name": seen[0] if spelled and isinstance(seen[0], str) else name, "score": 0.0,
                                                      "asked": "mentioned", "category": category, "named": named, "shows": shows,
                                                      "tool": spelled, "listable": spelled or name in LISTABLE})
            item["score"] += SECTION_WEIGHT[section] * weight * min(hits, 2)
            rank = {"mentioned": 0, "preferred": 1, "required": 2}
            asked = "required" if section in {"required", "title"} else "preferred" if section == "preferred" else "mentioned"
            if rank[asked] > rank[item["asked"]]:
                item["asked"] = asked

    for name, asks, named, shows, category, weight in CONCEPTS:
        note(name, asks, category, weight, named, shows)
    for tool in known_tools():
        if skill_key(tool) in found:
            continue
        entry = group_for(tool)
        pattern = entry[1] if entry else names_pattern([tool])
        lower = tool.lower()
        category = "languages" if lower in LANGUAGES else "frameworks" if lower in FRAMEWORKS | LIBRARIES else "tools"
        note(tool, pattern, category, 1, pattern, RELATED.get(lower), spelled=True)
    return sorted(found.values(), key=lambda item: -item["score"])


SLASH_NAMES = {"ci/cd", "html/css", "tcp/ip", "i/o", "ui/ux", "a/b"}


def split_slashes(text: str) -> str:
    """"Python/FastAPI" and "React/Vite" name two tools each; "CI/CD" is one name."""
    return re.sub(r"[\w.+#]+(?:/[\w.+#]+)+", lambda m: m.group(0) if m.group(0).lower() in SLASH_NAMES else m.group(0).replace("/", " / "), text or "")


def _matches(pattern, text: str) -> list[str]:
    if not pattern:
        return []
    if isinstance(pattern, str):
        return [m.group(0) for m in re.finditer(pattern, text, re.I)]
    return [m.group(0) for m in pattern.finditer(text)]


def match_skills(skills: list[dict], entries: list[dict], resume_text: str) -> list[dict]:
    """Each posting skill with its best entry ({label, kind, text}) and status:
    "named" (the resume says it), "shown" (an entry shows it without naming it;
    believable to add), or "missing" (nothing shows it; never added)."""
    out = []
    entries = [{**entry, "text": split_slashes(entry["text"])} for entry in entries]
    resume_text = split_slashes(resume_text)
    for skill in skills:
        best, best_score, how = None, 0.0, ""
        for entry in entries:
            named = _matches(skill["named"], entry["text"])
            shows = _matches(skill["shows"], entry["text"])
            score = 3 * len(named) + len({s.lower() for s in shows}) + {"projects": 0.5, "skills": -0.5}.get(entry["kind"], 0)
            if (named or shows) and score > best_score:
                best, best_score, how = entry, score, (named or shows)[0]
        named_anywhere = bool(_matches(skill["named"], resume_text))
        status = "named" if named_anywhere else "shown" if best else "missing"
        out.append({**{k: skill[k] for k in ("name", "score", "asked", "category", "tool", "listable")}, "status": status,
                    "entry": best["label"] if best else "", "entry_kind": best["kind"] if best else "", "evidence": how})
    return out


def skills_to_add(matches: list[dict], limit: int = 2) -> list[dict]:
    """The most important skills the posting asks for that the user's work shows
    but the resume never names: at most `limit`, only ones that belong in a
    skills list, and only ones asked for in the requirements or preferred
    skills, or mentioned more than once."""
    return [m for m in matches if m["status"] == "shown" and m["listable"] and (m["asked"] != "mentioned" or m["score"] >= 2)][:limit]
