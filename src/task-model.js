/* Pure task data model. No network access, website submission, or credential storage. */
(function (root) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const DEFAULT_POINTS = 10;
  const STATES = Object.freeze([
    "pending_login", "ready_to_check", "waiting", "available", "needs_review",
    "paused", "imported", "error", "queued", "resolving", "not_found",
    "submitting", "submission_unknown", "downloading", "closed", "needs_login",
    "browser_waiting", "browser_scanning", "browser_downloading", "manual_waiting", "manual_review",
  ]);
  const stateSet = new Set(STATES);
  const secretQueryNames = /^(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|key|session(?:[_-]?id)?|password|pass|pwd|secret|signature|sig|auth(?:orization)?|cookie|code)$/i;

  function text(value, maximum) {
    return typeof value === "string" ? value.trim().slice(0, maximum) : "";
  }

  function validatePoints(value) {
    let points = value;
    if (typeof points === "string") {
      const normalized = points.trim();
      if (!/^[1-9]\d*$/.test(normalized)) {
        throw new TypeError("Points must be an integer from 1 to 10000");
      }
      points = Number(normalized);
    }
    if (typeof points !== "number" || !Number.isSafeInteger(points)) {
      throw new TypeError("Points must be an integer from 1 to 10000");
    }
    if (points < 1 || points > 10000) {
      throw new RangeError("Points must be an integer from 1 to 10000");
    }
    return points;
  }

  function normalizeDOI(value) {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value !== "string") throw new TypeError("DOI must be text");
    let doi = value.trim().replace(/^doi\s*:\s*/i, "").trim();
    if (!doi) return "";
    if (/^https?:\/\//i.test(doi)) {
      let url;
      try { url = new URL(doi); } catch (_) { throw new TypeError("Invalid DOI URL"); }
      if (!/^(?:dx\.)?doi\.org$/i.test(url.hostname) || url.username || url.password ||
          url.port || url.search || url.hash) {
        throw new TypeError("Use a DOI or an unqualified doi.org URL");
      }
      try { doi = decodeURIComponent(url.pathname.slice(1)); }
      catch (_) { throw new TypeError("Invalid DOI URL encoding"); }
    }
    // Validate the entire value. Do not extract a DOI from prose or silently join words.
    if (doi.length > 2048 || !/^10\.\d{4,9}\/[^\s<>\x00-\x1f\x7f]+$/i.test(doi)) {
      throw new TypeError("Invalid DOI; supply only the DOI, without surrounding prose");
    }
    return doi.toLowerCase();
  }

  function parseRequestURL(value) {
    if (typeof value !== "string") throw new TypeError("Request URL must be text");
    const raw = value.trim();
    const match = /^(https):\/\/([^/]+)(\/assist\/detail)\?id=([A-Za-z0-9]+)$/i.exec(raw);
    if (!match || match[2].toLowerCase() !== "www.ablesci.com" ||
        match[3] !== "/assist/detail" || match[4].length > 128) {
      throw new TypeError("Use https://www.ablesci.com/assist/detail?id= followed by an alphanumeric request ID");
    }
    return {
      requestID: match[4],
      requestURL: "https://www.ablesci.com/assist/detail?id=" + match[4],
    };
  }

  function cleanOfficialURL(value) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const url = new URL(value.trim());
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return "";
      for (const name of Array.from(url.searchParams.keys())) {
        if (secretQueryNames.test(name)) url.searchParams.delete(name);
      }
      url.hash = "";
      return url.href.length <= 4096 ? url.href : "";
    } catch (_) { return ""; }
  }

  function cleanError(value) {
    return text(value, 2000)
      .replace(/\b(?:set-cookie|cookie|authorization)\s*[:=][^\r\n]*/gi, "[credential redacted]")
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
      .replace(/\b(access[_-]?token|refresh[_-]?token|token|api[_-]?key|session(?:[_-]?id)?|password|pwd|secret|signature)\s*[:=]\s*[^\s&;,]+/gi, "$1=[redacted]");
  }

  function optionalInteger(value, name) {
    if (value === undefined || value === null || value === "") return null;
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(name + " must be a nonnegative integer");
    return value;
  }

  function timestamp(value, optional) {
    if (optional && (value === null || value === undefined || value === "")) return null;
    if (!(typeof value === "string" || typeof value === "number" || value instanceof Date)) {
      throw new TypeError("Invalid timestamp");
    }
    if (typeof value === "string" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      throw new TypeError("Timestamp must be an ISO date with an explicit timezone");
    }
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("Invalid timestamp");
    return date.toISOString();
  }

  // A receipt is evidence for one verified download and its later website
  // actions. Invalid evidence is discarded without losing the task history.
  function normalizeAssistReceipt(input, task) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    try {
      if (task.state !== "imported" || task.source !== "ablesci") return null;
      for (const name of ["requestID", "fileID", "accountID"]) {
        if (typeof input[name] !== "string" || !/^[A-Za-z0-9]{1,128}$/.test(input[name])) return null;
      }
      if (input.requestID !== task.requestID || !Number.isSafeInteger(input.attachmentID) ||
          input.attachmentID <= 0 || input.attachmentID !== task.attachmentID) return null;
      if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.sha256)) return null;
      const doi = normalizeDOI(input.doi), title = text(input.title, 2000);
      if (doi !== task.doi || !["doi", "title", "manual"].includes(input.verifiedBy) ||
          (input.verifiedBy === "doi" && !doi) || (input.verifiedBy === "title" && !title)) return null;
      if (!["pending", "accepted"].includes(input.adoption) || !["pending", "done"].includes(input.messages)) return null;
      if (input.needsReconcile !== undefined && typeof input.needsReconcile !== "boolean") return null;
      const verifiedAt = timestamp(input.verifiedAt, false);
      const acceptedAt = timestamp(input.acceptedAt, true), readAt = timestamp(input.readAt, true);
      const nextCheckAt = timestamp(input.nextCheckAt, true);
      if (input.adoption === "accepted" ? !acceptedAt || acceptedAt < verifiedAt : acceptedAt !== null) return null;
      if (input.messages === "done" ? input.adoption !== "accepted" || !readAt || readAt < acceptedAt : readAt !== null) return null;
      if (nextCheckAt && nextCheckAt < verifiedAt) return null;
      const attempts = input.attempts === undefined ? 0 : optionalInteger(input.attempts, "receipt attempts");
      if (attempts === null) return null;
      return {
        requestID: input.requestID, fileID: input.fileID, accountID: input.accountID,
        attachmentID: input.attachmentID, sha256: input.sha256.toLowerCase(), doi, title,
        verifiedBy: input.verifiedBy, verifiedAt, adoption: input.adoption, messages: input.messages,
        needsReconcile: input.adoption === "accepted" ? false : input.needsReconcile === true,
        attempts, nextCheckAt, lastError: cleanError(input.lastError), acceptedAt, readAt,
      };
    }
    catch (_) { return null; }
  }

  function normalizeAssistReview(input, task) {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    try {
      if (task.state !== "manual_review" || task.attachmentID !== null) return null;
      for (const name of ["requestID", "fileID", "accountID"]) {
        if (typeof input[name] !== "string" || !/^[A-Za-z0-9]{1,128}$/.test(input[name])) return null;
      }
      if (input.requestID !== task.requestID || typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(input.sha256)) return null;
      const doi = normalizeDOI(input.doi);
      if (doi !== task.doi) return null;
      return {
        requestID: input.requestID, fileID: input.fileID, accountID: input.accountID,
        sha256: input.sha256.toLowerCase(), doi, title: text(input.title, 2000),
        createdAt: timestamp(input.createdAt, false),
      };
    }
    catch (_) { return null; }
  }

  function currentTime(options) {
    const supplied = options && options.now;
    return timestamp(typeof supplied === "function" ? supplied() :
      supplied === undefined ? new Date() : supplied, false);
  }

  function newID(options) {
    const supplied = options && options.id;
    const value = typeof supplied === "function" ? supplied() : supplied;
    if (value !== undefined) return value;
    if (root.crypto && typeof root.crypto.randomUUID === "function") return root.crypto.randomUUID();
    return "task-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  }

  function normalizeTask(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid task");
    if (input.schemaVersion !== undefined && input.schemaVersion !== SCHEMA_VERSION) {
      throw new TypeError("Unsupported task schema version");
    }
    const id = text(input.id, 128);
    if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || id !== input.id) throw new TypeError("Invalid task ID");
    const doi = normalizeDOI(input.doi);
    const suppliedURL = input.requestURL === undefined || input.requestURL === null ? "" : input.requestURL;
    const request = suppliedURL === "" ? { requestID: "", requestURL: "" } : parseRequestURL(suppliedURL);
    if (input.requestID && input.requestID !== request.requestID) throw new TypeError("Request ID does not match request URL");
    const libraryID = optionalInteger(input.libraryID, "libraryID");
    const itemID = optionalInteger(input.itemID, "itemID");
    const itemKey = text(input.itemKey, 128);
    if (itemKey && !/^[A-Za-z0-9]+$/.test(itemKey)) throw new TypeError("Invalid item key");
    const hasItemIdentity = (libraryID > 0 && !!itemKey) || itemID > 0;
    if (!doi && !request.requestID && !hasItemIdentity) {
      throw new TypeError("A DOI, an existing request URL, or a Zotero item identity is required");
    }
    const state = input.state;
    if (!stateSet.has(state)) throw new TypeError("Unknown task state");
    const createdAt = timestamp(input.createdAt, false);
    const updatedAt = timestamp(input.updatedAt, false);
    if (updatedAt < createdAt) throw new TypeError("updatedAt precedes createdAt");
    const task = {
      schemaVersion: SCHEMA_VERSION,
      id,
      libraryID,
      itemKey,
      itemID,
      doi,
      title: text(input.title, 2000),
      officialURL: cleanOfficialURL(input.officialURL),
      publisherURL: cleanOfficialURL(input.publisherURL),
      requestURL: request.requestURL,
      requestID: request.requestID,
      // Snapshot per task: global settings changes cannot rewrite an existing request.
      requestedPoints: input.requestedPoints === undefined ? DEFAULT_POINTS : validatePoints(input.requestedPoints),
      // Legacy requestedPoints may have been a local default for an existing
      // request. Only a verified website amount can be presented as its cost.
      pointsVerified: !!request.requestID && input.pointsVerified === true,
      acceptSiteMinimum: input.acceptSiteMinimum === true,
      allowAssist: input.allowAssist === true,
      attachmentID: optionalInteger(input.attachmentID, "attachmentID"),
      source: text(input.source, 100),
      fulltextVersion: ["published", "accepted", "submitted"].includes(input.fulltextVersion) ? input.fulltextVersion : "unknown",
      sourceDiagnostics: (Array.isArray(input.sourceDiagnostics) ? input.sourceDiagnostics : []).slice(0, 24).filter(value => value && typeof value === "object").map(value => ({
        source: text(value.source, 40), code: text(value.code, 60), message: cleanError(value.message),
      })),
      acquisitionMode: ["browser", "manual"].includes(input.acquisitionMode) ? input.acquisitionMode : "",
      downloadRoute: ["normal", "highspeed"].includes(input.downloadRoute) ? input.downloadRoute : "",
      attempts: optionalInteger(input.attempts, "attempts") || 0,
      state,
      createdAt,
      updatedAt,
      completedAt: timestamp(input.completedAt || (state === "imported" ? updatedAt : null), true),
      lastCheckedAt: timestamp(input.lastCheckedAt, true),
      nextCheckAt: timestamp(input.nextCheckAt, true),
      lastError: cleanError(input.lastError),
    };
    task.assistReceipt = normalizeAssistReceipt(input.assistReceipt, task);
    task.assistReview = normalizeAssistReview(input.assistReview, task);
    task.sourceReview = null;
    const sourceReview = input.sourceReview;
    if (task.state === "manual_review" && !task.attachmentID && sourceReview && /^[a-f0-9]{64}$/i.test(sourceReview.sha256 || "")) {
      try {
        if (normalizeDOI(sourceReview.doi) === task.doi) task.sourceReview = {
          sha256: sourceReview.sha256.toLowerCase(), doi: task.doi, title: text(sourceReview.title, 2000),
          source: text(sourceReview.source, 100), sourceURL: cleanOfficialURL(sourceReview.sourceURL),
          fulltextVersion: ["published", "accepted", "submitted"].includes(sourceReview.fulltextVersion) ? sourceReview.fulltextVersion : "unknown",
        };
      } catch (_) { /* Invalid review metadata cannot discard task history. */ }
    }
    task.submissionReview = null;
    if (!task.requestID && ["submission_unknown", "paused", "error"].includes(task.state) && input.submissionReview) {
      try {
        const review=input.submissionReview,reference=parseRequestURL(review.requestURL);
        if(reference.requestID===review.requestID)task.submissionReview={...reference,expectedDOI:normalizeDOI(review.expectedDOI),receivedDOI:normalizeDOI(review.receivedDOI||""),reason:text(review.reason,100)};
      } catch (_) { /* Invalid review links never become a bound request. */ }
    }
    task.doiCheck = null;
    if(input.doiCheck)try{
      const value=input.doiCheck;
      if(["match","doi_mismatch","doi_missing","doi_invalid"].includes(value.reason))task.doiCheck={expectedDOI:normalizeDOI(value.expectedDOI),receivedDOI:normalizeDOI(value.receivedDOI||""),expectedTitle:text(value.expectedTitle,2000),receivedTitle:text(value.receivedTitle,2000),reason:value.reason,checkedAt:timestamp(value.checkedAt,false)};
    }catch(_){/* Diagnostic metadata cannot discard a task. */}
    const evidence = input.accessEvidence;
    task.accessEvidence = evidence && ["page", "response", "cached_response"].includes(evidence.source) &&
      ["institutional_entry", "institutional_hint", "login_hint", "request_restricted", "human_verification", "automatic_not_found"].includes(evidence.kind) &&
      ["explicit", "possible", "unknown"].includes(evidence.confidence) && cleanOfficialURL(evidence.url)
      ? { kind: evidence.kind, confidence: evidence.confidence, source: evidence.source, url: cleanOfficialURL(evidence.url) } : null;
    return task;
  }

  function sanitizeTask(input) {
    try { return normalizeTask(input); } catch (_) { return null; }
  }

  function createTask(input, options) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Invalid task input");
    const now = currentTime(options);
    const lacksRemoteReference = !normalizeDOI(input.doi) && !input.requestURL && !input.requestID;
    return normalizeTask(Object.assign({}, input, {
      schemaVersion: SCHEMA_VERSION,
      id: newID(options),
      state: input.state === undefined ? (lacksRemoteReference ? "needs_review" : "pending_login") : input.state,
      createdAt: now,
      updatedAt: now,
    }));
  }

  function sameItemIdentity(first, second) {
    if (first.libraryID > 0 && second.libraryID > 0 && first.itemKey && second.itemKey) {
      return first.libraryID === second.libraryID && first.itemKey === second.itemKey;
    }
    return first.itemID > 0 && second.itemID > 0 && first.itemID === second.itemID &&
      (first.libraryID === null || second.libraryID === null || first.libraryID === second.libraryID);
  }

  function findDuplicate(tasks, candidate) {
    if (!Array.isArray(tasks) || !candidate) return null;
    if (candidate.requestID) {
      const sameRequest = tasks.find(task => task.requestID === candidate.requestID);
      if (sameRequest) return sameRequest;
    }
    if (!candidate.doi) {
      if (candidate.requestID) return null;
      return tasks.find(task => !task.doi && !task.requestID && sameItemIdentity(task, candidate)) || null;
    }
    return tasks.find(task => {
      // Two distinct remote requests must not silently overwrite one another.
      if (candidate.requestID && task.requestID && candidate.requestID !== task.requestID) return false;
      if (task.doi !== candidate.doi || task.libraryID !== candidate.libraryID || task.itemKey !== candidate.itemKey) return false;
      return candidate.itemKey || task.itemID === candidate.itemID;
    }) || null;
  }

  function addTask(tasks, input, options) {
    if (!Array.isArray(tasks)) throw new TypeError("Tasks must be an array");
    const candidate = createTask(input, options);
    const duplicate = findDuplicate(tasks, candidate);
    if (duplicate) return { tasks, task: duplicate, added: false };
    if (tasks.some(task => task.id === candidate.id)) throw new TypeError("Task ID already exists");
    return { tasks: tasks.concat(candidate), task: candidate, added: true };
  }

  function updateTask(task, patch, options) {
    const previous = normalizeTask(task);
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("Invalid task patch");
    const now = currentTime(options);
    const merged = Object.assign({}, previous, patch, {
      schemaVersion: SCHEMA_VERSION,
      id: previous.id,
      createdAt: previous.createdAt,
      updatedAt: now < previous.updatedAt ? previous.updatedAt : now,
    });
    if (Object.prototype.hasOwnProperty.call(patch, "requestURL") &&
        !Object.prototype.hasOwnProperty.call(patch, "requestID")) {
      merged.requestID = patch.requestURL ? parseRequestURL(patch.requestURL).requestID : "";
    }
    const updated = normalizeTask(merged);
    const identityChanged = ["libraryID", "itemID", "itemKey", "doi", "title", "requestID"]
      .some(field => updated[field] !== previous[field]);
    const attachmentChanged = updated.attachmentID !== previous.attachmentID;
    if(["libraryID","itemID","itemKey","doi","title"].some(field=>updated[field]!==previous[field]))updated.doiCheck=null;
    if ((updated.requestID !== previous.requestID || updated.requestedPoints !== previous.requestedPoints) && patch.pointsVerified !== true) updated.pointsVerified = false;
    if (["libraryID", "itemID", "itemKey", "doi"].some(field => updated[field] !== previous[field])) { updated.accessEvidence = null; updated.publisherURL = ""; }
    if (previous.sourceReview && (identityChanged || attachmentChanged)) updated.sourceReview = null;
    if (identityChanged) { updated.fulltextVersion = "unknown"; updated.sourceDiagnostics = []; }
    if ((previous.assistReceipt || previous.assistReview) && identityChanged || previous.assistReceipt && attachmentChanged) {
      updated.assistReceipt = null; updated.assistReview = null;
    }
    else if (previous.assistReview && attachmentChanged) {
      // Explicit confirmation replaces a retained review with newly verified
      // attachment evidence in one write. Other attachment changes cannot.
      if (patch.assistReview !== null || !Object.prototype.hasOwnProperty.call(patch, "assistReceipt")) updated.assistReceipt = null;
      updated.assistReview = null;
    }
    return updated;
  }

  function sanitizeQueue(payload) {
    const source = Array.isArray(payload) ? { schemaVersion: SCHEMA_VERSION, tasks: payload } : payload;
    if (!source || typeof source !== "object" || source.schemaVersion !== SCHEMA_VERSION || !Array.isArray(source.tasks)) {
      throw new TypeError("Invalid or unsupported queue schema");
    }
    const tasks = [];
    const ids = new Set();
    for (const entry of source.tasks) {
      const task = sanitizeTask(entry);
      if (!task || ids.has(task.id) || findDuplicate(tasks, task)) continue;
      tasks.push(task);
      ids.add(task.id);
    }
    let currentBatch = null;
    try {
      const batch = source.currentBatch;
      if (batch && /^[A-Za-z0-9._-]{1,128}$/.test(batch.id) && Array.isArray(batch.taskIDs)) {
        const taskIDs = [...new Set(batch.taskIDs.filter(id => ids.has(id)))];
        const summary = batch.summary;
        let safeSummary = null;
        if (summary && typeof summary === "object") {
          safeSummary = {};
          for (const key of ["id", "selected", "eligible", "queued", "skippedExistingPDF", "retained", "ignored", "duplicates", "failed", "unprocessed"]) {
            safeSummary[key] = Number.isSafeInteger(summary[key]) && summary[key] >= 0 ? summary[key] : 0;
          }
          safeSummary.at = timestamp(summary.at, false);
          safeSummary.cancelled = summary.cancelled === true;
          safeSummary.message = cleanError(summary.message);
          safeSummary.queuedTaskIDs = [...new Set((Array.isArray(summary.queuedTaskIDs) ? summary.queuedTaskIDs : []).filter(id => taskIDs.includes(id)))];
        }
        currentBatch = { id: batch.id, createdAt: timestamp(batch.createdAt, false), taskIDs, summary: safeSummary };
      }
    } catch (_) { /* Invalid batch metadata must not discard valid task history. */ }
    return { schemaVersion: SCHEMA_VERSION, tasks, currentBatch };
  }

  function serializeQueue(payload) {
    return JSON.stringify(sanitizeQueue(payload));
  }

  function deserializeQueue(json) {
    if (typeof json !== "string") throw new TypeError("Queue JSON must be text");
    return sanitizeQueue(JSON.parse(json));
  }

  const api = Object.freeze({
    SCHEMA_VERSION, DEFAULT_POINTS, STATES,
    validatePoints, normalizeDOI, parseRequestURL, createTask, findDuplicate, addTask, updateTask,
    sanitizeTask, sanitizeQueue, serializeQueue, deserializeQueue,
  });
  root.FulltextTaskModel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
