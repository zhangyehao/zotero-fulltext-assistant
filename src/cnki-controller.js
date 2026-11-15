/* Explicit CNKI metadata operations. Network parsing and PDF acquisition live
 * in publisher.js; this controller never purchases or imports a candidate PDF. */
(function (root) {
  "use strict";
  const PREF = "extensions.fulltext-assistant.cnkiEnabled";
  const HOSTS = ["cnki.net", "kns.cnki.net", "kns8.cnki.net", "kns8s.cnki.net", "oversea.cnki.net", "login.cnki.net", "passport.cnki.net", "fsso.cnki.net", "cnki.com.cn", "www.cnki.com.cn"];
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const clean = (value, limit = 2000) => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, limit) : "";
  const titleKey = value => clean(value).normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
  function create({ Zotero, Services, cnki, publisher, publisherSession, publisherWindow, emit = () => {}, beforeReset = async () => {}, isProtected = () => false }) {
    let stopped = false, epoch = 0, running = null, resetRun = null, mutationRun = null, previewURL = null;
    const emptyReferences = () => ({ state: "idle", items: [], total: null, message: "" });
    let state = { enabled: Services.prefs.getBoolPref(PREF, true), checking: false, state: "idle", message: "", lastCheckedAt: null, record: null, metadata: null, canImport: false, references: emptyReferences() };
    const abort = () => { const error = new Error("知网操作已取消。"); error.name = "AbortError"; return error; };
    const active = () => { if (stopped || resetRun) throw abort(); };
    function getSnapshot() {
      const hosts = publisherSession?.getStatus()?.hosts || [];
      return clone({ ...state, checking: !!(state.checking || running || mutationRun || resetRun), sessionRemembered: hosts.some(host => /(?:^|\.)cnki\.(?:net|com\.cn)$/.test(host)), canEnrich: !state.checking && !running && !mutationRun && !resetRun });
    }
    function notify(patch) { state = { ...state, ...patch }; if (!stopped) emit(); }
    function selected() { return Zotero.getActiveZoteroPane?.()?.getSelectedItems?.().filter(item => item?.isRegularItem?.() && !item.deleted) || []; }
    function metadata(value) {
      if (!value || typeof value !== "object") return null;
      const result = {};
      for (const field of ["title", "doi", "abstract", "journal", "date", "volume", "issue", "pages", "issn", "isbn", "itemType"]) result[field] = clean(value[field], field === "abstract" ? 20000 : 2000);
      result.authors = (Array.isArray(value.authors) ? value.authors : []).map(value => clean(value, 300)).filter(Boolean).slice(0, 100);
      result.keywords = (Array.isArray(value.keywords) ? value.keywords : []).map(value => clean(value, 200)).filter(Boolean).slice(0, 40);
      result.doi = normalizeDOI(result.doi);
      return result;
    }
    function normalizeDOI(value) { const text = clean(value).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi\s*:\s*/i, ""); return /^10\.\d{4,9}\/[^\s<>]+$/i.test(text) ? text.toLowerCase() : ""; }
    function safeReferenceURL(value) {
      const page = cnki.pageURL(value); if (!page) return "";
      const url = new URL(page);
      return /^\/Article\/[A-Z0-9_]+-[A-Z0-9_.-]+\.htm$/i.test(url.pathname) ? url.origin + url.pathname : cnki.safeArticleURL(page) || "";
    }
    function resultPatch(result) {
      const record = cnki.normalizeRecord(result?.record), data = metadata(result?.metadata);
      const usable = !!record && !!data?.title && ["pdf_available", "metadata_only", "caj_only", "purchase_required", "access_denied", "login_required", "human_verification"].includes(result?.status);
      const statusMap = { pdf_available: "metadata_ready", metadata_only: "metadata_ready", login_required: "login_required", human_verification: "human_verification", purchase_required: "purchase_required", access_denied: "access_denied", caj_only: "caj_only", article_mismatch: "error", metadata_unavailable: "not_found", record_unavailable: "not_found", unsupported_url: "error", needs_url: "no_sample", disabled: "idle" };
      const messages = {
        pdf_available: "已解析文献元数据并发现 PDF 入口；实际下载和论文身份仍需核对。",
        metadata_only: "已解析文献元数据；此页面尚未提供可确认的 PDF 入口。",
        login_required: "知网需要网页登录；保存会话不代表具有此文献的下载权限。",
        human_verification: "知网要求人工验证，请在网页登录窗口完成后重试。",
        purchase_required: "页面要求购买或授权；插件不会自动下单。",
        access_denied: "当前会话没有此文献的下载权限。",
        caj_only: "此页面仅发现 CAJ 入口；本插件只自动导入经核对的 PDF。",
        article_mismatch: "页面文献与原条目的知网编号、DOI 或标题不一致，未导入。",
        metadata_unavailable: "此页面未提供足够的文献元数据，请核对详情页链接。",
        record_unavailable: "未能确认知网文献编号，请使用具体文献的详情页。",
        unsupported_url: "请输入知网文献详情页链接。",
        needs_url: "请先选择带知网详情页的条目，或粘贴知网详情页链接。",
        disabled: "知网解析已关闭。",
      };
      return { state: statusMap[result?.status] || "error", message: messages[result?.status] || "知网页面暂时无法解析，请稍后重试。", record, metadata: data, canImport: usable, lastCheckedAt: new Date().toISOString() };
    }
    async function inspect(input) {
      active(); if (!state.enabled) throw new Error("请先开启知网解析。");
      if (running || mutationRun) throw new Error("知网操作正在进行，请稍候。");
      const ticket = ++epoch;
      previewURL = null;
      notify({ checking: true, state: "checking", message: "正在解析知网文献…", canImport: false, references: emptyReferences() });
      const operation = (async () => {
        try {
          const result = await publisher.inspectCNKI(input, { isCancelled: () => stopped || epoch !== ticket });
          if (stopped || epoch !== ticket) throw abort();
          const patch = resultPatch(result);
          previewURL = patch.record ? cnki.pageURL(input) || patch.record.url : null;
          notify(patch); return getSnapshot();
        } catch (error) {
          if (error.name !== "AbortError" && !stopped && epoch === ticket) notify({ state: "error", message: "知网页面请求失败，请检查网络或完成网页登录后重试。", canImport: false, lastCheckedAt: new Date().toISOString() });
          throw error.name === "AbortError" ? error : new Error("知网页面请求失败，请检查网络或完成网页登录后重试。");
        } finally { if (epoch === ticket) notify({ checking: false }); }
      })();
      running = operation;
      try { await operation; } finally { if (running === operation) running = null; if (!stopped) emit(); }
      return getSnapshot();
    }
    function libraryContext() {
      const pane = Zotero.getActiveZoteroPane?.();
      const libraryID = pane?.getSelectedLibraryID?.() || Zotero.Libraries.userLibraryID;
      const library = Zotero.Libraries.get(libraryID);
      if (!library?.editable) throw new Error("当前文库不能编辑条目。");
      const collection = pane?.getSelectedCollection?.();
      return { libraryID, collectionID: collection?.libraryID === libraryID ? collection.id : null };
    }
    async function search(field, operator, value, libraryID) {
      const query = new Zotero.Search(); if (libraryID) query.libraryID = libraryID;
      query.addCondition(field, operator, value);
      const ids = await query.search();
      const result = [];
      for (const id of ids) { const item = await Zotero.Items.getAsync(id); if (item?.isRegularItem?.() && !item.deleted && (!libraryID || item.libraryID === libraryID)) result.push(item); }
      return result;
    }
    async function duplicate(record, data, libraryID) {
      const candidates = new Map();
      for (const [field, operator, value] of [["extra", "contains", record.id], ["url", "contains", record.filename], ...(data.doi ? [["DOI", "is", data.doi]] : [])])
        for (const item of await search(field, operator, value, libraryID)) candidates.set(item.id, item);
      for (const item of candidates.values()) {
        const current = cnki.fromItem(item), itemDOI = normalizeDOI(item.getField("DOI") || item.getExtraField?.("DOI"));
        if (current?.id === record.id) return item;
        if (data.doi && itemDOI === data.doi) {
          if (current || titleKey(item.getField("title")) !== titleKey(data.title)) throw new Error("已有相同 DOI 的条目，但知网编号或标题不同，请先核对文库中的条目。");
          return item;
        }
      }
      return null;
    }
    function fieldValues(data, record) {
      return { title: data.title, DOI: data.doi, abstractNote: data.abstract, publicationTitle: data.journal, date: data.date,
        volume: data.volume, issue: data.issue, pages: data.pages, ISSN: data.issn, ISBN: data.isbn, url: record?.url || data.url || "", libraryCatalog: "中国知网 (CNKI)" };
    }
    function fill(item, data, record) {
      let changed = false; const extraLines = [];
      for (const [field, value] of Object.entries(fieldValues(data, record))) {
        if (!value || item.getField(field)) continue;
        const fieldID = Zotero.ItemFields?.getID?.(field);
        if (fieldID && Zotero.ItemFields?.isValidForType && !Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)) { if (field === "DOI") extraLines.push("DOI: " + value); continue; }
        item.setField(field, value); changed = true;
      }
      if (!item.getCreators?.().length && data.authors.length) {
        const creatorType = item.itemType === "patent" ? "inventor" : "author";
        item.setCreators(data.authors.map(name => ({ creatorType, firstName: "", lastName: name, fieldMode: 1 }))); changed = true;
      }
      const originalExtra = item.getField("extra") || "";
      if (record && !/^CNKI(?: ID)?\s*:/im.test(originalExtra)) extraLines.push("CNKI: " + record.id);
      if (record && !/^CNKI URL\s*:/im.test(originalExtra)) extraLines.push("CNKI URL: " + record.url);
      const additions = extraLines.filter(line => !originalExtra.split(/\r?\n/).includes(line));
      if (additions.length) { item.setField("extra", [originalExtra, ...additions].filter(Boolean).join("\n")); changed = true; }
      return changed;
    }
    function fingerprint(item) {
      return JSON.stringify([item.id, item.key, item.libraryID, item.deleted, item.itemTypeID, ...["title", "DOI", "url", "extra"].map(field => item.getField(field)), cnki.fromItem(item)?.id || ""]);
    }
    function mutate(action) {
      active(); if (!state.enabled) throw new Error("请先开启知网解析。");
      if (mutationRun || running) throw new Error("知网操作正在进行，请稍候。");
      const ticket = epoch;
      const check = () => { if (stopped || ticket !== epoch) throw abort(); };
      // Install the guard before action() gets the opportunity to await.
      const operation = Promise.resolve().then(() => action(check)); mutationRun = operation; emit();
      return operation.finally(() => { if (mutationRun === operation) mutationRun = null; if (!stopped) emit(); });
    }
    return {
      getSnapshot,
      saveSettings({ enabled }) { active(); if (typeof enabled !== "boolean") throw new Error("知网设置无效。"); if (running || mutationRun) throw new Error("请等待知网操作完成后再修改设置。"); Services.prefs.setBoolPref(PREF, enabled); notify({ enabled, canImport: enabled && state.canImport }); return getSnapshot(); },
      async openLogin() {
        active(); if (running || mutationRun) throw new Error("知网操作正在进行，请稍候。");
        const ticket = epoch;
        const operation = Promise.resolve().then(async () => {
          await publisherSession?.grantHosts(HOSTS); if (stopped || ticket !== epoch) throw abort();
          publisherWindow.open({ url: "https://kns.cnki.net/", purpose: "cnki" });
          notify({ message: "请在知网窗口完成登录；会话按网站有效期保存，随后可验证所选文献。" }); return getSnapshot();
        });
        running = operation; emit();
        try { await operation; } finally { if (running === operation) running = null; if (!stopped) emit(); }
        return getSnapshot();
      },
      inspectURL(url) { if (!cnki.pageURL(url)) throw new Error("请输入知网文献详情页链接。"); return inspect(url); },
      async verify() {
        active(); const ticket = epoch, candidates = selected(); let sample = candidates.find(item => cnki.fromItem(item) || cnki.pageURL(item));
        if (!sample) sample = (await search("url", "contains", "cnki.")).find(item => cnki.fromItem(item) || cnki.pageURL(item));
        active(); if (ticket !== epoch) throw abort();
        if (!sample) { notify({ state: "no_sample", message: "请先选择带知网详情页的条目，或粘贴知网详情页链接。", canImport: false, record: null, metadata: null }); return getSnapshot(); }
        return inspect(sample);
      },
      importPreview() {
        if (!state.canImport || !state.record || !state.metadata) throw new Error("请先解析并核对知网文献预览。");
        const record = clone(state.record), data = clone(state.metadata), context = libraryContext();
        return mutate(async check => {
          check(); const existing = await duplicate(record, data, context.libraryID); check();
          if (existing) return { imported: false, existing: true, itemID: existing.id, title: existing.getField("title"), message: "文库中已有这篇文献，未重复导入。" };
          if (!Zotero.Libraries.get(context.libraryID)?.editable) throw new Error("当前文库不能编辑条目。");
          const type = ["journalArticle", "thesis", "newspaperArticle", "conferencePaper", "patent"].includes(data.itemType) ? data.itemType : "journalArticle";
          const item = new Zotero.Item(type); item.libraryID = context.libraryID; fill(item, data, record);
          if (context.collectionID) item.setCollections([context.collectionID]);
          check(); await item.saveTx();
          // A committed metadata item is real, including if shutdown raced save.
          return { imported: true, existing: false, itemID: item.id, title: data.title, message: "已导入文献元数据；可右键批量获取全文。" };
        });
      },
      enrichSelected(items = selected()) {
        const ids = [...new Set(items.filter(item => item?.isRegularItem?.() && !item.deleted).map(item => item.id))];
        return mutate(async check => {
          const summary = { selected: ids.length, updated: 0, unchanged: 0, skipped: 0, failed: 0, message: "" };
          try { for (const id of ids) {
            check(); const item = await Zotero.Items.getAsync(id); check();
            if (!item || item.deleted || !(cnki.fromItem(item) || cnki.pageURL(item)) || !Zotero.Libraries.get(item.libraryID)?.editable || isProtected(item)) { summary.skipped++; continue; }
            const original = fingerprint(item), originalRecord = cnki.fromItem(item);
            try {
              const result = await publisher.inspectCNKI(item, { isCancelled: () => { try { check(); return false; } catch (_) { return true; } } });
              check(); const preview = resultPatch(result), current = await Zotero.Items.getAsync(id); check();
              if (!current || current.deleted || fingerprint(current) !== original || !Zotero.Libraries.get(current.libraryID)?.editable || isProtected(current)) { summary.skipped++; continue; }
              if (!preview.canImport || originalRecord && preview.record.id !== originalRecord.id) { summary.failed++; continue; }
              if (!fill(current, preview.metadata, preview.record)) { summary.unchanged++; continue; }
              check(); await current.saveTx(); summary.updated++;
            } catch (error) { if (error.name === "AbortError") throw error; summary.failed++; }
          } } catch (error) { if (error.name !== "AbortError") throw error; summary.cancelled = true; }
          summary.message = summary.cancelled ? "操作已取消，已保存的条目保留。" : "知网元数据补全已完成。"; notify({ summary }); return summary;
        });
      },
      async fetchReferences() {
        active(); if (!state.enabled) throw new Error("请先开启知网解析。");
        if (running || mutationRun) throw new Error("知网操作正在进行，请稍候。");
        if (!state.record || !previewURL) throw new Error("请先解析知网文献，再提取参考文献。");
        const expectedID = state.record.id, address = previewURL, ticket = ++epoch;
        notify({ checking: true, references: { ...emptyReferences(), state: "loading", message: "正在读取此文献的参考文献列表…" } });
        const operation = (async () => {
          try {
            const result = await publisher.inspectCNKI(address, { includeReferences: true, isCancelled: () => stopped || ticket !== epoch });
            if (stopped || ticket !== epoch) throw abort();
            if (cnki.normalizeRecord(result.record)?.id !== expectedID || result.status === "article_mismatch") throw new Error("参考文献页面与预览文献不一致。");
            const parsed = result.references, rows = [], ids = new Set();
            for (const entry of Array.isArray(parsed?.references) ? parsed.references.slice(0, 500) : []) {
              const id = clean(entry.id, 200); if (!id || ids.has(id)) continue; ids.add(id);
              const record = cnki.normalizeRecord(entry.record || entry.url), doi = normalizeDOI(entry.doi), title = clean(entry.title);
              rows.push({ id, title, authors: (Array.isArray(entry.authors) ? entry.authors : []).map(name => clean(name, 300)).filter(Boolean).slice(0, 100), authorText: clean(entry.authorText), year: /^\d{4}$/.test(String(entry.year || "")) ? String(entry.year) : "", doi, record,
                url: record?.url || safeReferenceURL(entry.url) || (doi ? "https://doi.org/" + doi : ""), raw: clean(entry.raw, 8000), group: clean(entry.group, 100),
                itemType: ["journalArticle", "conferencePaper", "thesis", "newspaperArticle"].includes(entry.itemType) ? entry.itemType : "document",
                canImport: entry.canImport === true && !!title });
            }
            const gates = ["login_required", "human_verification", "access_denied"];
            const gate = gates.includes(result.status) ? result.status : gates.includes(parsed?.status) ? parsed.status : null;
            const complete = parsed?.complete === true && parsed?.partial !== true;
            const status = gate || (rows.length ? complete ? "ready" : "partial" : "unavailable");
            const message = gate === "login_required" ? "参考文献列表需要知网页登录，请完成后重试。" : gate === "human_verification" ? "参考文献列表需要人工验证，请在知网窗口完成后重试。" : gate === "access_denied" ? "当前会话没有参考文献列表的访问权限。" : rows.length ? complete ? "已读取网站提供的参考文献列表，请核对后选择导入。" : "仅取得网站当前提供的部分参考文献；未混入引证文献或二级参考文献。" : "网站暂未提供可解析的参考文献列表；这不表示原文没有参考文献。";
            notify({ references: { state: status, items: rows, total: Number.isSafeInteger(parsed?.totalCount) && parsed.totalCount >= 0 ? parsed.totalCount : null, message } });
          } catch (error) {
            if (error.name === "AbortError") throw error;
            if (!stopped && ticket === epoch) notify({ references: { ...emptyReferences(), state: "error", message: "参考文献提取失败，请核对原文页面后重试。" } });
          } finally { if (ticket === epoch) notify({ checking: false }); }
        })();
        running = operation;
        try { await operation; } finally { if (running === operation) running = null; if (!stopped) emit(); }
        return getSnapshot();
      },
      importReferences(requestedIDs) {
        if (!Array.isArray(requestedIDs) || requestedIDs.length < 1 || requestedIDs.length > 50 || requestedIDs.some(id => typeof id !== "string")) throw new Error("每次请选择 1 至 50 条参考文献。");
        const source = clone(state.record), context = libraryContext(), ids = [...new Set(requestedIDs)];
        const selected = ids.map(id => state.references.items.find(entry => entry.id === id)).filter(Boolean).map(clone);
        if (!source || selected.length !== ids.length || selected.some(entry => !entry.canImport || !entry.title)) throw new Error("所选参考文献无法可靠识别，请重新提取并核对。");
        return mutate(async check => {
          const summary = { imported: 0, existing: 0, skipped: 0, failed: 0, message: "参考文献导入处理已完成。" };
          try { for (const entry of selected) {
            check();
            try {
              const data = metadata({ title: entry.title, doi: entry.doi, authors: entry.authors, date: entry.year, itemType: "document" }); data.url = entry.url;
              let existing = entry.record ? await duplicate(entry.record, data, context.libraryID) : null;
              if (!existing && entry.doi) {
                const matches = await search("DOI", "is", entry.doi, context.libraryID);
                if (matches.some(item => titleKey(item.getField("title")) !== titleKey(entry.title))) throw new Error("参考文献 DOI 与已有条目标题冲突。");
                existing = matches[0];
              }
              if (!existing && !entry.doi && !entry.record) {
                const matches = await search("title", "is", entry.title, context.libraryID);
                existing = matches.find(item => {
                  const extra = item.getField("extra");
                  // Exact repeated citation from the same parent is evidence;
                  // generic equal titles such as Introduction alone are not.
                  if (entry.raw && extra.split(/\r?\n/).includes("CNKI Reference Source: " + source.id) && extra.split(/\r?\n/).includes("CNKI Reference Text: " + entry.raw.replace(/\r?\n/g, " "))) return true;
                  const authors = item.getCreators?.().map(person => titleKey([person.firstName, person.lastName].filter(Boolean).join(" "))) || [];
                  return titleKey(entry.title).length >= 16 && entry.year && item.getField("date").includes(entry.year) && entry.authors.length > 0 && entry.authors.every(author => authors.includes(titleKey(author)));
                });
              }
              check(); if (existing) { summary.existing++; continue; }
              if (!Zotero.Libraries.get(context.libraryID)?.editable) { summary.skipped++; continue; }
              const type = entry.itemType || "document";
              const item = new Zotero.Item(type); item.libraryID = context.libraryID; fill(item, data, entry.record);
              item.setField("extra", [item.getField("extra"), "CNKI Reference Source: " + source.id, entry.raw ? "CNKI Reference Text: " + entry.raw.replace(/\r?\n/g, " ") : "", entry.authorText ? "CNKI Reference Authors: " + entry.authorText.replace(/\r?\n/g, " ") : ""].filter(Boolean).join("\n"));
              if (context.collectionID) item.setCollections([context.collectionID]);
              check(); await item.saveTx(); summary.imported++;
            } catch (error) { if (error.name === "AbortError") throw error; summary.failed++; }
          } } catch (error) { if (error.name !== "AbortError") throw error; summary.cancelled = true; summary.message = "操作已取消，已保存的条目保留。"; }
          return summary;
        });
      },
      resetSession() {
        if (resetRun) return resetRun; active(); epoch++;
        const operation = (async () => {
          await Promise.allSettled([running, mutationRun]);
          if (stopped) throw abort();
          await beforeReset();
          if (stopped) throw abort();
          publisherWindow.closePurpose?.("cnki");
          await publisherSession.forgetHosts(["cnki.net", "cnki.com.cn"], { clearCookies: true });
          previewURL = null;
          notify({ state: "idle", checking: false, message: "知网登录已重置；其他出版社登录保持不变。", record: null, metadata: null, canImport: false, lastCheckedAt: null, references: emptyReferences() });
          return getSnapshot();
        })();
        resetRun = operation; emit();
        return operation.finally(() => { if (resetRun === operation) resetRun = null; if (!stopped) emit(); }).then(() => getSnapshot());
      },
      async destroy() { stopped = true; epoch++; await Promise.allSettled([running, mutationRun, resetRun]); },
    };
  }
  const api = { create };
  root.FulltextCNKIController = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(globalThis);
