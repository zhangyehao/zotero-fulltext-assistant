"""Offline build/release checks. All GitHub reads and writes use an in-memory fake."""
from pathlib import Path
import copy
import hashlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from unittest import mock
from contextlib import redirect_stdout
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build

spec = importlib.util.spec_from_file_location("release_tool", ROOT / "scripts" / "release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
COMMIT = "a" * 40


def copy_source(destination):
    for path in ROOT.rglob("*"):
        if build.source_file(path, ROOT):
            target = destination / path.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)


class FakeGitHub:
    def __init__(self, bundle, exists=True):
        self.bundle = bundle
        self.tag = bundle["info"]["tag"]
        self.exists = exists
        self.draft, self.prerelease, self.public = True, True, True
        self.commit = COMMIT
        self.data = {name: entry["path"].read_bytes() for name, entry in bundle["assets"].items()} if exists else {}
        self.ids = {name: i + 1 for i, name in enumerate(self.data)}
        self.writes = []
        self.latest_release = None
        self.download_corrupt = False
        self.public_stale = False
        self.history = [{"id": 7, "tag_name": "v0.7.2", "draft": True, "prerelease": True, "assets": [{"id": 8, "name": "old-private-asset"}]}]

    def tag_commit(self, tag):
        assert tag == self.tag
        return self.commit

    def release(self, tag):
        assert tag == self.tag
        if not self.exists:
            return None
        return {"id": 100, "tag_name": self.tag, "draft": self.draft, "prerelease": self.prerelease,
                "assets": [{"id": self.ids[name], "name": name, "size": len(data), "state": "uploaded", "digest": "sha256:" + hashlib.sha256(data).hexdigest()} for name, data in self.data.items()]}

    def create_draft(self, tag):
        assert tag == self.tag and not self.exists
        self.writes.append("create-draft");self.exists = True

    def download(self, tag, names, directory):
        assert tag == self.tag
        for name in names:
            (directory / name).write_bytes(self.data[name] + (b"corrupted" if self.download_corrupt else b""))

    def upload(self, tag, paths):
        assert tag == self.tag and self.draft
        for path in paths:
            assert path.name not in self.data
            self.writes.append(("upload", path.name));self.data[path.name] = path.read_bytes();self.ids[path.name] = max(self.ids.values(), default=0) + 1

    def delete_asset(self, asset_id):
        assert self.draft
        name = next(name for name, value in self.ids.items() if value == asset_id)
        self.writes.append(("delete", name));del self.data[name]

    def publish(self, release_id, tag, expected_commit):
        assert release_id == 100 and self.draft
        assert tag == self.tag and expected_commit == self.commit
        self.writes.append("publish-stable-latest");self.draft = False;self.prerelease = False
        self.latest_release = {"id": 100, "tag_name": self.tag}

    def latest(self):
        return self.latest_release

    def is_public(self):
        return self.public

    def public_updates(self):
        return b"stale" if self.public_stale else self.data["updates.json"]


class BuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="zotero-build-test-")
        cls.base = Path(cls.temporary.name)
        cls.fixture = cls.base / "source"
        copy_source(cls.fixture)
        cls.output = cls.base / "build"
        cls.result = build.build(cls.output, cls.fixture)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_stable_versions_existing_id_and_tested_compatibility(self):
        manifest, version = build.configuration(self.fixture)
        self.assertEqual(version, "0.9.0")
        self.assertEqual(manifest["applications"]["zotero"], {"id": "fulltext-assistant@local.invalid", "update_url": build.UPDATE_URL, "strict_min_version": "10.0.7", "strict_max_version": "10.0.*"})

    def test_xpi_preserves_runtime_files_and_excludes_development(self):
        with zipfile.ZipFile(self.result["xpi"]) as archive:
            names = set(archive.namelist())
            self.assertEqual(len(names), 39)
            self.assertTrue({"manifest.json", "bootstrap.js", "LICENSE", "src/app.js", "src/pdf-identity.js", "src/fulltext-sources.js", "src/source-usage.js", "src/update.js", "ui/preferences.xhtml", "assets/icon-96.png"} <= names)
            self.assertFalse(any(name.startswith(("tests/", "scripts/", ".github/", "docs/", "node_modules/")) or ".test." in name for name in names))

    def test_source_archive_includes_release_tooling_and_documents(self):
        with zipfile.ZipFile(self.result["source"]) as archive:
            names = set(archive.namelist())
            self.assertTrue({"fulltext-plugin/scripts/release.py", "fulltext-plugin/tests/test_release.py", "fulltext-plugin/.github/workflows/publish.yml", "fulltext-plugin/package-lock.json"} <= names)
            self.assertFalse(any("node_modules/" in name or "__pycache__/" in name or name.endswith((".xpi", ".zip", ".pdf", ".log")) for name in names))
        for name in ("PRIVACY.md", "SUPPORT.md", "docs/images/task-panel.png", "docs/images/settings.png"):
            path = self.fixture / name
            previous = path.read_bytes() if path.exists() else None
            path.parent.mkdir(parents=True, exist_ok=True);path.write_bytes(b"fixture")
            self.assertTrue(build.source_file(path, self.fixture))
            if previous is None: path.unlink()
            else: path.write_bytes(previous)

    def test_update_manifest_and_checksums_bind_exact_release_xpi(self):
        bundle = release.load_assets(self.output, self.fixture)
        self.assertEqual(len(bundle["assets"]), 5)
        self.assertEqual(bundle["xpi_sha256"], self.result["sha256"])
        update = json.loads((self.output / "updates.json").read_text())["addons"][build.ADDON_ID]["updates"][0]
        self.assertEqual(update["update_link"], "https://github.com/zhangyehao/zotero-fulltext-assistant/releases/download/v0.9.0/zotero-fulltext-assistant-0.9.0.xpi")
        self.assertEqual(update["update_hash"], "sha256:" + self.result["sha256"])
        self.assertEqual(update["applications"]["zotero"], {"strict_min_version": "10.0.7", "strict_max_version": "10.0.*"})
        release.verify_checkout(bundle, self.fixture)

    def test_lf_crlf_mtime_and_file_modes_do_not_change_any_asset(self):
        other = self.base / "crlf-source"
        shutil.copytree(self.fixture, other)
        for path in other.rglob("*"):
            if not path.is_file():
                continue
            canonical = build.canonical_bytes(path)
            if path.suffix.lower() in build.TEXT_SUFFIXES or path.name in {"LICENSE", ".gitignore", ".gitattributes"}:
                path.write_bytes(canonical.replace(b"\n", b"\r\n"))
            os.utime(path, (1999999999, 1999999999))
            path.chmod(0o755)
        output = self.base / "crlf-build"
        build.build(output, other)
        for path in self.output.iterdir():
            self.assertEqual(path.read_bytes(), (output / path.name).read_bytes(), path.name)

    def test_version_drift_is_rejected_before_build(self):
        target = self.base / "wrong-version"
        shutil.copytree(self.fixture, target)
        config = json.loads((target / "package-lock.json").read_text());config["packages"][""]["version"] = "0.7.2"
        (target / "package-lock.json").write_text(json.dumps(config))
        with self.assertRaises(ValueError):
            build.build(self.base / "rejected-build", target)

    def test_symlinked_public_source_is_rejected_instead_of_followed(self):
        linked = self.fixture / "src" / "app.js"
        with mock.patch.object(Path, "is_symlink", lambda path: path == linked):
            with self.assertRaises(ValueError):
                build.build(self.base / "symlink-build", self.fixture)

    def test_private_runtime_state_and_generated_outputs_enter_neither_archive(self):
        for name in ("src/cookies.json", "ui/.env.local", "src/tasks.json", "src/profile/login.json", "ui/key4.db", "assets/local.pdf", "src/debug.log", "src/credentials.json", "docs/account.sqlite", "scripts/private.pem", "assets/secret.key"):
            path = self.fixture / name
            path.parent.mkdir(parents=True, exist_ok=True);path.write_bytes(b"private fixture")
            self.assertFalse(build.production(path, self.fixture), name)
            self.assertFalse(build.source_file(path, self.fixture), name)
            path.unlink()

    def test_local_corruption_and_unreviewed_source_drift_are_rejected(self):
        output = self.base / "corrupt"
        shutil.copytree(self.output, output)
        (output / "updates.json").write_bytes(b"{}")
        with self.assertRaises(release.ReleaseError):
            release.load_assets(output, self.fixture)
        bundle = release.load_assets(self.output, self.fixture)
        path = self.fixture / "README.md";old = path.read_bytes()
        try:
            path.write_bytes(old + b"\nunreviewed change\n")
            with self.assertRaises(release.ReleaseError):
                release.verify_checkout(bundle, self.fixture)
        finally:
            path.write_bytes(old)

    def test_ci_packages_all_five_assets_and_tag_workflow_cannot_publish(self):
        ci = (ROOT / ".github/workflows/ci.yml").read_text()
        draft = (ROOT / ".github/workflows/release.yml").read_text()
        publish = (ROOT / ".github/workflows/publish.yml").read_text()
        for path in ("dist/*.xpi", "dist/*-source.zip", "dist/updates.json", "dist/SHA256SUMS", "dist/release-manifest.json"):
            self.assertIn(path, ci)
        self.assertIn("verify-local --directory dist", ci)
        self.assertIn("tags: ['v*']", draft);self.assertIn("release.py prepare", draft)
        self.assertNotIn("release.py publish", draft)
        self.assertIn("workflow_dispatch:", publish);self.assertNotIn("push:", publish);self.assertNotIn("release:\n", publish)
        self.assertIn("expected_xpi_sha256:", publish);self.assertIn('--expected-sha256 "$REVIEWED_XPI_SHA256"', publish)
        self.assertIn("group: release-${{ github.repository }}\n", draft)
        self.assertIn("group: release-${{ github.repository }}\n", publish)


