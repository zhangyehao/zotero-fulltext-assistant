"""Build reproducible Zotero packages and authenticated-update assets.

Format: https://www.zotero.org/support/dev/zotero_7_for_developers#update_rdf_updates_json
ZIP storage and LF-normalized text avoid platform/zlib drift. Development files
enter the source archive only, never the installed XPI.
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parent
REPOSITORY = "zhangyehao/zotero-fulltext-assistant"
ADDON_ID = "fulltext-assistant@local.invalid"
UPDATE_URL = f"https://github.com/{REPOSITORY}/releases/latest/download/updates.json"
MIN_VERSION, MAX_VERSION = "10.0.7", "10.0.*"
TEXT_SUFFIXES = {".js", ".mjs", ".cjs", ".json", ".css", ".xhtml", ".html", ".txt", ".md", ".svg", ".py", ".yml", ".yaml"}
EXCLUDED_PARTS = {"node_modules", "__pycache__", ".git", "dist", "test-results", "profile", "data"}
PRIVATE_NAMES = {"logins.json", "key4.db", "tasks.json", "submission-intents.json", "credentials.json"}
PRIVATE_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".pem", ".key", ".p12", ".pfx"}
SOURCE_DIRS = {"src", "actors", "ui", "assets", "tests", "docs", ".github", "scripts"}
SOURCE_ROOT_FILES = {"manifest.json", "bootstrap.js", "build.py", "README.md", "LICENSE", ".gitignore", ".gitattributes", "package.json", "package-lock.json", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md", "PRIVACY.md", "SUPPORT.md"}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def canonical_bytes(path):
    data = path.read_bytes()
    if path.suffix.lower() in TEXT_SUFFIXES or path.name in {"LICENSE", ".gitignore", ".gitattributes"}:
        data = data.replace(b"\r\n", b"\n")
    return data


def production(path, root=ROOT):
    rel = path.relative_to(root)
    return (path.is_file() and not path.is_symlink() and (rel.as_posix() in {"manifest.json", "bootstrap.js", "LICENSE"}
            or rel.parts[0] in {"src", "actors", "ui", "assets"})
            and not any(part in EXCLUDED_PARTS for part in rel.parts)
            and not path.name.startswith((".env", "cookies"))
            and path.name not in PRIVATE_NAMES
            and path.suffix.lower() not in PRIVATE_SUFFIXES | {".xpi", ".zip", ".pdf", ".log", ".pyc"}
            and not path.name.endswith((".test.cjs", ".test.js")))


def source_file(path, root=ROOT, output=None):
    rel = path.relative_to(root)
    if not path.is_file() or path.is_symlink() or output and path.is_relative_to(output):
        return False
    if any(part in EXCLUDED_PARTS for part in rel.parts):
        return False
    if path.name.startswith((".env", "cookies")) or path.name in PRIVATE_NAMES:
        return False
    if path.suffix.lower() in PRIVATE_SUFFIXES | {".xpi", ".zip", ".pdf", ".log", ".pyc"}:
        return False
    return rel.parts[0] in SOURCE_DIRS or rel.as_posix() in SOURCE_ROOT_FILES


def configuration(root=ROOT):
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((root / "package-lock.json").read_text(encoding="utf-8"))
    version = manifest.get("version", "")
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("A stable three-part version is required.")
    if any(value != version for value in (package.get("version"), lock.get("version"), lock.get("packages", {}).get("", {}).get("version"))):
        raise ValueError("Manifest, package and lockfile versions must match.")
    settings = manifest.get("applications", {}).get("zotero", {})
    expected = {"id": ADDON_ID, "update_url": UPDATE_URL, "strict_min_version": MIN_VERSION, "strict_max_version": MAX_VERSION}
    if any(settings.get(key) != value for key, value in expected.items()):
        raise ValueError("The established add-on ID, update URL and tested Zotero compatibility must be preserved.")
    return manifest, version


def write_archive(target, paths, root, prefix=""):
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as archive:
        for path in sorted(paths, key=lambda value: value.relative_to(root).as_posix()):
            info = zipfile.ZipInfo(prefix + path.relative_to(root).as_posix(), date_time=(2020, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_STORED
            archive.writestr(info, canonical_bytes(path))


def build(output, root=ROOT):
    root, output = Path(root).resolve(), Path(output).resolve()
    if output == root or root.is_relative_to(output):
        raise ValueError("Build output must not be the source root or its ancestor.")
    manifest, version = configuration(root)
    output.mkdir(parents=True, exist_ok=True)
    stem, tag = f"zotero-fulltext-assistant-{version}", f"v{version}"
    package, source = output / f"{stem}.xpi", output / f"{stem}-source.zip"
    paths = list(root.rglob("*"))
    for path in paths:
        rel = path.relative_to(root)
        if path.is_symlink() and (rel.parts[0] in SOURCE_DIRS or rel.as_posix() in SOURCE_ROOT_FILES):
            raise ValueError("Symlinks are not allowed in public package/source inputs.")
    prod = [path for path in paths if production(path, root)]
    sources = [path for path in paths if source_file(path, root, output)]
    write_archive(package, prod, root)
    write_archive(source, sources, root, "fulltext-plugin/")
    compatibility = manifest["applications"]["zotero"]
    updates = {"addons": {ADDON_ID: {"updates": [{"version": version,
        "update_link": f"https://github.com/{REPOSITORY}/releases/download/{tag}/{package.name}",
        "update_hash": "sha256:" + sha256(package),
        "applications": {"zotero": {key: compatibility[key] for key in ("strict_min_version", "strict_max_version")}}
    }]}}}
    updates_path = output / "updates.json"
    updates_path.write_bytes(json_bytes(updates))
    payloads = [package, source, updates_path]
    checksums = output / "SHA256SUMS"
    checksums.write_text("".join(f"{sha256(path)}  {path.name}\n" for path in sorted(payloads)), encoding="utf-8", newline="\n")
    payloads.append(checksums)
    release_manifest = output / "release-manifest.json"
    release_manifest.write_bytes(json_bytes({"schema": 1, "repository": REPOSITORY, "addon_id": ADDON_ID,
        "version": version, "tag": tag, "xpi": package.name, "update_url": UPDATE_URL,
        "production_file_count": len(prod), "source_file_count": len(sources),
        "assets": [{"name": path.name, "size": path.stat().st_size, "sha256": sha256(path)} for path in sorted(payloads)]}))
    return {"xpi": str(package), "source": str(source), "updates": str(updates_path), "checksums": str(checksums),
        "release_manifest": str(release_manifest), "sha256": sha256(package), "version": version,
        "production_file_count": len(prod), "source_file_count": len(sources)}


def main():
    parser = argparse.ArgumentParser(description="Build the reproducible XPI, source archive and five release assets.")
    parser.add_argument("--output", type=Path, default=ROOT.parents[1] / "outputs")
    args = parser.parse_args()
    print(json.dumps(build(args.output), ensure_ascii=False))


if __name__ == "__main__":
    main()
