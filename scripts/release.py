"""Prepare/verify a single release candidate; publish only by explicit command.

Requires authenticated GitHub CLI. No command changes repository visibility.
REST/CLI contracts: https://docs.github.com/rest/releases/releases
https://cli.github.com/manual/gh_release_upload
"""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build as packager


class ReleaseError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def load_assets(directory, root=ROOT):
    directory = Path(directory).resolve()
    _, version = packager.configuration(root)
    names = {f"zotero-fulltext-assistant-{version}.xpi", f"zotero-fulltext-assistant-{version}-source.zip", "updates.json", "SHA256SUMS", "release-manifest.json"}
    info = json.loads((directory / "release-manifest.json").read_text(encoding="utf-8"))
    require(info.get("schema") == 1 and info.get("repository") == packager.REPOSITORY and info.get("addon_id") == packager.ADDON_ID, "Unexpected release manifest identity.")
    require(info.get("version") == version and info.get("tag") == "v" + version and info.get("update_url") == packager.UPDATE_URL, "Release manifest version/update URL differs from the checkout.")
    require(info.get("xpi") == f"zotero-fulltext-assistant-{version}.xpi", "Unexpected XPI asset name.")
    entries = info.get("assets", [])
    require(len(entries) == 4 and {entry.get("name") for entry in entries} == names - {"release-manifest.json"}, "Release manifest must describe exactly the four payload assets.")
    for entry in entries:
        path = directory / entry["name"]
        require(path.is_file() and path.stat().st_size == entry.get("size") and packager.sha256(path) == entry.get("sha256"), "A local release asset failed its recorded size/hash check.")
    xpi = directory / info["xpi"]
    with zipfile.ZipFile(xpi) as archive:
        actual = json.loads(archive.read("manifest.json"))
        expected = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        require(actual == expected, "Packaged manifest differs from the checkout.")
    updates = json.loads((directory / "updates.json").read_text(encoding="utf-8"))
    expected_update = {"addons": {packager.ADDON_ID: {"updates": [{"version": version,
        "update_link": f"https://github.com/{packager.REPOSITORY}/releases/download/v{version}/{xpi.name}",
        "update_hash": "sha256:" + packager.sha256(xpi),
        "applications": {"zotero": {"strict_min_version": packager.MIN_VERSION, "strict_max_version": packager.MAX_VERSION}}
    }]}}}
    require(updates == expected_update, "Update manifest does not identify this exact compatible XPI.")
    expected_sums = "".join(f"{packager.sha256(directory / name)}  {name}\n" for name in sorted(names - {"release-manifest.json", "SHA256SUMS"}))
    require((directory / "SHA256SUMS").read_text(encoding="utf-8") == expected_sums, "Checksum file differs from the exact release payloads.")
    assets = {name: {"path": directory / name, "size": (directory / name).stat().st_size, "sha256": packager.sha256(directory / name)} for name in sorted(names)}
    return {"info": info, "assets": assets, "directory": directory, "xpi_sha256": packager.sha256(xpi)}


def verify_checkout(bundle, root=ROOT):
    for source in (False, True):
        filename = f"zotero-fulltext-assistant-{bundle['info']['version']}" + ("-source.zip" if source else ".xpi")
        prefix = "fulltext-plugin/" if source else ""
        allowed = [path for path in root.rglob("*") if (packager.source_file(path, root, bundle["directory"]) if source else packager.production(path, root))]
        expected = {prefix + path.relative_to(root).as_posix(): path for path in allowed}
        with zipfile.ZipFile(bundle["directory"] / filename) as archive:
            require(len(archive.namelist()) == len(expected) and set(archive.namelist()) == set(expected), "Archive entries differ from the allowed checkout files.")
            for name, path in expected.items():
                require(archive.read(name) == packager.canonical_bytes(path), "Archive content differs from the current checkout.")


def verify_tracked_inputs(bundle, root=ROOT):
    tracked = subprocess.run(["git", "ls-files", "--cached", "-z"], cwd=root,
                             capture_output=True, text=True, encoding="utf-8")
    require(tracked.returncode == 0, "Could not verify tracked release inputs.")
    names = set(tracked.stdout.split("\0")) - {""}
    # git status omits ignored files. An ignored file inside a permitted source
    # directory must never become a publicly uploaded archive input.
    for source in (False, True):
        filename = f"zotero-fulltext-assistant-{bundle['info']['version']}" + ("-source.zip" if source else ".xpi")
        prefix = "fulltext-plugin/" if source else ""
        with zipfile.ZipFile(bundle["directory"] / filename) as archive:
            require(all(name.removeprefix(prefix) in names for name in archive.namelist()),
                    "Archives contain ignored or untracked inputs; commit approved files or remove them before releasing.")


