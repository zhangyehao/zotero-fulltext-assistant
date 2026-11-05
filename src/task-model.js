/* Pure task data model. No network access, website submission, or credential storage. */
(function (root) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const DEFAULT_POINTS = 10;
  const STATES = Object.freeze([
    "pending_login", "ready_to_check", "waiting", "available", "needs_review",
    "paused", "imported", "error", "queued", "resolving", "not_found",
    "submitting", "submission_unknown", "downloading", "closed", "needs_login",
    "browser_waiting", "browser_scanning", "browser_downloading",
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
    return {
      schemaVersion: SCHEMA_VERSION,
      id,
      libraryID,
      itemKey,
      itemID,
      doi,
      title: text(input.title, 2000),
      officialURL: cleanOfficialURL(input.officialURL),
      requestURL: request.requestURL,
      requestID: request.requestID,
      // Snapshot per task: global settings changes cannot rewrite an existing request.
      requestedPoints: input.requestedPoints === undefined ? DEFAULT_POINTS : validatePoints(input.requestedPoints),
      allowAssist: input.allowAssist === true,
      attachmentID: optionalInteger(input.attachmentID, "attachmentID"),
      source: text(input.source, 100),
      acquisitionMode: input.acquisitionMode === "browser" ? "browser" : "",
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
    return normalizeTask(merged);
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
    return { schemaVersion: SCHEMA_VERSION, tasks };
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