class GitHubReadTests(unittest.TestCase):
    def test_publish_patch_preserves_verified_tag_and_commit_in_actual_request(self):
        remote = release.GitHub()
        response = mock.Mock(returncode=0, stdout='{"id": 100}', stderr="")
        with mock.patch.object(release.subprocess, "run", return_value=response) as request:
            remote.publish(100, "v0.8.0", COMMIT)
        request.assert_called_once()
        self.assertEqual(request.call_args.args[0], ["gh", "api",
            "repos/zhangyehao/zotero-fulltext-assistant/releases/100", "--method", "PATCH",
            "-H", "Accept: application/vnd.github+json", "--input", "-"])
        self.assertEqual(json.loads(request.call_args.kwargs["input"]), {
            "tag_name": "v0.8.0", "target_commitish": COMMIT,
            "draft": False, "prerelease": False, "make_latest": "true"})

    def test_publish_rejects_invalid_identity_before_request(self):
        remote = release.GitHub()
        for identity in ((0, "v0.8.0", COMMIT), (100, "", COMMIT), (100, "v0.8.0", "main")):
            with mock.patch.object(release.subprocess, "run") as request:
                with self.assertRaises(release.ReleaseError):
                    remote.publish(*identity)
                request.assert_not_called()

    def test_draft_is_found_by_exact_tag_across_pages_then_refreshed_by_id(self):
        remote = release.GitHub()
        first = [{"id": number + 1, "tag_name": "v0.7.2", "draft": True} for number in range(100)]
        candidate = {"id": 436392839, "tag_name": "v0.8.0", "draft": True, "assets": []}
        pages = {"releases?per_page=100&page=1": first,
                 "releases?per_page=100&page=2": [{"id": 200, "tag_name": "v0.8.0-other"}, candidate],
                 "releases/436392839": candidate}
        with mock.patch.object(remote, "api", side_effect=lambda path, **_kwargs: pages[path]) as api:
            self.assertEqual(remote.release("v0.8.0"), candidate)
            self.assertEqual([call.args[0] for call in api.call_args_list], list(pages))
            self.assertFalse(any("releases/tags/" in call.args[0] for call in api.call_args_list))

    def test_missing_draft_and_published_state_are_read_without_cached_state(self):
        remote = release.GitHub()
        with mock.patch.object(remote, "api", return_value=[]):
            self.assertIsNone(remote.release("v0.8.0"))
        candidate = {"id": 100, "tag_name": "v0.8.0", "draft": True}
        stable = dict(candidate, draft=False, prerelease=False)
        with mock.patch.object(remote, "api", side_effect=[[candidate], candidate, [candidate], stable]):
            self.assertTrue(remote.release("v0.8.0")["draft"])
            self.assertFalse(remote.release("v0.8.0")["draft"])

    def test_duplicate_or_changed_candidate_is_rejected(self):
        remote = release.GitHub()
        candidate = {"id": 100, "tag_name": "v0.8.0", "draft": True}
        for replies in ([[candidate, dict(candidate, id=101)]],
                        [[candidate], dict(candidate, tag_name="v0.7.2")],
                        [[candidate], None]):
            with mock.patch.object(remote, "api", side_effect=replies):
                with self.assertRaises(release.ReleaseError):
                    remote.release("v0.8.0")

    def test_release_pagination_is_bounded(self):
        remote = release.GitHub()
        page = [{"id": number + 1, "tag_name": "v0.7.2"} for number in range(100)]
        with mock.patch.object(remote, "api", return_value=page) as api:
            with self.assertRaisesRegex(release.ReleaseError, "pagination"):
                remote.release("v0.8.0")
            self.assertEqual(api.call_count, 100)


class ReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="zotero-release-test-")
        cls.output = Path(cls.temporary.name) / "build"
        build.build(cls.output)
        cls.bundle = release.load_assets(cls.output)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_prepare_creates_only_a_draft_and_reruns_do_not_reupload(self):
        remote = FakeGitHub(self.bundle, exists=False);history = copy.deepcopy(remote.history)
        self.assertEqual(release.run_release("prepare", self.bundle, remote, COMMIT), "draft-verified")
        self.assertTrue(remote.draft);self.assertTrue(remote.prerelease)
        self.assertEqual(len(remote.writes), 6)
        before = list(remote.writes)
        self.assertEqual(release.run_release("prepare", self.bundle, remote, COMMIT), "draft-verified")
        self.assertEqual(remote.writes, before);self.assertEqual(remote.history, history)

    def test_new_draft_listing_delay_retries_without_duplicate_creation(self):
        remote = FakeGitHub(self.bundle, exists=False)
        real_read = remote.release
        calls = []
        def delayed(tag):
            calls.append(tag)
            return None if len(calls) <= 3 else real_read(tag)
        remote.release = delayed
        with mock.patch.object(release.time, "sleep") as sleep:
            self.assertEqual(release.run_release("prepare", self.bundle, remote, COMMIT), "draft-verified")
            self.assertEqual(sleep.call_args_list, [mock.call(1), mock.call(2)])
        self.assertEqual(remote.writes.count("create-draft"), 1)
        self.assertEqual(len([write for write in remote.writes if isinstance(write, tuple) and write[0] == "upload"]), 5)

    def test_unobservable_created_draft_stops_after_bounded_retries(self):
        remote = FakeGitHub(self.bundle, exists=False)
        remote.release = mock.Mock(return_value=None)
        with mock.patch.object(release.time, "sleep") as sleep:
            with self.assertRaisesRegex(release.ReleaseError, "exact candidate"):
                release.run_release("prepare", self.bundle, remote, COMMIT)
            self.assertEqual(sleep.call_args_list, [mock.call(1), mock.call(2), mock.call(4)])
        self.assertEqual(remote.release.call_count, 5)
        self.assertEqual(remote.writes, ["create-draft"])

    def test_changed_draft_asset_requires_explicit_replacement_and_keeps_others(self):
        remote = FakeGitHub(self.bundle);remote.data["updates.json"] = b"old"
        with self.assertRaises(release.ReleaseError):
            release.run_release("prepare", self.bundle, remote, COMMIT)
        self.assertEqual(remote.writes, [])
        release.run_release("prepare", self.bundle, remote, COMMIT, replace_draft_assets=True)
        self.assertEqual(remote.writes, [("delete", "updates.json"), ("upload", "updates.json")])

    def test_published_assets_cannot_be_replaced_even_with_replace_flag(self):
        remote = FakeGitHub(self.bundle);remote.draft = False;remote.prerelease = False;remote.data["updates.json"] = b"changed"
        with self.assertRaises(release.ReleaseError):
            release.run_release("prepare", self.bundle, remote, COMMIT, replace_draft_assets=True)
        self.assertEqual(remote.writes, [])

    def test_unreviewed_assets_or_download_corruption_block_publication(self):
        for extra in (False, True):
            remote = FakeGitHub(self.bundle)
            if extra:
                remote.data["unreviewed.txt"] = b"unknown";remote.ids["unreviewed.txt"] = 99
            else:
                remote.download_corrupt = True
            with self.assertRaises(release.ReleaseError):
                release.run_release("publish", self.bundle, remote, COMMIT, self.bundle["xpi_sha256"])
            self.assertEqual(remote.writes, [])

    def test_publish_requires_exact_reviewed_sha_tag_commit_and_public_repository(self):
        for change in ("sha", "commit", "private", "missing"):
            remote = FakeGitHub(self.bundle, exists=change != "missing")
            if change == "commit": remote.commit = "b" * 40
            if change == "private": remote.public = False
            with self.assertRaises(release.ReleaseError):
                release.run_release("publish", self.bundle, remote, COMMIT, "0" * 64 if change == "sha" else self.bundle["xpi_sha256"])
            self.assertEqual(remote.writes, [])

    def test_explicit_publish_promotes_only_reviewed_candidate_and_checks_public_updates(self):
        remote = FakeGitHub(self.bundle);history = copy.deepcopy(remote.history)
        self.assertEqual(release.run_release("publish", self.bundle, remote, COMMIT, self.bundle["xpi_sha256"]), "published-verified")
        self.assertEqual(remote.writes, ["publish-stable-latest"])
        self.assertFalse(remote.draft);self.assertFalse(remote.prerelease);self.assertEqual(remote.history, history)
        self.assertEqual(release.run_release("publish", self.bundle, remote, COMMIT, self.bundle["xpi_sha256"]), "published-verified")
        self.assertEqual(remote.writes, ["publish-stable-latest"])

    def test_changed_release_identity_after_publish_is_not_reported_as_success(self):
        for changed in ("id", "tag_name"):
            remote = FakeGitHub(self.bundle)
            original_read = remote.release
            def read_after_publish(tag):
                value = original_read(tag)
                if not remote.draft:
                    value[changed] = 101 if changed == "id" else "untagged-unexpected"
                    if changed == "id":
                        remote.latest_release["id"] = 101
                return value
            remote.release = read_after_publish
            with self.assertRaisesRegex(release.ReleaseError, "identity changed"):
                release.run_release("publish", self.bundle, remote, COMMIT, self.bundle["xpi_sha256"])
            self.assertEqual(remote.writes, ["publish-stable-latest"])

    def test_newer_latest_or_existing_public_prerelease_is_not_modified(self):
        for prerelease in (False, True):
            remote = FakeGitHub(self.bundle)
            if prerelease:
                remote.draft = False
            else:
                remote.latest_release = {"id": 200, "tag_name": "v9.0.0"}
            with self.assertRaises(release.ReleaseError):
                release.run_release("publish", self.bundle, remote, COMMIT, self.bundle["xpi_sha256"])
            self.assertEqual(remote.writes, [])

    def test_stale_public_update_response_is_reported_without_republishing(self):
        remote = FakeGitHub(self.bundle);remote.public_stale = True
        with self.assertRaises(release.ReleaseError):
            release.run_release("publish", self.bundle, remote, COMMIT, self.bundle["xpi_sha256"])
        self.assertEqual(remote.writes, ["publish-stable-latest"])
        remote.public_stale = False
        self.assertEqual(release.run_release("publish", self.bundle, remote, COMMIT, self.bundle["xpi_sha256"]), "published-verified")
        self.assertEqual(remote.writes, ["publish-stable-latest"])

    def test_verify_is_read_only(self):
        remote = FakeGitHub(self.bundle)
        self.assertEqual(release.run_release("verify", self.bundle, remote, COMMIT), "release-verified")
        self.assertEqual(remote.writes, [])

    def test_tag_or_asset_change_after_verification_blocks_publish(self):
        for changed in ("tag", "asset"):
            remote = FakeGitHub(self.bundle)
            if changed == "tag":
                calls = []
                def moved(_tag):
                    calls.append(_tag)
                    return COMMIT if len(calls) == 1 else "b" * 40
                remote.tag_commit = moved
            else:
                def latest():
                    remote.data["updates.json"] = b"changed after download"
                    return None
                remote.latest = latest
            with self.assertRaises(release.ReleaseError):
                release.run_release("publish", self.bundle, remote, COMMIT, self.bundle["xpi_sha256"])
            self.assertEqual(remote.writes, [])

    def test_cli_blocks_untracked_files_and_expected_commit_spoofing_before_remote(self):
        for changed in ("untracked", "commit"):
            args = ["release.py", "prepare", "--tag", self.bundle["info"]["tag"]]
            if changed == "commit": args += ["--expected-commit", "b" * 40]
            state = mock.Mock(returncode=0, stdout="?? docs/private-notes.txt\n" if changed == "untracked" else "")
            with mock.patch.object(sys, "argv", args), mock.patch.object(release, "load_assets", return_value=self.bundle), \
                 mock.patch.object(release, "verify_checkout"), mock.patch.object(release.subprocess, "run", return_value=state) as status, \
                 mock.patch.object(release.subprocess, "check_output", return_value=COMMIT + "\n"), mock.patch.object(release, "GitHub") as remote:
                with self.assertRaises(release.ReleaseError): release.main()
                self.assertEqual(status.call_args.args[0], ["git", "status", "--porcelain", "--untracked-files=all"])
                remote.assert_not_called()

    def test_local_verification_never_initializes_git_or_github(self):
        with mock.patch.object(sys, "argv", ["release.py", "verify-local"]), mock.patch.object(release, "load_assets", return_value=self.bundle), \
             mock.patch.object(release, "verify_checkout") as verify, mock.patch.object(release.subprocess, "run") as process, \
             mock.patch.object(release, "GitHub") as remote, redirect_stdout(io.StringIO()) as output:
            release.main()
            verify.assert_called_once();process.assert_not_called();remote.assert_not_called()
            self.assertEqual(json.loads(output.getvalue())["result"], "local-build-verified")

    def test_ignored_archive_input_blocks_remote_even_with_clean_git_status(self):
        source_name = f"zotero-fulltext-assistant-{self.bundle['info']['version']}-source.zip"
        with zipfile.ZipFile(self.bundle["directory"] / source_name) as archive:
            names = [name.removeprefix("fulltext-plugin/") for name in archive.namelist()]
        tracked = mock.Mock(returncode=0, stdout="\0".join(names) + "\0")
        with mock.patch.object(release.subprocess, "run", return_value=tracked) as process:
            release.verify_tracked_inputs(self.bundle)
            self.assertEqual(process.call_args.args[0], ["git", "ls-files", "--cached", "-z"])
        names.remove("src/app.js")
        tracked.stdout = "\0".join(names) + "\0"
        clean = mock.Mock(returncode=0, stdout="")
        with mock.patch.object(sys, "argv", ["release.py", "prepare", "--tag", self.bundle["info"]["tag"]]), \
             mock.patch.object(release, "load_assets", return_value=self.bundle), mock.patch.object(release, "verify_checkout"), \
             mock.patch.object(release.subprocess, "run", side_effect=[clean, tracked]), \
             mock.patch.object(release.subprocess, "check_output", return_value=COMMIT + "\n"), mock.patch.object(release, "GitHub") as remote:
            with self.assertRaisesRegex(release.ReleaseError, "ignored or untracked"):
                release.main()
            remote.assert_not_called()


if __name__ == "__main__":
    unittest.main()