class GitHub:
    def __init__(self, repository=packager.REPOSITORY):
        require(repository == packager.REPOSITORY, "This release tool is restricted to its configured repository.")
        self.repository = repository

    def command(self, args, body=None, allow_missing=False):
        completed = subprocess.run(["gh", *args], input=json.dumps(body) if body is not None else None,
                                   capture_output=True, text=True, encoding="utf-8")
        if completed.returncode:
            if allow_missing and "HTTP 404" in completed.stderr:
                return None
            raise ReleaseError("GitHub CLI failed; no further release changes were attempted. Check authentication, permissions and the workflow log.")
        return completed.stdout

    def api(self, path, method="GET", body=None, allow_missing=False):
        endpoint = f"repos/{self.repository}" + ("/" + path if path else "")
        args = ["api", endpoint, "--method", method, "-H", "Accept: application/vnd.github+json"]
        if body is not None:
            args += ["--input", "-"]
        value = self.command(args, body, allow_missing)
        return json.loads(value) if value and value.strip() else None

    def release(self, tag):
        # GitHub's by-tag endpoint can return 404 for authenticated draft
        # releases. List drafts, find the exact tag, then refresh by numeric ID.
        matches = []
        for page in range(1, 101):
            entries = self.api(f"releases?per_page=100&page={page}")
            require(isinstance(entries, list), "Could not list candidate releases.")
            matches.extend(entry for entry in entries if entry.get("tag_name") == tag)
            require(len(matches) <= 1, "Multiple releases identify this tag; inspect them before proceeding.")
            if len(entries) < 100:
                break
        else:
            raise ReleaseError("Release pagination exceeded its safety bound.")
        if not matches:
            return None
        release_id = matches[0].get("id")
        require(isinstance(release_id, int) and release_id > 0, "Invalid candidate release ID.")
        current = self.api(f"releases/{release_id}", allow_missing=True)
        require(current and current.get("id") == release_id and current.get("tag_name") == tag,
                "Listed release no longer identifies the exact candidate.")
        return current

    def tag_commit(self, tag):
        obj = self.api("git/ref/tags/" + tag)["object"]
        for _ in range(4):
            if obj.get("type") == "commit":
                return obj.get("sha")
            require(obj.get("type") == "tag" and re.fullmatch(r"[a-f0-9]{40,64}", obj.get("sha", "")), "Tag does not resolve to a valid commit.")
            obj = self.api("git/tags/" + obj["sha"])["object"]
        raise ReleaseError("Tag indirection is unexpectedly deep.")

    def create_draft(self, tag):
        self.command(["release", "create", tag, "--repo", self.repository, "--verify-tag", "--draft", "--prerelease", "--title", tag, "--generate-notes"])

    def upload(self, tag, paths):
        if paths:
            self.command(["release", "upload", tag, *[str(path) for path in paths], "--repo", self.repository])

    def delete_asset(self, asset_id):
        require(isinstance(asset_id, int) and asset_id > 0, "Invalid draft asset ID.")
        self.api(f"releases/assets/{asset_id}", method="DELETE")

    def download(self, tag, names, directory):
        args = ["release", "download", tag, "--repo", self.repository, "--dir", str(directory)]
        for name in names:
            args += ["--pattern", name]
        self.command(args)

    def publish(self, release_id):
        require(isinstance(release_id, int) and release_id > 0, "Invalid release ID.")
        self.api(f"releases/{release_id}", method="PATCH", body={"draft": False, "prerelease": False, "make_latest": "true"})

    def latest(self):
        return self.api("releases/latest", allow_missing=True)

    def is_public(self):
        return self.api("").get("private") is False

    def public_updates(self):
        request = urllib.request.Request(packager.UPDATE_URL, headers={"User-Agent": "zotero-fulltext-assistant-release-verifier"})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read(1024 * 1024 + 1)


def remote_assets(release, bundle, complete=True):
    entries = release.get("assets", [])
    require(len(entries) == len({entry.get("name") for entry in entries}), "Release contains duplicate asset names.")
    index = {entry["name"]: entry for entry in entries}
    expected = set(bundle["assets"])
    require(set(index) <= expected and (not complete or set(index) == expected), "Release asset set contains missing or unreviewed files.")
    return index


def verify_remote(remote, release, bundle):
    require(release and release.get("tag_name") == bundle["info"]["tag"], "Wrong release tag.")
    index = remote_assets(release, bundle)
    for name, expected in bundle["assets"].items():
        actual = index[name]
        require(actual.get("state") == "uploaded" and actual.get("size") == expected["size"], "Remote asset size/upload state differs from the reviewed package.")
        require(actual.get("digest") in (None, "sha256:" + expected["sha256"]), "Remote asset digest differs from the reviewed package.")
    with tempfile.TemporaryDirectory(prefix="zotero-release-verify-") as temporary:
        remote.download(bundle["info"]["tag"], sorted(index), Path(temporary))
        for name, expected in bundle["assets"].items():
            path = Path(temporary) / name
            require(path.is_file() and path.stat().st_size == expected["size"] and packager.sha256(path) == expected["sha256"], "Downloaded release bytes failed verification.")


