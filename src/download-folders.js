(function (root) {
  "use strict";
  function normalize(values) {
    const seen = new Set(), result = [];
    for (const value of values || []) {
      if (typeof value !== "string") continue;
      const trimmed = value.trim();
      const path = /^(?:[a-z]:[\\/]|\/)$/i.test(trimmed) ? trimmed : trimmed.replace(/[\\/]+$/, "");
      if (!path || path.length > 4096 || !/^(?:[a-z]:[\\/]|\\\\|\/)/i.test(path)) continue;
      const key = path.replace(/\\/g, "/").toLowerCase();
      if (!seen.has(key)) { seen.add(key); result.push(path); }
    }
    return result;
  }
  async function discover({ Services, IOUtils, PathUtils }) {
    const candidates = [];
    const special = key => { try { return Services.dirsvc.get(key, root.Ci?.nsIFile).path; } catch (_) { return ""; } };
    const downloads = special("DfltDwnld"), home = special("Home");
    if (downloads) candidates.push(downloads);
    else if (home) candidates.push(PathUtils.join(home, "Downloads"));
    const local = special("LocalAppData");
    if (local) {
      for (const parts of [["Microsoft", "Edge", "User Data"], ["Google", "Chrome", "User Data"]]) {
        const base = PathUtils.join(local, ...parts);
        let profiles;
        try { profiles = await IOUtils.getChildren(base); } catch (_) { continue; }
        for (const profile of profiles.filter(path => /^(?:Default|Profile \d+)$/.test(PathUtils.filename ? PathUtils.filename(path) : path.split(/[\\/]/).pop())).slice(0, 30)) {
          try {
            const file = PathUtils.join(profile, "Preferences"), info = await IOUtils.stat(file, { followSymlinks: false });
            if (info.type !== "regular" || info.size > 10 * 1024 * 1024) continue;
            // Read only the download-directory setting. No account, cookie,
            // history or credential data is copied, returned or persisted.
            const data = JSON.parse(await IOUtils.readUTF8(file));
            if (typeof data?.download?.default_directory === "string") candidates.push(data.download.default_directory);
          } catch (_) { /* Missing or changing profiles do not prevent setup. */ }
        }
      }
    }
    const result = [];
    for (const path of normalize(candidates)) {
      try { if ((await IOUtils.stat(path, { followSymlinks: false })).type === "directory") result.push(path); } catch (_) {}
    }
    return result;
  }
  root.FulltextDownloadFolders = { normalize, discover };
  if (typeof module !== "undefined" && module.exports) module.exports = root.FulltextDownloadFolders;
})(globalThis);
