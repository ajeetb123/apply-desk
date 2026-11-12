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
