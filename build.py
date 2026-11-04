"""Build a source-only Zotero XPI without development dependencies or tests."""
from pathlib import Path
import argparse
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description="Build the Zotero XPI and a clean source archive.")
parser.add_argument("--output", type=Path, default=root.parents[1] / "outputs",
                    help="Output directory; relative paths are resolved from the current directory.")
output = parser.parse_args().output.resolve()
output.mkdir(parents=True, exist_ok=True)
version = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
stem = f"zotero-fulltext-assistant-{version}"
package = output / f"{stem}.xpi"
source = output / f"{stem}-source.zip"

def production(path):
    rel = path.relative_to(root)
    return (path.is_file() and (rel.as_posix() in {"manifest.json", "bootstrap.js", "LICENSE"}
            or rel.parts[0] in {"src", "actors", "ui", "assets"})
            and not path.name.endswith((".test.cjs", ".test.js")))

def source_file(path):
    rel = path.relative_to(root)
    if not path.is_file() or (output != root and path.is_relative_to(output)):
        return False
    if any(part in {"node_modules", "__pycache__", ".git", "dist", "test-results", "profile", "data"} for part in rel.parts):
        return False
    if path.name.startswith((".env", "cookies")) or path.name in {"logins.json", "key4.db", "tasks.json", "submission-intents.json"}:
        return False
    if path.suffix in {".xpi", ".zip", ".pdf", ".log", ".pyc"}:
        return False
    return rel.parts[0] in {"src", "actors", "ui", "assets", "tests", "docs", ".github"} or rel.as_posix() in {
        "manifest.json", "bootstrap.js", "build.py", "README.md", "LICENSE", ".gitignore", "package.json", "package-lock.json"
    }

with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob("*")):
        if production(path):
            archive.write(path, path.relative_to(root).as_posix())
with zipfile.ZipFile(source, "w", zipfile.ZIP_DEFLATED) as archive:
    for path in sorted(root.rglob("*")):
        if source_file(path):
            archive.write(path, (Path("fulltext-plugin") / path.relative_to(root)).as_posix())
print(json.dumps({"xpi": str(package), "source": str(source), "sha256": hashlib.sha256(package.read_bytes()).hexdigest()}, ensure_ascii=False))
