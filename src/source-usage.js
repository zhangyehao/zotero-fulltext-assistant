/* A local reservation counter, not a claim about the provider's account balance. */
(function (global) {
  "use strict";
  function create({ IOUtils, path, directory, digest, now = () => new Date() }) {
    let chain = Promise.resolve();
    function reserve({ provider, limit, key }) {
      const operation = chain.catch(() => {}).then(async () => {
        if (provider !== "openalex" || typeof key !== "string" || !key || !Number.isInteger(limit) || limit < 1 || limit > 1000) return false;
        const day = now().toISOString().slice(0, 10), id = await digest(new TextEncoder().encode(provider + ":" + key));
        let state = { schemaVersion: 1, days: {} };
        try {
          if (await IOUtils.exists(path)) {
            state = JSON.parse(await IOUtils.readUTF8(path));
            if (state?.schemaVersion !== 1 || !state.days || typeof state.days !== "object" || Array.isArray(state.days)) return false;
            for (const [date, records] of Object.entries(state.days)) {
              if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !records || typeof records !== "object" || Array.isArray(records)) return false;
              for (const [hash, count] of Object.entries(records)) if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(count) || count < 0) return false;
            }
          }
          const counts = state.days[day] || {}, used = counts[id] || 0;
          if (used >= limit) return false;
          counts[id] = used + 1;
          state.days[day] = counts;
          for (const date of Object.keys(state.days).sort().slice(0, -7)) delete state.days[date];
          await IOUtils.makeDirectory(directory, { ignoreExisting: true });
          await IOUtils.writeUTF8(path, JSON.stringify(state), { tmpPath: path + ".tmp" });
          return true;
        } catch (_) { return false; }
      });
      chain = operation;
      return operation;
    }
    return { reserve, flush: () => chain };
  }
  global.FulltextSourceUsage = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = { create };
})(globalThis);
