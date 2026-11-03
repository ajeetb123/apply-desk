"""Light-touch, truthful wording and skills edits for a role-tuned resume.

Every edit keeps the user's facts. It mirrors the posting's spelling of a
technology the resume already names, fixes weak openers, keeps bullet
punctuation consistent, spells out title abbreviations, and adds a skill to
the skills section only when the user listed it in their own profile. The
layout and section structure are never touched. Rule sources are listed in
README.md ("Resume-writing choices").
"""
from __future__ import annotations

import re

# Spellings of the same technology. When the posting uses one, the resume uses
# the same one, because ATS keyword matching is often literal. Entries that
# differ only by letter case are always fixed to the first spelling.
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

# Where an added skill goes in Jake's "Technical Skills" block.
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


# Gerunds that follow "Responsible for" and their past-tense verbs.
PAST = {"building": "Built", "developing": "Developed", "designing": "Designed", "creating": "Created", "implementing": "Implemented",
        "maintaining": "Maintained", "managing": "Managed", "leading": "Led", "writing": "Wrote", "testing": "Tested",
        "deploying": "Deployed", "automating": "Automated", "improving": "Improved", "optimizing": "Optimized",
        "analyzing": "Analyzed", "migrating": "Migrated", "integrating": "Integrated", "debugging": "Debugged",
        "refactoring": "Refactored", "documenting": "Documented", "training": "Trained", "mentoring": "Mentored",
        "researching": "Researched", "coordinating": "Coordinated", "organizing": "Organized", "running": "Ran",
        "monitoring": "Monitored", "scaling": "Scaled", "configuring": "Configured", "reviewing": "Reviewed",
        "supporting": "Supported", "teaching": "Taught", "presenting": "Presented", "launching": "Launched",
        "shipping": "Shipped", "owning": "Owned", "establishing": "Established", "prototyping": "Prototyped",
        "evaluating": "Evaluated", "collecting": "Collected", "processing": "Processed", "handling": "Handled",
        "troubleshooting": "Troubleshot", "modeling": "Modeled", "modelling": "Modelled", "architecting": "Architected"}

# Title abbreviations, expanded so the title reads like the posting's.
TITLES = [(r"\bSWE(?= Intern)", "Software Engineering"), (r"\bSWE\b", "Software Engineer"),
          (r"\bSDE\b", "Software Development Engineer"), (r"\bSRE(?= Intern)", "Site Reliability Engineering"),
          (r"\bSRE\b", "Site Reliability Engineer"), (r"\bMLE\b", "Machine Learning Engineer"), (r"\bTA\b", "Teaching Assistant")]


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
    """What a posting asks for, and which of the user's declared skills fit it."""

    def __init__(self, posting: str, declared_skills: list[str]):
        self.posting = posting
        self.declared = [skill.strip() for skill in declared_skills if skill.strip()]
        self.targets: dict[int, str] = {}
        for index, (group, pattern) in enumerate(GROUPS):
            match = pattern.search(posting)
            if match:
                seen = match.group(0)
                # The posting's spelling, with the canonical capitals when it
                # is the same name ("GITHUB" → "GitHub").
                self.targets[index] = group[0] if seen.lower() == group[0].lower() else next(n for n in group if n.lower() == seen.lower())

    def spell(self, text: str) -> str:
        for index, (group, pattern) in enumerate(GROUPS):
            target = self.targets.get(index)
            if target:
                text = pattern.sub(target, text)
            elif any(ch.isupper() for ch in group[0][1:]):
                # Fix casing only for names with inner capitals: "Github" → "GitHub".
                text = pattern.sub(lambda m: group[0] if m.group(0).lower() == group[0].lower() else m.group(0), text)
        return text

    def mentions(self, text: str, skill: str) -> bool:
        entry = group_for(skill)
        pattern = entry[1] if entry else names_pattern([skill])
        return bool(pattern.search(text))

    def posting_spelling(self, skill: str) -> str:
        entry = group_for(skill)
        if entry:
            return self.targets.get(GROUPS.index(entry), entry[0][0])
        return skill

    def skills_to_add(self, resume_text: str, limit: int = 4) -> list[str]:
        """Profile skills the posting asks for that the resume doesn't show yet."""
        added: list[str] = []
        for skill in self.declared:
            if self.mentions(self.posting, skill) and not self.mentions(resume_text, skill):
                spelled = self.posting_spelling(skill)
                if spelled.lower() not in (a.lower() for a in added):
                    added.append(spelled)
        return added[:limit]


def fix_opener(text: str) -> str:
    """'Responsible for building X' → 'Built X'; 'Utilized' → 'Used'."""
    stripped = text.lstrip()
    lead = text[:len(text) - len(stripped)]
    match = re.match(r"(?:was\s+|were\s+)?responsible for\s+(\w+ing)\b", stripped, re.IGNORECASE) \
        or re.match(r"worked on\s+(\w+ing)\b", stripped, re.IGNORECASE)
    if match and match.group(1).lower() in PAST:
        return lead + PAST[match.group(1).lower()] + stripped[match.end():]
    for weak, strong in (("utilized", "Used"), ("utilised", "Used"), ("helped to", "Helped")):
        if stripped.lower().startswith(weak + " "):
            return lead + strong + stripped[len(weak):]
    match = re.match(r"I\s+([a-z]+)\b", stripped)
    if match and (match.group(1).endswith("ed") or match.group(1).capitalize() in PAST.values()):
        return lead + match.group(1).capitalize() + stripped[match.end():]
    return text


