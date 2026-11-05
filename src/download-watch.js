/* Watches explicitly armed tasks in one selected folder. No browser access. */
(function (root) {
  "use strict";
  const MAX_BYTES = 100 * 1024 * 1024;
  function create({ IOUtils, PathUtils, inspect, validPDF, onMatch, onIssue = async () => {}, now = () => Date.now(), stableMs = 2000, timeoutMs = 30 * 60 * 1000 }) {
    const records = new Map();
    let stopped = false, running = null;
    const stamp = info => String(info.size) + ":" + String(info.lastModified || 0);
    const current = record => !stopped && records.get(record.id) === record && !record.isCancelled();
    const live = record => current(record) && record.armed && now() < record.expiresAt;
    async function listing(directory) {
      const info = await IOUtils.stat(directory, { followSymlinks: false });
      if (info.type !== "directory") throw new Error("下载文件夹不可用，请在设置中重新选择。");
      const files = new Map();
      for (const path of await IOUtils.getChildren(directory)) {
        if (!/\.pdf$/i.test(PathUtils.filename ? PathUtils.filename(path) : path.split(/[\\/]/).pop())) continue;
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
          await onIssue(record.id, { kind: "expired", message: "等待下载已超过 30 分钟。任务已保留，可再次点击浏览器下载，或使用科研通兜底。" });
        }
      }
      const directories = new Set([...records.values()].filter(live).flatMap(record => record.directories));
      for (const directory of directories) {
        const group = [...records.values()].filter(record => record.directories.includes(directory) && live(record));
        let files;
        try { files = await listing(directory); }
        catch (_) {
          for (const record of group.filter(live)) {
            records.delete(record.id);
            await onIssue(record.id, { kind: "directory", message: "无法读取下载文件夹。请重新选择文件夹后继续；科研通兜底仍可使用。" });
          }
          continue;
        }
        let processed = 0;
        for (const [path, file] of files) {
          const eligible = [];
          for (const record of group.filter(live)) {
            if (record.baseline.get(path) === file.stamp || record.checked.get(path) === file.stamp) continue;
            const old = record.seen.get(path);
            if (!old || old.stamp !== file.stamp) { record.seen.set(path, { stamp: file.stamp, since: now() }); continue; }
            if (now() - old.since < stableMs || file.info.size < 1024 || file.info.size > MAX_BYTES) continue;
            eligible.push(record);
          }
          if (!eligible.length) continue;
          if (processed++ >= 8) break;
          let bytes;
          try {
            bytes = await IOUtils.read(path);
            const after = await IOUtils.stat(path, { followSymlinks: false });
            if (after.type !== "regular" || stamp(after) !== file.stamp || bytes.length !== after.size || !validPDF(bytes)) continue;
          } catch (_) { continue; }
          const matches = [];
          for (const record of eligible.filter(live)) {
            let identity;
            try { identity = await inspect(path, record.expected, { bytes }); }
            catch (_) { identity = { status: "unknown" }; }
            if (!live(record)) continue;
            record.checked.set(path, file.stamp);
            if (identity.status === "match") matches.push({ record, identity });
          }
          const current = matches.filter(match => live(match.record));
          if (current.length > 1) {
            for (const { record } of current) await onIssue(record.id, { kind: "ambiguous", message: "新 PDF 同时匹配多个等待任务，未自动选择条目。请在对应任务中选择此 PDF。" });
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
        const record = { id, directories, expected: { ...expected }, isCancelled, armed: false, baseline: new Map(), seen: new Map(), checked: new Map(), expiresAt: now() + timeoutMs };
        records.set(id, record);
        try {
          for (const folder of directories) {
            const files = await listing(folder);
            if (!current(record)) return false;
            for (const [path, file] of files) record.baseline.set(path, file.stamp);
          }
          record.armed = true;return true;
        } catch (error) { if (records.get(id) === record) records.delete(id); throw error; }
      },
      cancel(id) { records.delete(id); },
      isWatching(id) { const record = records.get(id); return !!record && live(record); },
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