def run_release(mode, bundle, remote, expected_commit, expected_sha256=None, replace_draft_assets=False):
    tag = bundle["info"]["tag"]
    require(re.fullmatch(r"[a-f0-9]{40,64}", expected_commit or ""), "A full reviewed checkout commit is required.")
    require(remote.tag_commit(tag) == expected_commit, "Remote tag does not identify the reviewed checkout commit.")
    if mode == "publish":
        require(re.fullmatch(r"[a-f0-9]{64}", expected_sha256 or "") and expected_sha256 == bundle["xpi_sha256"], "Publishing requires the exact independently reviewed XPI SHA256.")
    release = remote.release(tag)
    if mode == "prepare":
        if not release:
            remote.create_draft(tag)
            for attempt in range(4):
                release = remote.release(tag)
                if release:
                    break
                if attempt < 3:
                    time.sleep(2 ** attempt)
        require(release and release.get("tag_name") == tag, "Could not confirm the exact candidate release.")
        if release.get("draft") is not True:
            verify_remote(remote, release, bundle)
            return "already-published-verified"
        index = remote_assets(release, bundle, complete=False)
        missing = []
        # Existing bytes are downloaded before deciding whether replacement is
        # needed; reruns never delete/reupload an already identical asset.
        with tempfile.TemporaryDirectory(prefix="zotero-release-existing-") as temporary:
            if index:
                remote.download(tag, sorted(index), Path(temporary))
            for name, expected in bundle["assets"].items():
                existing = index.get(name)
                path = Path(temporary) / name
                if existing and path.is_file() and packager.sha256(path) == expected["sha256"]:
                    continue
                if existing:
                    require(replace_draft_assets, "Draft asset differs. Review it, then explicitly opt in to replacement.")
                    require(remote.release(tag).get("draft") is True, "Release was published while preparing; no asset was deleted.")
                    remote.delete_asset(existing["id"])
                missing.append(expected["path"])
        require(remote.release(tag).get("draft") is True, "Release is no longer a draft; no asset was uploaded.")
        remote.upload(tag, missing)
        verify_remote(remote, remote.release(tag), bundle)
        return "draft-verified"
    require(release is not None, "Prepare and review the release draft first.")
    verify_remote(remote, release, bundle)
    if mode == "verify":
        return "release-verified"
    require(mode == "publish", "Unsupported release mode.")
    require(remote.is_public(), "Repository must already be public before publishing the public update channel.")
    latest = remote.latest()
    if latest:
        current_tag = latest.get("tag_name", "")
        require(re.fullmatch(r"v\d+\.\d+\.\d+", current_tag), "Latest stable release version cannot be compared safely.")
        require(tuple(map(int, current_tag[1:].split("."))) <= tuple(map(int, tag[1:].split("."))), "Refusing to roll the latest update channel back to an older version.")
    if release.get("draft") is True:
        require(remote.tag_commit(tag) == expected_commit, "Tag changed after candidate verification; publication stopped.")
        fresh = remote.release(tag)
        require(fresh and fresh.get("id") == release.get("id") and fresh.get("draft") is True, "Candidate state changed after review; publication stopped.")
        before, after = remote_assets(release, bundle), remote_assets(fresh, bundle)
        require(all(all(before[name].get(key) == after[name].get(key) for key in ("id", "size", "digest", "state")) for name in before), "Candidate assets changed after byte verification; publication stopped.")
        remote.publish(release["id"])
    else:
        require(release.get("prerelease") is False, "An existing published prerelease is not modified automatically.")
    current, latest = remote.release(tag), remote.latest()
    require(current and current.get("draft") is False and current.get("prerelease") is False and latest and latest.get("id") == current.get("id"), "Stable release/latest channel was not confirmed; inspect the existing release before retrying.")
    require(remote.public_updates() == bundle["assets"]["updates.json"]["path"].read_bytes(), "Public latest/download/updates.json is not yet the reviewed manifest. Retry verification after CDN propagation.")
    return "published-verified"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("verify-local", "prepare", "verify", "publish"))
    parser.add_argument("--directory", type=Path, default=ROOT / "dist")
    parser.add_argument("--tag")
    parser.add_argument("--expected-commit")
    parser.add_argument("--expected-sha256")
    parser.add_argument("--replace-draft-assets", action="store_true")
    args = parser.parse_args()
    bundle = load_assets(args.directory)
    verify_checkout(bundle)
    if args.mode == "verify-local":
        print(json.dumps({"result": "local-build-verified", "version": bundle["info"]["version"], "xpi_sha256": bundle["xpi_sha256"], "assets": sorted(bundle["assets"])}))
        return
    require(args.tag == bundle["info"]["tag"], "Requested tag differs from the built version.")
    state = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=ROOT, capture_output=True, text=True)
    require(state.returncode == 0 and not state.stdout.strip(), "Commit or remove untracked/unreviewed files before release preparation/publication.")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    require(args.expected_commit is None or args.expected_commit == commit, "Expected commit must equal the actual checked-out HEAD.")
    verify_tracked_inputs(bundle)
    result = run_release(args.mode, bundle, GitHub(), commit, args.expected_sha256, args.replace_draft_assets)
    print(json.dumps({"result": result, "tag": args.tag, "xpi_sha256": bundle["xpi_sha256"], "assets": sorted(bundle["assets"])}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ReleaseError, ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        print(f"Release stopped: {error}", file=sys.stderr)
        raise SystemExit(1)