def expand_title(text: str) -> str:
    for pattern, replacement in TITLES:
        text = re.sub(pattern, replacement, text)
    return text


def period_style(bullets: list[str]) -> str | None:
    """The resume's own majority style for bullet endings, if it is clear."""
    endings = [b.rstrip().endswith(".") for b in bullets if b.strip()]
    if len(endings) < 3:
        return None
    share = sum(endings) / len(endings)
    return "period" if share >= .7 else "none" if share <= .3 else None


def apply_period(text: str, style: str | None) -> str:
    stripped = text.rstrip()
    tail = text[len(stripped):]
    if style == "none" and stripped.endswith(".") and not stripped.endswith(("etc.", "...")):
        return stripped[:-1] + tail
    if style == "period" and stripped and not stripped.endswith((".", "!", "?", ":")):
        return stripped + "." + tail
    return text


def skill_category(skill: str) -> str:
    name = skill.lower()
    return "languages" if name in LANGUAGES else "frameworks" if name in FRAMEWORKS else "libraries" if name in LIBRARIES else "tools"


def line_category(label: str) -> str | None:
    label = label.lower()
    if "language" in label:
        return "languages"
    if "librar" in label:
        return "libraries"
    if "framework" in label:
        return "frameworks"
    if any(word in label for word in ("tool", "technolog", "platform", "database", "cloud", "devops", "software")):
        return "tools"
    return None


def place_skills(labels: list[str], additions: list[str]) -> dict[int, list[str]]:
    """Pick the skills line each addition belongs on; returns line index → skills."""
    placed: dict[int, list[str]] = {}
    categories = [line_category(label) for label in labels]
    for skill in additions:
        wanted = skill_category(skill)
        options = [i for i, category in enumerate(categories) if category == wanted]
        if not options and wanted == "libraries":
            options = [i for i, category in enumerate(categories) if category == "frameworks"]
        if not options and wanted == "frameworks":
            options = [i for i, category in enumerate(categories) if category == "libraries"]
        if not options:
            options = [i for i, category in enumerate(categories) if category == "tools"] or [len(labels) - 1]
        placed.setdefault(options[0], []).append(skill)
    return placed


LATEX_TOKEN = re.compile(r"\\[a-zA-Z]+\*?|\\.|[{}$]|[^\\{}$]+")


def map_latex_text(source: str, edit, protect=("href", "url")) -> str:
    """Apply `edit` to the plain-text runs of a LaTeX fragment, leaving commands,
    math, and the first argument of protected commands (such as URLs) alone."""
    out, depth, pending, protected, math = [], 0, False, None, False
    for token in LATEX_TOKEN.findall(source):
        if token == "$":
            math = not math
        elif token.startswith("\\") and len(token) > 1 and token[1].isalpha():
            pending = token[1:].rstrip("*") in protect
        elif token == "{":
            depth += 1
            if pending and protected is None:
                protected = depth
            pending = False
        elif token == "}":
            if protected == depth:
                protected = None
            depth -= 1
        elif not token.startswith("\\") and not math and protected is None:
            token = edit(token)
        out.append(token)
    return "".join(out)


REASONS = {"spelling": "matched the posting's spelling", "opener": "opened with an action verb", "period": "kept bullet punctuation consistent"}


def describe(reasons: list[str]) -> str:
    text = "; ".join(REASONS[r] for r in reasons)
    return text[:1].upper() + text[1:] + "."


def reword(text: str, rules: Rules, style: str | None) -> tuple[str, list[str]]:
    """Edit one plain-text bullet; returns the new text and why it changed."""
    reasons = []
    spelled = rules.spell(text)
    if spelled != text:
        reasons.append("spelling")
    opened = fix_opener(spelled)
    if opened != spelled:
        reasons.append("opener")
    ended = apply_period(opened, style)
    if ended != opened:
        reasons.append("period")
    return ended, reasons


def edit_latex_bullet(source: str, rules: Rules, style: str | None) -> tuple[str, list[str]]:
    """Edit one \\resumeItem argument in place; commands and URLs are untouched."""
    reasons = []
    edited = map_latex_text(source, rules.spell)
    if edited != source:
        reasons.append("spelling")
    leading = re.match(r"\s*", edited).end()
    if leading < len(edited) and edited[leading] not in "\\{$":
        first = re.match(r"[^\\{}$]+", edited[leading:]).group(0)
        if fix_opener(first) != first:
            edited = edited[:leading] + fix_opener(first) + edited[leading + len(first):]
            reasons.append("opener")
    stripped = edited.rstrip()
    if style == "none" and stripped.endswith(".") and not stripped.endswith("\\."):
        edited = stripped[:-1] + edited[len(stripped):]
        reasons.append("period")
    elif style == "period" and stripped and stripped[-1] not in ".!?:":
        edited = stripped + "." + edited[len(stripped):]
        reasons.append("period")
    return edited, reasons
