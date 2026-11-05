/* Watches explicitly armed tasks in one selected folder. No browser access. */
(function (root) {
  "use strict";
  const MAX_BYTES = 100 * 1024 * 1024;
  function create({ IOUtils, PathUtils, inspect, validPDF, onMatch, onCandidate = async () => {}, onIssue = async () => {}, now = () => Date.now(), stableMs = 2000, timeoutMs = 30 * 60 * 1000 }) {
    const records = new Map(), diagnostics = new Map();
    let stopped = false, running = null;
    const stamp = info => String(info.size) + ":" + String(info.lastModified || 0);
    const current = record => !stopped && records.get(record.id) === record && !record.isCancelled();
    const live = record => current(record) && record.armed && now() < record.expiresAt;
    const filename = path => PathUtils.filename ? PathUtils.filename(path) : path.split(/[\\/]/).pop();
    const timeValue = value => typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
    async function issue(record, details) {
      record.stats.lastReason = details.reason || details.kind;
      record.stats.lastMessage = details.message;
      await onIssue(record.id, details);
    }
    async function rejected(records, path, file, reason, message, { retry = false } = {}) {
      for (const record of records.filter(live)) {
        const key = file.stamp + ":" + reason;
        if (record.reported.get(path) === key) continue;
        record.reported.set(path, key);if (!retry) record.checked.set(path, file.stamp);
        record.stats.rejected++;
        await issue(record, { kind: "file", path, filename: filename(path), reason, message });
      }
    }
    async function listing(directory) {
      const info = await IOUtils.stat(directory, { followSymlinks: false });
      if (info.type !== "directory") throw new Error("下载文件夹不可用，请在设置中重新选择。");
      const files = new Map();
      for (const path of await IOUtils.getChildren(directory)) {
        if (!/\.pdf$/i.test(filename(path))) continue;
        try {
          const file = await IOUtils.stat(path, { followSymlinks: false });
          if (file.type === "regular") files.set(path, { info: file, stamp: stamp(file) });
        } catch (_) { /* A browser may rename or remove a download mid-scan. */ }
      }
      return files;
    }
    async function scan() {
      for (const record of [...records.values()]) {
        if (!current(record)) { if (records.get(record.id) === record) records.delete(record.id); continue; }
        if (now() >= record.expiresAt) {
          records.delete(record.id);
          await issue(record, { kind: "expired", message: "等待下载已超过 30 分钟。任务已保留，可重新检查已下载文件，或使用科研通兜底。" });
        }
      }
      const directories = new Set([...records.values()].filter(live).flatMap(record => record.directories));
      for (const directory of directories) {
        const group = [...records.values()].filter(record => record.directories.includes(directory) && live(record));
        for (const record of group) record.stats.lastScanAt = new Date(now()).toISOString();
        let files;
        try { files = await listing(directory); }
        catch (_) {
          for (const record of group.filter(live)) {
            records.delete(record.id);
            await issue(record, { kind: "directory", message: "无法读取下载文件夹。请重新选择文件夹后继续；科研通兜底仍可使用。" });
          }
          continue;
        }
        let processed = 0;
        for (const [path, file] of files) {
          const eligible = [];
          for (const record of group.filter(live)) {
            if (record.baseline.get(path) === file.stamp || record.checked.get(path) === file.stamp) continue;
            const old = record.seen.get(path);
            if (!old || old.stamp !== file.stamp) { record.seen.set(path, { stamp: file.stamp, since: now() });record.stats.seen++;continue; }
            if (now() - old.since < stableMs) continue;
            if (file.info.size < 1024 || file.info.size > MAX_BYTES) {
              await rejected([record], path, file, "file_size", "发现 PDF，但文件大小不在 1 KiB 至 100 MiB 的自动检查范围内。请人工核对。");continue;
            }
            eligible.push(record);
          }
          if (!eligible.length) continue;
          if (processed++ >= 8) break;
          let bytes;
          try {
            bytes = await IOUtils.read(path);
            const after = await IOUtils.stat(path, { followSymlinks: false });
            if (after.type !== "regular" || stamp(after) !== file.stamp || bytes.length !== after.size) continue;
            if (!validPDF(bytes)) { await rejected(eligible, path, file, "invalid_pdf", "发现 PDF 文件名，但内容不是完整有效的 PDF。请确认下载已完成。");continue; }
          } catch (_) { await rejected(eligible, path, file, "read_failed", "发现 PDF，但暂时无法读取；将继续检查。", { retry: true });continue; }
          const matches = [];
          for (const record of eligible.filter(live)) {
            let identity;
            try { identity = await inspect(path, record.expected, { bytes }); }
            catch (_) { identity = { status: "unknown", reason: "extraction_failed", message: "PDF 文字提取未完成，请预览后人工核对。" }; }
            if (!live(record)) continue;
            record.checked.set(path, file.stamp);
            record.stats.scanned++;
            if (identity.status === "match") { record.stats.matched++;matches.push({ record, identity }); }
            else {
              const mismatch = identity.status === "mismatch";
              record.stats[mismatch ? "mismatched" : "unknown"]++;
              const reason = identity.reason || (mismatch ? "identity_mismatch" : "identity_unknown");
              const message = "已检查“" + filename(path) + "”：" + (identity.message || (mismatch ? "文献身份与此任务不符，未导入。" : "身份尚不能自动确认，可预览后人工核对。"));
              await issue(record, { kind: "identity", path, filename: filename(path), status: mismatch ? "mismatch" : "unknown", reason, message });
              if (!mismatch && live(record)) await onCandidate(record.id, { path, bytes, identity: { ...identity, status: "unknown" }, expected: { ...record.expected } });
            }
          }
          const current = matches.filter(match => live(match.record));
          if (current.length > 1) {
            for (const { record } of current) await issue(record, { kind: "ambiguous", message: "新 PDF 同时匹配多个等待任务，未自动选择条目。请在对应任务中选择此 PDF。" });
          } else if (current.length === 1) {
            const { record, identity } = current[0];
            // poll() serializes handoffs. Keep the record registered so a
            // cancellation or replacement during the callback remains final.
            const accepted = await onMatch(record.id, { path, bytes, identity, expected: record.expected });
            if (records.get(record.id) !== record) continue;
            if (accepted === false) { if (live(record)) record.checked.delete(path); }
            else records.delete(record.id);
          }
        }
      }
    }
    const api = {
      async start(id, directory, expected, { isCancelled = () => false } = {}) {
        if (stopped) throw new Error("下载检查已停止。");
        const directories = Array.isArray(directory) ? [...new Set(directory)] : [directory];
        if (!directories.length || directories.some(value => !value)) throw new Error("请先设置下载文件夹。");
        const stats = { startedAt: new Date(now()).toISOString(), lastScanAt: null, baseline: 0, seen: 0, scanned: 0, unknown: 0, mismatched: 0, matched: 0, rejected: 0, lastReason: "", lastMessage: "" };
        const record = { id, directories, expected: { ...expected }, isCancelled, armed: false, baseline: new Map(), seen: new Map(), checked: new Map(), reported: new Map(), stats, expiresAt: now() + timeoutMs };
        records.set(id, record);
        diagnostics.set(id, stats);if (diagnostics.size > 200) diagnostics.delete(diagnostics.keys().next().value);
        try {
          for (const folder of directories) {
            const files = await listing(folder);
            if (!current(record)) return false;
            for (const [path, file] of files) record.baseline.set(path, file.stamp);
          }
          stats.baseline = record.baseline.size;
          record.armed = true;return true;
        } catch (error) { if (records.get(id) === record) records.delete(id); throw error; }
      },
      cancel(id) { records.delete(id); },
      isWatching(id) { const record = records.get(id); return !!record && live(record); },
      getStatus(id) { const stats = diagnostics.get(id);return stats ? { ...stats, watching: api.isWatching(id) } : null; },
      async rescan(id, { includeExisting = false, since } = {}) {
        if (running) await running;
        const record = records.get(id);if (!record || !live(record)) throw new Error("请先开始此任务的下载检查。");
        const cutoff = timeValue(since);
        if (includeExisting && !Number.isFinite(cutoff)) throw new Error("重查已下载文件需要有效的起始时间。");
        let eligible = 0;
        for (const directory of record.directories) {
          const files = await listing(directory);if (!live(record)) return { eligible: 0, cancelled: true };
          for (const [path, file] of files) {
            const recent = Math.max(timeValue(file.info.lastModified) || 0, timeValue(file.info.creationTime) || 0) >= cutoff;
            if (record.baseline.get(path) === file.stamp && (!includeExisting || !recent)) continue;
            record.baseline.delete(path);record.checked.delete(path);record.seen.delete(path);record.reported.delete(path);eligible++;
          }
        }
        record.stats.baseline = record.baseline.size;record.expiresAt = now() + timeoutMs;
        return { eligible, cancelled: false };
      },
      poll() {
        if (running) return running;
        if (stopped || !records.size) return Promise.resolve();
        running = scan().finally(() => { running = null; });
        return running;
      },
      async stop() { stopped = true; records.clear(); if (running) await running; },
    };
    return api;
  }
  root.FulltextDownloadWatch = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = root.FulltextDownloadWatch;
})(globalThis);
