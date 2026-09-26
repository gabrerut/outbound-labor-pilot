// ==UserScript==
// @name         Engage Coaching Tracker
// @namespace    http://tampermonkey.net/
// @version      41
// @description  Elevate coaching alerts. Coachings auto-pulled from the QuickSight Elevate dashboard + Firebase sync for shared completions. Per-coaching one-click Done and live "in progress" claims to prevent redundant work across leaders. Auto-updates from GitHub.
// @author       Orcha + Eitan Wiernik + branoble + gabrerut
// @match        https://*.quicksight.aws.amazon.com/*
// @match        https://na.store-management.f3.amazon.dev/*
// @match        https://*.store-management.*.amazon.dev/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      engage-coaching-tracker-default-rtdb.firebaseio.com
// @connect      store-management.f3.amazon.dev
// @updateURL    https://raw.githubusercontent.com/gabrerut/outbound-labor-pilot/main/engage-coaching-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/gabrerut/outbound-labor-pilot/main/engage-coaching-tracker.user.js
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // === VERSION / AUTO-UPDATE ===
    // Tampermonkey checks @updateURL, compares @version, and pulls @downloadURL when the hosted
    // version is higher. The GitHub Action bumps @version on every push to main, so the team
    // gets updates automatically. The UI reads the version from GM_info so it never drifts.
    var SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '41';

    var TYPE_CONFIG = {
        ELEV: { bg: '#E74C3C', label: 'Elevate' },
        POS:  { bg: '#10B981', label: 'Positive' }
    };
    var DEFAULT_TYPE = { bg: '#6c757d', label: 'Coach' };

    var elevateByLogin = {};
    var submittedByLogin = {}; GM_setValue('elevateSubmittedHide', '{}');
    var positiveByLogin = {};     // Positive reinforcement coachings keyed by login
    var cycleTimeByLogin = {};    // Cycle time data keyed by login
    var coachingErrDetails = {};  // login -> array of error detail objects
    var currentMatches = [];

    // v41.37: purge malformed completion keys (date leaked into the metric, e.g.
    // 'login|Positive Reinforcement Conversation|2026-09-26|2026-09-26'). Rewrite each key to
    // login|metric|DATE with exactly one trailing date.
    (function(){
        try {
            var comp = JSON.parse(GM_getValue('elevateCompleted', '{}'));
            var fixed = {}, changed = false;
            Object.keys(comp).forEach(function(k){
                var parts = k.split('|');
                var dates = [];
                while (parts.length && /^\d{4}-\d{2}-\d{2}$/.test(parts[parts.length-1])) { dates.unshift(parts.pop()); }
                var login = parts.shift() || '';
                var metric = parts.join('|');
                var lastDate = dates.length ? dates[dates.length-1] : '';
                var clean = login + '|' + metric + (lastDate ? ('|' + lastDate) : '');
                if (clean !== k) changed = true;
                if (!fixed[clean] || (comp[k].timestamp||0) > (fixed[clean].timestamp||0)) fixed[clean] = comp[k];
            });
            if (changed) { GM_setValue('elevateCompleted', JSON.stringify(fixed)); console.log('[CoachTracker] cleaned malformed completion keys'); }
        } catch(e) {}
    })();

    // Strip any leaked trailing |YYYY-MM-DD segment(s) from a metric string.
    function stripDate(metric) { return (metric || '').replace(/\|\d{4}-\d{2}-\d{2}.*$/, ''); }

    // === COMPLETION STATE ===
    // The coaching log is the SINGLE SOURCE OF TRUTH for completions. The completed cache is
    // derived from it after every log change and every pull.
    var currentCoachingWeek = GM_getValue('current_coaching_week', '');

    // DAILY tracker — completion keys are login|metric|YYYY-MM-DD (local calendar day).
    function todayKey() {
        var d = new Date();
        return d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2) + '-' + ('0'+d.getDate()).slice(-2);
    }
    function ckey(login, metric) {
        return (login || '').toLowerCase() + '|' + (metric || '') + '|' + todayKey();
    }

    function buildCompletedFromLog() {
        var completed = {};
        // Oldest-first so the latest action wins.
        for (var i = 0; i < coachingLog.length; i++) {
            var entry = coachingLog[i];
            if (!entry.login || !entry.metric) continue;
            var key = ckey(entry.login, entry.metric);
            if (entry.action === 'completed') {
                completed[key] = { timestamp: entry.timestamp, completedBy: entry.completedBy || 'unknown', week: entry.week || '' };
            } else if (entry.action === 'unmarked') {
                delete completed[key];
            }
        }
        GM_setValue('elevateCompleted', JSON.stringify(completed));
        return completed;
    }

    function isElevateCompleted(login, metric) {
        var completed = JSON.parse(GM_getValue('elevateCompleted', '{}'));
        return !!completed[ckey(login, metric)];
    }

    function getLeaderLogin() {
        var login = GM_getValue('leader_login', '');
        if (!login) {
            login = prompt('Engage Coaching Tracker\n\nEnter YOUR login (alias) to track who completes coachings:');
            if (login && login.trim().length >= 3) {
                login = login.trim().toLowerCase();
                GM_setValue('leader_login', login);
            } else {
                return '';
            }
        }
        return login;
    }

    // === CSV PARSER (used by the QuickSight scrape, which serializes rows to CSV) ===
    function parseCSVLine(line) {
        var result = [], current = '', inQuotes = false;
        for (var i = 0; i < line.length; i++) {
            var c = line[i];
            if (c === '"') {
                if (inQuotes && i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
                else inQuotes = !inQuotes;
            } else if (c === ',' && !inQuotes) { result.push(current); current = ''; }
            else current += c;
        }
        result.push(current);
        return result;
    }

    function parseElevateCSV(text) {
        var lines = text.replace(/\r/g, '').split('\n');
        if (lines.length < 2) return 0;
        var header = parseCSVLine(lines[0].replace(/^\uFEFF/, ''));
        var col = {};
        for (var i = 0; i < header.length; i++) {
            var h = header[i].toLowerCase().trim();
            if (h === 'associate id') col.login = i;
            else if (h === 'full name') col.name = i;
            else if (h === 'metric name') col.metric = i;
            else if (h === 'submitted by') col.submitted = i;
            else if (h === 'form url') col.form = i;
            else if (h === 'pre num') col.preNum = i;
            else if (h === 'today shift') col.shift = i;
            else if (h === 'pre week begin') col.week = i;
            else if (h === 'coaching time') col.coachTime = i;
        }
        if (col.login === undefined || col.submitted === undefined) return -1;

        // v41.21: METRIC ROUTING — skip Positive Reinforcement rows here, and only REPLACE
        // elevateByLogin when this scrape actually contains Elevate rows (e.g. scraping the
        // Positive tab must not wipe Elevate).
        var _rows = [];
        for (var _j = 1; _j < lines.length; _j++) {
            if (!lines[_j].trim()) continue;
            var _cc = parseCSVLine(lines[_j]);
            var _lg = (_cc[col.login] || '').trim().toLowerCase();
            var _mt = (_cc[col.metric] || '').trim();
            if (!_lg) continue;
            if (/positive reinforcement/i.test(_mt)) continue;
            _rows.push(_cc);
        }
        if (_rows.length === 0) {
            console.log('[CoachTracker] parse: 0 Elevate rows in this scrape — keeping prior Elevate data.');
            return Object.keys(elevateByLogin).reduce(function(n,l){ return n + elevateByLogin[l].length; }, 0);
        }

        elevateByLogin = {};
        var count = 0;
        for (var jr = 0; jr < _rows.length; jr++) {
            var c = _rows[jr];
            var login = (c[col.login] || '').trim().toLowerCase();
            if (!login) continue;
            if (!elevateByLogin[login]) elevateByLogin[login] = [];
            var _mtr = (c[col.metric] || '').trim();
            var _wk = (col.week !== undefined ? (c[col.week] || '').trim() : '');
            // v41.44: dedup by METRIC ONLY — one coaching per login|metric on the current list.
            var _dup = elevateByLogin[login].some(function(e){ return e.metric === _mtr; });
            if (_dup) continue;
            elevateByLogin[login].push({
                count: parseInt(c[col.preNum]) || 1,
                date: '',
                type: 'ELEV',
                name: (col.name !== undefined ? (c[col.name] || '').trim() : ''),
                shift: (col.shift !== undefined ? (c[col.shift] || '').trim() : ''),
                week: _wk,
                metric: _mtr,
                formURL: (c[col.form] || '').trim(),
                submittedBy: (col.submitted !== undefined ? (c[col.submitted] || '').trim().toLowerCase() : ''),
                coachTime: (col.coachTime !== undefined ? (c[col.coachTime] || '').trim().slice(0,10) : '')
            });
            count++;
        }
        // v41.20: never hide from the scraped 'Submitted By' column (it over-hid all Elevate).
        submittedByLogin = {};
        GM_setValue('elevateSubmittedHide', '{}');
        GM_setValue('elevateData', JSON.stringify(elevateByLogin));
        GM_setValue('elevateTimestamp', Date.now());
        console.log('[CoachTracker] Elevate: ' + count + ' total entries, ' + Object.keys(elevateByLogin).length + ' associates');
        return count;
    }

    function loadElevateCache() {
        try { var d = GM_getValue('elevateData', null); if (d) elevateByLogin = JSON.parse(d); } catch(e) {}
        try { var ed = GM_getValue('coachingErrDetails', null); if (ed) coachingErrDetails = JSON.parse(ed); } catch(e) {}
        try { var pd = GM_getValue('positiveData', null); if (pd) positiveByLogin = JSON.parse(pd); } catch(e) {}
        try { var ctd = GM_getValue('cycleTimeData', null); if (ctd) cycleTimeByLogin = JSON.parse(ctd); } catch(e) {}
    }

    // === FIREBASE SYNC ===
    var FIREBASE_DB_URL = 'https://engage-coaching-tracker-default-rtdb.firebaseio.com';
    var ELEVATE_SITE_CODE = GM_getValue('elevate_site_code', '');
    var ELEVATE_SYNC_MS = 5 * 60 * 1000; // Sync every 5 minutes

    function getElevateSiteCode() {
        if (ELEVATE_SITE_CODE) return ELEVATE_SITE_CODE;
        var code = prompt('Engage Coaching Tracker\n\nEnter your site code (e.g., UNJ2, UFL6, UGA2):');
        if (code && code.trim().length >= 3) {
            code = code.trim().toUpperCase();
            GM_setValue('elevate_site_code', code);
            ELEVATE_SITE_CODE = code;
            return code;
        }
        return '';
    }

    function firebaseRequest(path, method, body) {
        return new Promise(function(resolve, reject) {
            var url = FIREBASE_DB_URL + '/' + ELEVATE_SITE_CODE + '/' + path + '.json';
            GM_xmlhttpRequest({
                method: method || 'GET',
                url: url,
                headers: { 'Content-Type': 'application/json' },
                data: body ? JSON.stringify(body) : undefined,
                timeout: 15000,
                onload: function(r) {
                    if (r.status >= 200 && r.status < 300) {
                        try { resolve(JSON.parse(r.responseText)); } catch(e) { resolve(null); }
                    } else {
                        reject(new Error('Firebase ' + r.status));
                    }
                },
                onerror: function() { reject(new Error('Network error')); },
                ontimeout: function() { reject(new Error('Timeout')); }
            });
        });
    }

    async function pushElevateToFirebase(isNewUpload) {
        try {
            var site = getElevateSiteCode();
            if (!site) { console.warn('[CoachTracker] Firebase push skipped: no site code'); return false; }
            var currentUploadId = GM_getValue('elevateUploadId', '') || Date.now().toString(36);
            var uploadId = isNewUpload ? Date.now().toString(36) : currentUploadId;
            if (isNewUpload) GM_setValue('elevateUploadId', uploadId);
            var payload = { data: elevateByLogin, timestamp: Date.now(), uploadedBy: 'manager', uploadId: uploadId };
            await firebaseRequest('elevate_data', 'PUT', payload);
            console.log('[CoachTracker] Elevate data pushed to Firebase (' + Object.keys(elevateByLogin).length + ' associates)');
            return true;
        } catch(e) { console.error('[CoachTracker] Firebase push error:', e.message); return false; }
    }

    // Pushes the live-scraped positives so the 5-min Firebase pull doesn't restore a stale list.
    // (Was referenced by qsPublish but never defined, so positives were never shared.)
    async function pushPositivesToFirebase() {
        try {
            var site = getElevateSiteCode();
            if (!site) return false;
            await firebaseRequest('positive_coachings', 'PUT', { data: positiveByLogin, timestamp: Date.now() });
            GM_setValue('positiveTimestamp', Date.now());
            console.log('[CoachTracker] Positive coachings pushed to Firebase (' + Object.keys(positiveByLogin).length + ' associates)');
            return true;
        } catch(e) { console.error('[CoachTracker] Positive push error:', e.message); return false; }
    }

    // === SHARED COACHING LOG ===
    var coachingLog = []; // { login, metric, week, completedBy, timestamp, action }

    function logEntryKey(e) { return e.timestamp + '|' + e.login + '|' + e.metric + '|' + e.action; }

    // Union remote entries into the local log. Returns the number of entries added.
    function mergeRemoteLog(remoteLog) {
        var localKeys = {};
        coachingLog.forEach(function(e) { localKeys[logEntryKey(e)] = true; });
        var added = 0;
        (remoteLog || []).forEach(function(r) {
            if (!localKeys[logEntryKey(r)]) { coachingLog.push(r); added++; }
        });
        if (added > 0) coachingLog.sort(function(a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
        return added;
    }

    async function pushCoachingLogToFirebase(skipMerge) {
        try {
            var site = getElevateSiteCode();
            if (!site) return false;
            // Pull + merge first so we never overwrite other leaders' entries.
            if (!skipMerge) {
                try {
                    var remotePayload = await firebaseRequest('coaching_log', 'GET');
                    if (remotePayload && remotePayload.log) {
                        var localResetId = GM_getValue('coachingLogResetId', '');
                        if (remotePayload.resetId && remotePayload.resetId !== localResetId) {
                            coachingLog = remotePayload.log || [];
                            GM_setValue('coachingLog', JSON.stringify(coachingLog));
                            GM_setValue('coachingLogResetId', remotePayload.resetId);
                            buildCompletedFromLog();
                            console.log('[CoachTracker] Reset detected before push (resetId: ' + remotePayload.resetId + ')');
                        } else if (remotePayload.log.length > 0) {
                            var added = mergeRemoteLog(remotePayload.log);
                            if (added > 0) {
                                GM_setValue('coachingLog', JSON.stringify(coachingLog));
                                buildCompletedFromLog();
                                console.log('[CoachTracker] Merged ' + added + ' remote log entries before push');
                            }
                        }
                    }
                } catch(mergeErr) {
                    console.warn('[CoachTracker] Log merge before push failed:', mergeErr.message);
                }
            }
            var currentResetId = GM_getValue('coachingLogResetId', '');
            await firebaseRequest('coaching_log', 'PUT', { log: coachingLog, timestamp: Date.now(), resetId: currentResetId });
            GM_setValue('coachingLog', JSON.stringify(coachingLog));
            console.log('[CoachTracker] Coaching log pushed to Firebase (' + coachingLog.length + ' entries)');
            return true;
        } catch(e) { console.error('[CoachTracker] Coaching log push error:', e.message); return false; }
    }

    async function pullCoachingLogFromFirebase() {
        try {
            var payload = await firebaseRequest('coaching_log', 'GET');
            if (payload && payload.log) {
                var localResetId = GM_getValue('coachingLogResetId', '');
                if (payload.resetId && payload.resetId !== localResetId) {
                    // Genuine reset — replace local with remote.
                    coachingLog = payload.log;
                    GM_setValue('coachingLog', JSON.stringify(coachingLog));
                    GM_setValue('coachingLogResetId', payload.resetId);
                    buildCompletedFromLog();
                    console.log('[CoachTracker] Pulled coaching log (reset detected, resetId: ' + payload.resetId + ', now ' + coachingLog.length + ' entries)');
                    matchAndAlert();
                } else {
                    var added = mergeRemoteLog(payload.log);
                    GM_setValue('coachingLog', JSON.stringify(coachingLog));
                    buildCompletedFromLog();
                    console.log('[CoachTracker] Pulled coaching log (' + coachingLog.length + ' entries, +' + added + ' new)');
                    if (added > 0) matchAndAlert();
                }
            }
            return true;
        } catch(e) { console.error('[CoachTracker] Coaching log pull error:', e.message); return false; }
    }

    function loadCoachingLogCache() {
        try {
            var cached = GM_getValue('coachingLog', null);
            if (cached) {
                coachingLog = JSON.parse(cached);
                // v39.3: ONE-TIME CLEAN RESET (guarded) — archive the old unscoped log, wipe local +
                // Firebase with a new resetId so every client adopts the empty log.
                if (!GM_getValue('clean_reset_v39_3', false)) {
                    try { GM_setValue('coachingLog_archive_v39_3', JSON.stringify(coachingLog)); } catch(e) {}
                    var archivedCount = coachingLog.length;
                    coachingLog = [];
                    GM_setValue('coachingLog', JSON.stringify(coachingLog));
                    GM_setValue('elevateCompleted', '{}');
                    var freshResetId = 'reset_' + Date.now();
                    GM_setValue('coachingLogResetId', freshResetId);
                    try {
                        firebaseRequest('archives/coaching_log_pre_v39_3', 'PUT', { log: coachingLog, archivedAt: Date.now() }).catch(function(){});
                        firebaseRequest('coaching_log', 'PUT', { log: [], timestamp: Date.now(), resetId: freshResetId }).then(function(){
                            console.log('[CoachTracker] v39.3 CLEAN RESET — Firebase coaching_log wiped (resetId ' + freshResetId + ')');
                        }).catch(function(e){ console.warn('[CoachTracker] v39.3 Firebase wipe failed: ' + (e && e.message)); });
                    } catch(e) {}
                    GM_setValue('clean_reset_v39_3', true);
                    console.log('[CoachTracker] v39.3 CLEAN RESET — archived ' + archivedCount + ' local entries + wiping Firebase');
                }
                buildCompletedFromLog();
            }
        } catch(e) {}
    }

    function addToCoachingLog(login, metric, completedBy, action, week) {
        coachingLog.push({ login: login, metric: stripDate(metric), week: (week || currentCoachingWeek || ''), completedBy: completedBy, timestamp: Date.now(), action: action || 'completed' });
        GM_setValue('coachingLog', JSON.stringify(coachingLog));
        buildCompletedFromLog();
        pushCoachingLogToFirebase();
    }

    async function pullElevateFromFirebase() {
        try {
            var payload = await firebaseRequest('elevate_data', 'GET');
            if (payload && payload.data && payload.timestamp) {
                var localUploadId = GM_getValue('elevateUploadId', '');
                if (payload.uploadId && payload.uploadId !== localUploadId) {
                    GM_setValue('elevateUploadId', payload.uploadId);
                    console.log('[CoachTracker] New uploadId detected: ' + payload.uploadId);
                }
                elevateByLogin = payload.data;
                GM_setValue('elevateData', JSON.stringify(elevateByLogin));
                GM_setValue('elevateTimestamp', payload.timestamp);
                console.log('[CoachTracker] Pulled Elevate from Firebase (' + Object.keys(elevateByLogin).length + ' associates)');
            }
            var errPayload = await firebaseRequest('errdetails', 'GET');
            if (errPayload && errPayload.data) {
                coachingErrDetails = errPayload.data;
                GM_setValue('coachingErrDetails', JSON.stringify(coachingErrDetails));
                GM_setValue('errDetailsTimestamp', errPayload.timestamp || Date.now());
                console.log('[CoachTracker] Pulled Error Details from Firebase (' + Object.keys(coachingErrDetails).length + ' associates)');
            }
            var posPayload = await firebaseRequest('positive_coachings', 'GET');
            if (posPayload && posPayload.data) {
                positiveByLogin = posPayload.data;
                GM_setValue('positiveData', JSON.stringify(positiveByLogin));
                GM_setValue('positiveTimestamp', posPayload.timestamp || Date.now());
                console.log('[CoachTracker] Pulled Positive Coachings from Firebase (' + Object.keys(positiveByLogin).length + ' associates)');
            }
            var ctPayload = await firebaseRequest('cycle_time_data', 'GET');
            if (ctPayload && ctPayload.data) {
                cycleTimeByLogin = ctPayload.data;
                GM_setValue('cycleTimeData', JSON.stringify(cycleTimeByLogin));
                console.log('[CoachTracker] Pulled Cycle Time from Firebase (' + Object.keys(cycleTimeByLogin).length + ' associates)');
            }
            matchAndAlert();
            return true;
        } catch(e) { console.error('[CoachTracker] Firebase pull error:', e.message); return false; }
    }

    function getTypeConfig(type) { return TYPE_CONFIG[type] || DEFAULT_TYPE; }

    // === MATCHING ===
    // On-site comes from Find People (onSiteLogins). Iterate all logins with a coaching and keep
    // only those currently on site.
    function matchAndAlert() {
        currentMatches = [];
        var completed = JSON.parse(GM_getValue('elevateCompleted', '{}'));
        var coachingLogins = {};
        Object.keys(elevateByLogin || {}).forEach(function(l){ coachingLogins[l] = true; });
        Object.keys(positiveByLogin || {}).forEach(function(l){ coachingLogins[l] = true; });

        Object.keys(coachingLogins).forEach(function(login) {
            if (!onSiteLogins[login]) return; // ON-SITE GATE
            var alerts = [];
            var displayName = '';
            if (elevateByLogin[login]) {
                elevateByLogin[login].forEach(function(alert) {
                    if (alert.name && !displayName) displayName = alert.name;
                    var key = ckey(login, alert.metric);
                    var subHide = submittedByLogin[login + '|' + (alert.metric || '')];
                    // v41.24: hide when completed on the QuickSight dashboard TODAY
                    // (Submitted By filled AND Coaching Time == today).
                    var dashDoneToday = !!alert.submittedBy && !!alert.coachTime && alert.coachTime === todayKey();
                    if (!completed[key] && !subHide && !dashDoneToday) alerts.push(alert);
                });
            }
            if (positiveByLogin[login]) {
                positiveByLogin[login].forEach(function(posEntry) {
                    var posMetric = posEntry.metricName || 'Positive Reinforcement';
                    if (posEntry.fullName && !displayName) displayName = posEntry.fullName;
                    var key = ckey(login, posMetric);
                    var subHideP = submittedByLogin[login + '|' + posMetric];
                    if (!completed[key] && !subHideP) {
                        var posFormURL = posEntry.formURL || ('https://formulate.gsf.a2z.com/forms/36f6eb5c-1c4d-4b81-a08e-6d3f8130d8d0?48b591a8-fcb6-4d5b-b7bf-9b5707391a24=' + login);
                        alerts.push({
                            count: 1, date: posEntry.lastCoachingDate || '', type: 'POS', metric: posMetric,
                            formURL: posFormURL, shift: posEntry.shift || '', fullName: posEntry.fullName || ''
                        });
                    }
                });
            }
            if (alerts.length > 0) {
                var visAlerts = hiddenTypes.length > 0 ? alerts.filter(function(a) { return hiddenTypes.indexOf(a.type) < 0; }) : alerts;
                if (visAlerts.length > 0) {
                    currentMatches.push({
                        empId: login, login: login,
                        name: displayName || login,
                        manager: '', site: ELEVATE_SITE_CODE || '', shift: (visAlerts[0] && visAlerts[0].shift) || '',
                        alerts: visAlerts,
                        hasErrDetails: false
                    });
                }
            }
        });

        currentMatches.sort(function(a, b) {
            var aTotal = a.alerts.reduce(function(s, x) { return s + (x.count||1); }, 0);
            var bTotal = b.alerts.reduce(function(s, x) { return s + (x.count||1); }, 0);
            return bTotal - aTotal;
        });
        console.log('[CoachTracker] ' + currentMatches.length + ' on-site associates with pending coachings (of ' + onSiteCount + ' on site)');
        highlightRows();
        updatePanel();
        updateButton();
    }

    // === STYLES ===
    var styles = document.createElement('style');
    styles.textContent = [
        /* launcher pill */
        '#mm-btn.ct-launch { position: fixed; bottom: 22px; right: 22px; z-index: 99999; display: inline-flex; align-items: center; gap: 9px; background: linear-gradient(135deg, #14395e 0%, #0d2540 100%); color: #fff; border: 1px solid rgba(255,255,255,0.10); border-radius: 999px; padding: 9px 16px 9px 13px; font-size: 13px; font-weight: 700; letter-spacing: 0.3px; cursor: pointer; box-shadow: 0 8px 22px rgba(11,30,54,0.42), inset 0 1px 0 rgba(255,255,255,0.08); transition: transform 0.14s cubic-bezier(.2,.7,.3,1), box-shadow 0.14s ease, background 0.2s ease; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; -webkit-font-smoothing: antialiased; }',
        '#mm-btn.ct-launch:hover { transform: translateY(-2px) scale(1.02); box-shadow: 0 12px 30px rgba(11,30,54,0.5), inset 0 1px 0 rgba(255,255,255,0.12); }',
        '#mm-btn.ct-launch:active { transform: translateY(0) scale(0.99); }',
        '#mm-btn .ct-launch-ico { font-size: 15px; line-height: 1; filter: drop-shadow(0 1px 1px rgba(0,0,0,0.25)); }',
        '#mm-btn .ct-launch-txt { font-size: 13px; font-weight: 750; }',
        '#mm-btn .ct-launch-badge { min-width: 21px; height: 21px; padding: 0 7px; display: inline-flex; align-items: center; justify-content: center; background: linear-gradient(135deg,#ffb52e,#ff9900); color: #0d2540; border-radius: 999px; font-size: 12px; font-weight: 800; box-shadow: 0 1px 3px rgba(0,0,0,0.25), inset 0 0 0 1px rgba(255,255,255,0.3); }',
        '#mm-btn.ct-launch.ok { background: #1f5c3a; box-shadow: 0 6px 20px rgba(31,92,58,0.35); }',
        '#mm-btn.ct-launch.ok .ct-launch-badge { display: none; }',
        '#mm-btn.ct-launch.loading { background: #5b6b7b; box-shadow: 0 6px 20px rgba(91,107,123,0.3); }',
        '#mm-btn.ct-launch.loading .ct-launch-badge { display: none; }',
        '.mm-badge { display: inline-block; color: white; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; margin-right: 4px; margin-top: 2px; white-space: nowrap; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; }',
        '.mm-row { background: #FFF0F0 !important; border-left: 4px solid #FF4444 !important; }',
        '#mm-panel { position: fixed; bottom: 80px; right: 20px; z-index: 99999; background: #fff; color: #333; border: 1px solid #e2e8f0; border-radius: 16px; padding: 0; width: 480px; max-height: 600px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.15); display: none; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; }',
        '#mm-panel.visible { display: flex; flex-direction: column; }',
        '#mm-panel h3 { margin: 0; font-size: 15px; color: #1e293b; font-weight: 700; }',
        '#mm-panel .mm-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; border-radius: 16px 16px 0 0; cursor: grab; user-select: none; }',
        '#mm-panel .mm-header:active { cursor: grabbing; }',
        '#mm-panel .mm-close { background: none; border: none; font-size: 18px; cursor: pointer; color: #94a3b8; padding: 4px 8px; border-radius: 6px; transition: all 0.15s; }',
        '#mm-panel .mm-close:hover { background: #f1f5f9; color: #475569; }',
        '#mm-panel .mm-body { overflow-y: auto; flex: 1; padding: 0; }',
        '#mm-panel .mm-list { padding: 8px 14px 14px; }',
        '#mm-panel .mm-item { padding: 12px; margin-bottom: 8px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0; transition: border-color 0.15s; }',
        '#mm-panel .mm-item:hover { border-color: #cbd5e1; }',
        '#mm-panel .mm-item:last-child { margin-bottom: 0; }',
        '#mm-panel .mm-item-name { font-weight: 700; color: #1e293b; font-size: 14px; }',
        '#mm-panel .mm-item-detail { font-size: 11px; color: #475569; margin-top: 4px; font-weight: 600; }',
        '#mm-panel .mm-item-alerts { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }',
        '#mm-panel .mm-allclear { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; padding: 14px 16px; margin: 12px 14px; font-size: 13px; color: #166534; }',
        '#mm-panel .mm-type-pill { padding: 4px 12px; border-radius: 20px; color: white; font-size: 11px; font-weight: 700; display: inline-block; cursor: pointer; opacity: 1; transition: opacity 0.2s; border: 2px solid transparent; }',
        '#mm-panel .mm-type-pill.inactive { opacity: 0.35; }',
        '#mm-panel .mm-type-pill.active-filter { border-color: #1e293b; }',
        '#mm-panel .mm-filter-bar { padding: 8px 14px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }',
        '#mm-panel .mm-filter-label { font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-right: 4px; }',
        '.mm-elevate-link { display: inline-block; font-size: 11px; color: #dc2626; text-decoration: underline; cursor: pointer; margin-left: 4px; }',
        /* error details popup */
        '#mm-err-popup { position: fixed; z-index: 100000; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.25); max-width: 1200px; min-width: 1100px; max-height: 500px; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; }',
        '#mm-err-popup .err-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #232F3E; color: #FF9900; font-weight: 700; font-size: 13px; border-radius: 12px 12px 0 0; cursor: grab; user-select: none; }',
        '#mm-err-popup .err-header:active { cursor: grabbing; }',
        '#mm-err-popup .err-close { background: none; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; padding: 2px 6px; }',
        '#mm-err-popup .err-close:hover { color: #fff; }',
        '#mm-err-popup .err-body { overflow-y: auto; max-height: 430px; padding: 12px; }',
        '#mm-err-popup .err-table { width: 100%; border-collapse: collapse; font-size: 11px; }',
        '#mm-err-popup .err-table th { background: #f1f5f9; color: #475569; font-weight: 700; padding: 6px 8px; text-align: left; border-bottom: 2px solid #e2e8f0; position: sticky; top: 0; white-space: nowrap; cursor: pointer; }',
        '#mm-err-popup .err-table th:hover { background: #e2e8f0; color: #1e293b; }',
        '#mm-err-popup .err-table td { padding: 5px 8px; border-bottom: 1px solid #f1f5f9; color: #334155; }',
        '#mm-err-popup .err-table tr:hover td { background: #fef2f2; }',
        '#mm-err-popup .err-empty { padding: 20px; text-align: center; color: #94a3b8; font-size: 13px; }',
        '#mm-err-popup .err-count { font-size: 11px; color: #94a3b8; font-weight: 400; margin-left: 8px; }',
        '.mm-err-btn { display: inline-block; font-size: 10px; color: #fff; background: #232F3E; padding: 2px 8px; border-radius: 8px; cursor: pointer; margin-left: 4px; font-weight: 600; transition: background 0.15s; }',
        '.mm-err-btn:hover { background: #FF9900; }',
        '.mm-uncomplete-btn:hover { background: #b91c1c !important; }',
        /* dashboard (clickable filters) */
        '#ct-dashboard { position:sticky; top:0; z-index:5; background:#fff; margin:0; padding:10px 14px 8px; border-bottom:1px solid #eef1f4; }',
        '.ct-tiles { display:flex; gap:8px; margin-bottom:8px; }',
        '.ct-tile { flex:1; border:none; border-radius:12px; padding:10px 6px; color:#fff; text-align:center; cursor:pointer; font-family:inherit; box-shadow:0 2px 6px rgba(15,45,74,0.12); transition:transform .12s ease, box-shadow .12s ease, filter .12s ease; }',
        '.ct-tile:hover { transform:translateY(-2px); box-shadow:0 6px 16px rgba(15,45,74,0.22); filter:brightness(1.08); }',
        '.ct-tile:active { transform:translateY(0); }',
        '.ct-tile-active { outline:3px solid #ff9900; outline-offset:1px; filter:brightness(1.1); }',
        '.ct-tile-n { font-size:22px; font-weight:800; line-height:1; }',
        '.ct-tile-l { font-size:9.5px; font-weight:700; opacity:0.92; margin-top:3px; letter-spacing:0.2px; }',
        '.ct-tile-sub { font-size:8px; font-weight:600; opacity:0.72; margin-top:1px; letter-spacing:0.2px; }',
        '.mm-compact { display:flex; align-items:center; justify-content:space-between; padding:7px 10px; cursor:pointer; border-radius:8px; }',
        '.mm-compact:hover { background:#f1f5f9; }',
        '.mm-compact .lg { font-family:ui-monospace,Menlo,monospace; font-size:12px; font-weight:700; color:#1e293b; }',
        '.mm-compact .rt { display:flex; align-items:center; gap:6px; }',
        '.mm-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }',
        '.mm-cnt { font-size:10px; font-weight:700; color:#64748b; background:#e2e8f0; border-radius:10px; padding:1px 7px; }',
        '.mm-chev { font-size:10px; color:#94a3b8; }',
        '.ct-prog-wrap { margin:4px 0 8px; }',
        '.ct-prog-label { font-size:10px; font-weight:700; color:#475569; margin-bottom:3px; }',
        '.ct-prog-track { height:8px; background:#e6e8eb; border-radius:6px; overflow:hidden; }',
        '.ct-prog-fill { height:100%; background:linear-gradient(90deg,#16a34a,#22c55e); border-radius:6px; transition:width .3s; }',
        '.ct-break { margin:6px 0 2px; }',
        '.ct-break-h { font-size:9px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.3px; margin-bottom:4px; }',
        '.ct-break-row { display:flex; flex-wrap:wrap; gap:5px; }',
        '.ct-pill { font-size:10px; font-weight:600; color:#fff; padding:3px 9px; border:none; border-radius:999px; cursor:pointer; font-family:inherit; transition:transform .1s ease, filter .1s ease; }',
        '.ct-pill:hover { transform:translateY(-1px); filter:brightness(1.1); }',
        '.ct-pill-metric { background:#334155; }',
        '.ct-pill-active { outline:2px solid #ff9900; outline-offset:1px; }',
        '.ct-activefilter { margin-top:8px; font-size:10.5px; color:#475569; display:flex; align-items:center; gap:8px; }',
        '.ct-clearfilter { background:#eef1f4; border:none; border-radius:999px; padding:2px 9px; font-size:10px; font-weight:700; color:#334155; cursor:pointer; }',
        '.ct-clearfilter:hover { background:#e0e5ea; }',
        /* claim indicator */
        '.ct-claim { display:inline-block; font-size:9px; font-weight:700; color:#7c2d12; background:#fde68a; border:1px solid #f59e0b; padding:1px 6px; border-radius:8px; margin-left:6px; }',
        '.ct-claim-mine { color:#065f46; background:#a7f3d0; border-color:#10b981; }',
        /* minimize */
        '#mm-panel.minimized .mm-body { display:none !important; }',
        '#mm-panel.minimized { max-height:none; height:auto; }',
        /* header icons + tooltips */
        '.mm-ico { background:none; border:none; color:#fff; opacity:0.82; font-size:15px; line-height:1; cursor:pointer; padding:2px 6px; border-radius:6px; position:relative; transition:opacity .12s ease, background .12s ease; }',
        '.mm-ico:hover { opacity:1; background:rgba(255,255,255,0.12); }',
        '.mm-ico[data-tip]:hover::after { content:attr(data-tip); position:absolute; top:120%; right:0; white-space:nowrap; background:#0f2d4a; color:#fff; font-size:10px; font-weight:600; padding:3px 7px; border-radius:5px; z-index:20; box-shadow:0 2px 8px rgba(0,0,0,0.25); }',
        '.mm-more-menu { position:absolute; top:120%; right:0; background:#fff; border:1px solid #e2e8f0; border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,0.18); padding:6px; z-index:30; min-width:220px; }',
        '.mm-more-item { display:block; width:100%; text-align:left; background:none; border:none; padding:8px 10px; font-size:12px; font-weight:600; color:#b91c1c; border-radius:6px; cursor:pointer; font-family:inherit; }',
        '.mm-more-item:hover { background:#fef2f2; }',
        '.mm-more-item-neutral { color:#1e293b !important; }',
        '.mm-more-item-neutral:hover { background:#eef2ff !important; }',
        /* status line */
        '.ct-status { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; padding:6px 14px; font-size:10.5px; color:#64748b; border-bottom:1px solid #f1f5f9; }',
        '.ct-status b { color:#1e293b; }',
        '.ct-link { color:#0284c7; cursor:pointer; font-weight:600; }',
        '.ct-link:hover { text-decoration:underline; }',
        '.ct-synced { color:#16a34a; font-weight:600; }',
        '.ct-loading { padding:16px 14px; font-size:12px; color:#64748b; text-align:center; }',
        /* modals */
        '.mm-modal-overlay { position:fixed; inset:0; background:rgba(15,23,42,0.45); z-index:1000001; display:flex; align-items:center; justify-content:center; }',
        '.mm-modal { background:#fff; border-radius:14px; box-shadow:0 20px 60px rgba(0,0,0,0.35); width:340px; max-width:90vw; padding:18px; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }',
        '.mm-modal-h { font-size:15px; font-weight:800; color:#0f2d4a; margin-bottom:6px; }',
        '.mm-modal-sub { font-size:12px; color:#475569; margin-bottom:12px; line-height:1.4; }',
        '.mm-scope-list { display:flex; flex-direction:column; gap:6px; max-height:260px; overflow-y:auto; }',
        '.mm-scope-btn { text-align:left; background:#f1f5f9; border:1px solid #e2e8f0; border-radius:8px; padding:9px 12px; font-size:12px; font-weight:600; color:#1e293b; cursor:pointer; font-family:inherit; transition:background .12s ease; }',
        '.mm-scope-btn:hover { background:#e0e7ff; border-color:#c7d2fe; }',
        '.mm-scope-btn b { float:right; color:#7c2d2d; }',
        '.mm-modal-foot { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }',
        '.mm-modal-cancel { background:#eef1f4; border:none; border-radius:8px; padding:8px 14px; font-size:12px; font-weight:700; color:#334155; cursor:pointer; font-family:inherit; }',
        '.mm-modal-go { background:#dc2626; border:none; border-radius:8px; padding:8px 14px; font-size:12px; font-weight:800; color:#fff; cursor:pointer; font-family:inherit; }',
        '.mm-modal-go:hover { background:#b91c1c; }',
        '.mm-sum-table { width:100%; border-collapse:collapse; font-size:12px; margin-top:4px; }',
        '.mm-sum-table th { text-align:left; padding:6px 8px; background:#f1f5f9; color:#475569; font-weight:700; font-size:10px; }',
        '.mm-sum-table td { padding:6px 8px; border-bottom:1px solid #f1f5f9; color:#1e293b; }',
        /* dropdown sections */
        '.ct-drops { display:flex; flex-wrap:wrap; gap:6px; padding:6px 14px; border-bottom:1px solid #f1f5f9; }',
        '.ct-drop-chip { background:#f1f5f9; border:1px solid #e2e8f0; border-radius:999px; padding:3px 10px; font-size:10px; font-weight:700; color:#334155; cursor:pointer; font-family:inherit; }',
        '.ct-drop-chip:hover { background:#e0e7ff; }',
        '.ct-drop-panel { margin:0 14px 8px; max-height:260px; overflow-y:auto; border:1px solid #e2e8f0; border-radius:8px; }',
        '.ct-drop-empty { padding:12px; font-size:11px; color:#94a3b8; text-align:center; }',
        '.ct-drop-table { width:100%; border-collapse:collapse; font-size:10px; }',
        '.ct-drop-table th { position:sticky; top:0; background:#f1f5f9; text-align:left; padding:5px 8px; font-weight:700; color:#475569; }',
        '.ct-drop-table td { padding:5px 8px; border-bottom:1px solid #f1f5f9; color:#1e293b; }',
        '.ct-hide-row { display:flex; gap:8px; padding:10px; }',
        '.ct-hide-toggle { color:#fff; font-size:10px; font-weight:700; padding:4px 12px; border-radius:999px; cursor:pointer; }',
        '.ct-undo-btn { background:#fee2e2; color:#b91c1c; border:none; border-radius:6px; padding:2px 8px; font-size:9px; font-weight:700; cursor:pointer; font-family:inherit; }',
        '.ct-undo-btn:hover { background:#fecaca; }'
    ].join(' ');
    document.head.appendChild(styles);

    // === ERROR DETAILS POPUP ===
    function showErrDetailsPopup(login, name, anchorEl) {
        closeErrDetailsPopup();
        var details = coachingErrDetails[login] || [];
        var completed = JSON.parse(GM_getValue('elevateCompleted', '{}'));
        var popup = document.createElement('div'); popup.id = 'mm-err-popup';

        // completion keys are login|metric|DATE — map metric -> record
        var completedMetrics = {};
        for (var ck in completed) {
            if (ck.indexOf(login + '|') === 0) completedMetrics[stripDate(ck.substring(login.length + 1))] = completed[ck];
        }
        var doneCount = 0;
        for (var di = 0; di < details.length; di++) { if (completedMetrics[details[di].metric]) doneCount++; }

        var ctData = cycleTimeByLogin[login];
        var popupErrCount = details.length + ((ctData && ctData.length > 0) ? 1 : 0);

        var headerHtml = '<div class="err-header"><span>\uD83D\uDCCB ' + (name || login) + ' <span style="color:#94a3b8;font-weight:400;font-size:11px;">(' + login + ')</span> \u2014 Error Details<span class="err-count">' + popupErrCount + ' error' + (popupErrCount !== 1 ? 's' : '') + (doneCount > 0 ? ' \u2022 ' + doneCount + ' coached' : '') + '</span></span><button class="err-close" id="mm-err-close">&times;</button></div>';
        var bodyHtml = '<div class="err-body">';
        if (details.length === 0) {
            bodyHtml += '<div class="err-empty">No error details available.<br><span style="font-size:11px;color:#92400e;">Open the QuickSight Elevate dashboard and run the Elevate Error Scraper to pull this data.</span></div>';
        } else {
            var metricSummary = {};
            details.forEach(function(d) { if (!metricSummary[d.metric]) metricSummary[d.metric] = { total: 0, done: !!completedMetrics[d.metric] }; metricSummary[d.metric].total++; });
            bodyHtml += '<div style="padding:8px 4px 4px;display:flex;gap:4px;flex-wrap:wrap;align-items:center;"><span class="err-filter-pill err-filter-active" data-metric="ALL" style="display:inline-block;font-size:9px;padding:2px 8px;border-radius:8px;font-weight:700;background:#232F3E;color:#FF9900;cursor:pointer;">All (' + details.length + ')</span>';
            for (var ms in metricSummary) { bodyHtml += '<span class="err-filter-pill" data-metric="' + ms + '" style="display:inline-block;font-size:9px;padding:2px 8px;border-radius:8px;font-weight:700;cursor:pointer;' + (metricSummary[ms].done ? 'background:#dcfce7;color:#166534;' : 'background:#fef2f2;color:#991b1b;') + '">' + (metricSummary[ms].done ? '\u2705 ' : '\u23F3 ') + ms + ' (' + metricSummary[ms].total + ')</span>'; }
            bodyHtml += '</div>';
            bodyHtml += '<table class="err-table"><thead><tr><th data-sort="eventDay">Date \u2195</th><th data-sort="metric">Metric \u2195</th><th data-sort="itemName">Item Name \u2195</th><th data-sort="asin">ASIN \u2195</th><th data-sort="category">Category \u2195</th><th data-sort="orderId">Order ID \u2195</th><th data-sort="locationId">Location \u2195</th><th data-sort="pickZone">Pick Zone \u2195</th><th data-sort="eventTime">Time \u2195</th></tr></thead><tbody>';
            for (var i = 0; i < details.length; i++) {
                var d = details[i]; var isDone = !!completedMetrics[d.metric];
                bodyHtml += '<tr data-err-metric="' + (d.metric||'') + '" style="' + (isDone ? 'text-decoration:line-through;color:#94a3b8;opacity:0.6;' : '') + '"><td>' + (d.eventDay||'-') + '</td><td><strong>' + (d.metric||'-') + '</strong></td><td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + (d.itemName||'').replace(/"/g,'&quot;') + '">' + (d.itemName||'-') + '</td><td>' + (d.asin||'-') + '</td><td>' + (d.category||'-') + '</td><td style="font-size:10px;">' + (d.orderId||'-') + '</td><td>' + (d.locationId||'-') + '</td><td>' + (d.pickZone||'-') + '</td><td>' + (d.eventTime||'-') + '</td></tr>';
            }
            bodyHtml += '</tbody></table>';
        }

        // Cycle time — most recent 4 weeks only.
        if (ctData && ctData.length > 0) {
            var recentCT = ctData.slice().sort(function(a, b) { return (b.pickingWeek || '').localeCompare(a.pickingWeek || ''); }).slice(0, 4);
            function cell(val, over) { return '<td style="' + (over ? 'color:#dc2626;font-weight:700;' : '') + '">' + val + '</td>'; }
            function bench(val) { return '<td style="color:#64748b;">' + (val || '-') + '</td>'; }
            bodyHtml += '<div style="margin-top:12px;padding:8px;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;">';
            bodyHtml += '<div style="font-size:11px;font-weight:700;color:#92400e;margin-bottom:6px;">\u23F1 Cycle Time Breakdown (Seconds) (latest ' + recentCT.length + ' of ' + ctData.length + ' week' + (ctData.length !== 1 ? 's' : '') + ')</div>';
            bodyHtml += '<table class="err-table" style="font-size:10px;"><thead><tr><th>Week</th><th>Hrs</th><th>UPH</th><th>ASIN\u2192Post</th><th>Benchmark</th><th>Action to<br>Next Bin(Diff)</th><th>Benchmark</th><th>Action to<br>Next Bin(Same)</th><th>Benchmark</th><th>Post\u2192Slam</th><th>Benchmark</th><th>Bag Prep<br>Error</th><th>Slam Bag<br>Error</th><th>Multi Qty<br>Error</th><th>Loc Scan<br>Error</th></tr></thead><tbody>';
            recentCT.forEach(function(ct) {
                bodyHtml += '<tr>'
                    + '<td>' + (ct.pickingWeek || '-') + '</td>'
                    + '<td>' + (ct.weekHours || '-') + '</td>'
                    + '<td>' + (ct.uph || '-') + '</td>'
                    + cell(ct.asinToPost || '-', ct.asinToPost > ct.siteBenchmarkASINToPost) + bench(ct.siteBenchmarkASINToPost)
                    + cell(ct.actionToNextLocationDiffBin || '-', ct.actionToNextLocationDiffBin > ct.siteBenchmarkActionToNextDiffBin) + bench(ct.siteBenchmarkActionToNextDiffBin)
                    + cell(ct.actionToNextLocationSameBin || '-', ct.actionToNextLocationSameBin > ct.siteBenchmarkActionToNextSameBin) + bench(ct.siteBenchmarkActionToNextSameBin)
                    + cell(ct.postToSlam || '-', ct.postToSlam > ct.siteBenchmarkPostToSlam) + bench(ct.siteBenchmarkPostToSlam)
                    + cell(ct.bagPrepError || 0, ct.bagPrepError > 0)
                    + cell(ct.slamBagError || 0, ct.slamBagError > 0)
                    + cell(ct.multiQtyError || 0, ct.multiQtyError > 0)
                    + cell(ct.locationScanError || 0, ct.locationScanError > 0)
                    + '</tr>';
            });
            bodyHtml += '</tbody></table></div>';
        }
        bodyHtml += '</div>';
        popup.innerHTML = headerHtml + bodyHtml;
        document.body.appendChild(popup);

        if (anchorEl) {
            var rect = anchorEl.getBoundingClientRect();
            var left = Math.min(rect.left, window.innerWidth - 1220);
            var top = rect.bottom + 8;
            if (top + 400 > window.innerHeight) top = Math.max(10, rect.top - 420);
            popup.style.left = Math.max(10, left) + 'px'; popup.style.top = top + 'px';
        } else {
            popup.style.left = '50%'; popup.style.top = '50%'; popup.style.transform = 'translate(-50%,-50%)';
        }
        document.getElementById('mm-err-close').addEventListener('click', closeErrDetailsPopup);

        // Metric filter pills
        function markActive(p) { p.style.outline = '2px solid #FF9900'; p.style.boxShadow = '0 0 0 1px #FF9900'; }
        popup.querySelectorAll('.err-filter-pill').forEach(function(pill) {
            pill.addEventListener('click', function(e) {
                e.stopPropagation();
                var metric = pill.dataset.metric;
                popup.querySelectorAll('.err-filter-pill').forEach(function(p) { p.classList.remove('err-filter-active'); p.style.outline = 'none'; p.style.boxShadow = 'none'; });
                pill.classList.add('err-filter-active');
                markActive(pill);
                popup.querySelectorAll('tr[data-err-metric]').forEach(function(row) {
                    row.style.display = (metric === 'ALL' || row.dataset.errMetric === metric) ? '' : 'none';
                });
            });
        });
        var allPill = popup.querySelector('.err-filter-active');
        if (allPill) markActive(allPill);

        // Column sort
        var colIdx = { eventDay:0, metric:1, itemName:2, asin:3, category:4, orderId:5, locationId:6, pickZone:7, eventTime:8 };
        var errSortCol = null, errSortAsc = true;
        popup.querySelectorAll('th[data-sort]').forEach(function(th) {
            th.addEventListener('click', function(e) {
                e.stopPropagation();
                var col = th.dataset.sort;
                if (errSortCol === col) errSortAsc = !errSortAsc; else { errSortCol = col; errSortAsc = true; }
                popup.querySelectorAll('th[data-sort]').forEach(function(h) {
                    var label = h.textContent.replace(/[\u2195\u25B2\u25BC]/g, '').trim();
                    h.textContent = label + (h.dataset.sort === errSortCol ? (errSortAsc ? ' \u25B2' : ' \u25BC') : ' \u2195');
                });
                var tbody = popup.querySelector('tbody');
                if (!tbody) return;
                var idx = colIdx[col] !== undefined ? colIdx[col] : 0;
                var rows = Array.from(tbody.querySelectorAll('tr'));
                rows.sort(function(a, b) {
                    var aVal = (a.children[idx] ? a.children[idx].textContent.trim() : '').toLowerCase();
                    var bVal = (b.children[idx] ? b.children[idx].textContent.trim() : '').toLowerCase();
                    if (aVal < bVal) return errSortAsc ? -1 : 1;
                    if (aVal > bVal) return errSortAsc ? 1 : -1;
                    return 0;
                });
                rows.forEach(function(r) { tbody.appendChild(r); });
            });
        });

        // Draggable header (listeners removed when the popup closes)
        var errHeader = popup.querySelector('.err-header');
        var errDragging = false, errStartX, errStartY, errOrigX, errOrigY;
        errHeader.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'BUTTON') return;
            errDragging = true; errStartX = e.clientX; errStartY = e.clientY;
            var r = popup.getBoundingClientRect(); errOrigX = r.left; errOrigY = r.top;
            e.preventDefault();
        });
        function onMove(e) {
            if (!errDragging) return;
            popup.style.left = (errOrigX + e.clientX - errStartX) + 'px';
            popup.style.top = (errOrigY + e.clientY - errStartY) + 'px';
            popup.style.transform = 'none';
        }
        function onUp() { errDragging = false; }
        function onKey(e) { if (e.key === 'Escape') { e.stopImmediatePropagation(); closeErrDetailsPopup(); } }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('keydown', onKey, true);
        popup.__cleanup = function() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.removeEventListener('keydown', onKey, true);
        };
    }

    function closeErrDetailsPopup() {
        var existing = document.getElementById('mm-err-popup');
        if (existing) { if (existing.__cleanup) existing.__cleanup(); existing.remove(); }
    }

    // Confirm popup for elevate completion
    function showElevateConfirm(login, metric, onYes, onNo) {
        var overlay = document.createElement('div');
        overlay.id = 'mm-elevate-confirm';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000000;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:12px;padding:24px 32px;box-shadow:0 20px 60px rgba(0,0,0,0.3);text-align:center;max-width:400px;width:90%;';
        box.innerHTML = '<div style="font-size:16px;font-weight:700;color:#1e293b;margin-bottom:8px;">Confirm Elevate Was Completed</div>' +
            '<div style="font-size:13px;color:#475569;margin-bottom:20px;"><strong>' + metric + '</strong> for <strong>' + login + '</strong></div>' +
            '<div style="display:flex;gap:12px;justify-content:center;">' +
            '<button id="mm-confirm-yes" style="padding:10px 32px;background:#16a34a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;">Yes</button>' +
            '<button id="mm-confirm-no" style="padding:10px 32px;background:#dc2626;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;">No</button>' +
            '</div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        document.getElementById('mm-confirm-yes').addEventListener('click', function() { overlay.remove(); if (onYes) onYes(); });
        document.getElementById('mm-confirm-no').addEventListener('click', function() { overlay.remove(); if (onNo) onNo(); });
        overlay.addEventListener('click', function(e) { if (e.target === overlay) { overlay.remove(); if (onNo) onNo(); } });
    }

    // Restore a completed item for everyone. OWN-LOGIN GUARD: a leader may only undo their own.
    function markNotCompleted(login, metric) {
        metric = stripDate(metric);
        var me = (GM_getValue('leader_login', '') || '').toLowerCase();
        if (!me) { ctConfirm('Set your login first', 'Click \'set your login\' at the top before undoing.', 'OK', null); return; }
        var completedBy = '';
        try {
            var comp = JSON.parse(GM_getValue('elevateCompleted', '{}'));
            var rec = comp[ckey(login, metric)];
            if (rec) completedBy = (rec.completedBy || '').toLowerCase();
        } catch(e) {}
        if (completedBy && completedBy !== me) {
            ctConfirm('Not your completion', 'You can only undo coachings YOU completed.<br><br>Completed by: <b>' + completedBy + '</b><br>You are: <b>' + me + '</b>', 'OK', null);
            return;
        }
        addToCoachingLog(login, metric, me, 'unmarked');
        matchAndAlert();
        console.log('[CoachTracker] Marked NOT completed: ' + login + ' | ' + metric + ' — restored for all users');
    }

    // Complete a coaching: clear pending marker + claim, log it, re-render.
    function completeCoaching(login, metric) {
        var leader = getLeaderLogin();
        if (!leader) return false;
        clearPending(login, metric);
        addToCoachingLog(login, metric, leader, 'completed');
        clearClaim(login, metric);
        matchAndAlert();
        return true;
    }

    function getPending() { return JSON.parse(GM_getValue('elevatePending', '{}')); }
    function isPending(login, metric) { return !!getPending()[login + '|' + metric]; }
    function setPending(login, metric) { var p = getPending(); p[login + '|' + metric] = Date.now(); GM_setValue('elevatePending', JSON.stringify(p)); }
    function clearPending(login, metric) { var p = getPending(); delete p[login + '|' + metric]; GM_setValue('elevatePending', JSON.stringify(p)); }

    function showToast(msg) {
        var toast = document.createElement('div');
        toast.textContent = msg;
        toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.4);border:1px solid #334155;max-width:500px;text-align:center;';
        document.body.appendChild(toast);
        setTimeout(function() { toast.remove(); }, 5000);
    }

    // First click on a coaching: copy login, mark pending + claim, open the form.
    // Second click: confirm submission (Yes = complete, No = reset).
    function handleFormClick(login, metric, url, onPendingUI, onResetUI) {
        if (isPending(login, metric)) {
            showElevateConfirm(login, metric, function() {
                completeCoaching(login, metric);
            }, function() {
                clearPending(login, metric);
                if (onResetUI) onResetUI();
            });
            return;
        }
        var go = function() {
            setPending(login, metric);
            setClaim(login, metric); // live 'in progress' claim
            if (onPendingUI) onPendingUI();
            window.open(url, '_blank');
        };
        navigator.clipboard.writeText(login).then(function() {
            showToast('\u2705 "' + login + '" copied \u2014 Ctrl+V into the Alias field. Click again after submitting to mark complete.');
            go();
        }).catch(go);
    }

    // === ROW HIGHLIGHTING (tags on-page rows that mention a pending login) ===
    function highlightRows() {
        document.querySelectorAll('.mm-badge').forEach(function(el) { if (!el.closest('#mm-panel')) el.remove(); });
        document.querySelectorAll('.mm-err-btn').forEach(function(el) { if (!el.closest('#mm-panel')) el.remove(); });
        document.querySelectorAll('.mm-row').forEach(function(el) { el.classList.remove('mm-row'); });
        if (currentMatches.length === 0) return;
        var byLogin = {}, tagged = {};
        currentMatches.forEach(function(m) { byLogin[m.login] = m; });
        var allSpans = document.querySelectorAll('span, a, div, p');
        for (var i = 0; i < allSpans.length; i++) {
            var el = allSpans[i];
            if (el.children.length > 2) continue;
            if (el.closest('#mm-panel, #mm-err-popup')) continue;
            var text = el.textContent ? el.textContent.trim().toLowerCase() : '';
            if (!text || text.length > 50) continue;
            for (var login in byLogin) {
                if (text.indexOf(login) === -1 || tagged[login]) continue;
                var match = byLogin[login]; tagged[login] = true;
                var row = el.closest('tr, [class*="row"], [class*="card"], [class*="list-item"], [role="row"]');
                if (row) row.classList.add('mm-row');
                var nameArea = (row ? row.querySelector('a') : null) || el;
                if (nameArea && nameArea.parentNode && !nameArea.parentNode.querySelector('.mm-badge')) {
                    match.alerts.forEach(function(alert) {
                        var badge = document.createElement('span');
                        badge.className = 'mm-badge';
                        badge.style.cssText = 'background:' + getTypeConfig(alert.type).bg + ';';
                        badge.textContent = alert.type === 'ELEV'
                            ? alert.metric + ' (Elevate)'
                            : '\u2B50 ' + (alert.metric || 'Positive Reinforcement');
                        if (alert.formURL) {
                            badge.style.cursor = 'pointer';
                            var setPendingLook = function() { badge.style.outline = '2px dashed #fff'; badge.style.opacity = '0.7'; badge.title = 'Form opened \u2014 click again to mark as submitted'; };
                            var setNormalLook = function() { badge.style.outline = 'none'; badge.style.opacity = '1'; badge.title = 'Click: copies login & opens form'; };
                            if (isPending(match.login, alert.metric)) setPendingLook(); else setNormalLook();
                            badge.addEventListener('click', function(e) {
                                e.stopPropagation();
                                handleFormClick(match.login, alert.metric, alert.formURL, setPendingLook, setNormalLook);
                            });
                        }
                        nameArea.parentNode.appendChild(badge);
                    });
                    if (match.alerts.some(function(a) { return a.type === 'ELEV'; })) {
                        var errBtn = document.createElement('span');
                        errBtn.className = 'mm-err-btn';
                        var errCount = errCountFor(match);
                        errBtn.textContent = '\uD83D\uDCCB ' + (errCount > 0 ? errCount + ' Errors' : 'View Errors');
                        errBtn.title = errCount > 0 ? 'Click to view ' + errCount + ' error details for coaching' : 'No error details uploaded yet';
                        errBtn.addEventListener('click', function(e) {
                            e.stopPropagation();
                            showErrDetailsPopup(match.login, match.name, e.target);
                        });
                        nameArea.parentNode.appendChild(errBtn);
                    }
                }
                break;
            }
        }
    }

    function errCountFor(m) {
        var n = (coachingErrDetails[m.login] || []).length;
        if (m.alerts.some(function(a) { return a.metric && a.metric.toLowerCase().indexOf('combined cycle') !== -1; })) n += 1;
        return n;
    }

    // === LAUNCHER BUTTON ===
    function createButton() {
        var btn = document.createElement('button');
        btn.id = 'mm-btn'; btn.className = 'ct-launch loading';
        btn.innerHTML = '<span class="ct-launch-ico">\u23F3</span><span class="ct-launch-txt">Coaching</span><span class="ct-launch-badge">\u2014</span>';
        btn.onclick = togglePanel;
        var isDragging = false, offsetX, offsetY;
        btn.addEventListener('mousedown', function(e) {
            isDragging = false; offsetX = e.clientX - btn.getBoundingClientRect().left; offsetY = e.clientY - btn.getBoundingClientRect().top;
            function onMove(ev) { isDragging = true; btn.style.right = 'auto'; btn.style.bottom = 'auto'; btn.style.left = (ev.clientX - offsetX) + 'px'; btn.style.top = (ev.clientY - offsetY) + 'px'; }
            function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); if (isDragging) GM_setValue('btnPos', JSON.stringify({left: btn.style.left, top: btn.style.top})); }
            document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
        });
        btn.addEventListener('click', function(e) { if (isDragging) { e.stopImmediatePropagation(); isDragging = false; } }, true);
        document.body.appendChild(btn);
        var saved = GM_getValue('btnPos', null);
        if (saved) { var pos = JSON.parse(saved); btn.style.right = 'auto'; btn.style.bottom = 'auto'; btn.style.left = pos.left; btn.style.top = pos.top; }
        return btn;
    }

    function updateButton() {
        var btn = document.getElementById('mm-btn');
        if (!btn) return;
        var pending = 0;
        for (var i = 0; i < currentMatches.length; i++) { pending += (currentMatches[i].alerts || []).length; }
        var ico = btn.querySelector('.ct-launch-ico');
        var badge = btn.querySelector('.ct-launch-badge');
        if (currentMatches.length > 0) {
            btn.className = 'ct-launch has-pending';
            ico.textContent = '\uD83D\uDEA8';
            badge.textContent = pending;
        } else if (onSiteCount > 0) {
            btn.className = 'ct-launch ok';   // roster loaded, nothing pending
            ico.textContent = '\u2705';
        } else {
            btn.className = 'ct-launch loading';
            ico.textContent = '\u23F3';
        }
    }

    // === PANEL STATE ===
    var activeFilters = [];     // type filters (ELEV / POS)
    var activeElevMetric = [];  // elevate metric sub-filters
    var activeSearch = '';
    var activeSort = 'metric';
    var expandedLogins = {};    // login -> true when its detail card is expanded
    var openDrop = '';          // which dropdown section is open (survives re-renders)
    var recentOpen = false;     // Recently Completed section open state
    var activeDashFilter = null; // {kind:'all'|'pending'|'inprogress'|'done'|'positive'|'metric', value?}
    var hiddenTypes = JSON.parse(GM_getValue('hiddenTypes', '[]'));

    function h(v) { return (v == null ? '' : String(v)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    // Shift-group buckets from currently-pending coachings (blank shift -> "Unscheduled today").
    function buildShiftGroups() {
        var groups = {};
        currentMatches.forEach(function(m) {
            (m.alerts || []).forEach(function(a) {
                if (a.type !== 'ELEV' && a.type !== 'POS') return;
                var label = (a.shift || '').trim() || 'Unscheduled today';
                if (!groups[label]) groups[label] = [];
                groups[label].push({ login: m.login, metric: a.metric });
            });
        });
        return groups;
    }

    // Per-leader tally of completions from the shared log. First completer gets credit; 'unmarked' undoes.
    function isRealLeader(by) {
        if (!by) return false;
        var b = by.toLowerCase();
        return !(b === 'elevate-auto' || b === 'auto-submitted' || b === 'unknown');
    }
    function computeLeaderTotals() {
        var pairs = {}, totals = {}, lastTs = {};
        coachingLog.forEach(function(e) {
            if (!e || !e.login) return;
            var pk = ckey(e.login, e.metric);
            if (e.action === 'completed' && isRealLeader(e.completedBy)) { if (!pairs[pk]) pairs[pk] = e.completedBy; }
            else if (e.action === 'unmarked') delete pairs[pk];
        });
        Object.keys(pairs).forEach(function(k) { totals[pairs[k]] = (totals[pairs[k]] || 0) + 1; });
        coachingLog.forEach(function(e) {
            if (e.action === 'completed' && e.timestamp && pairs[ckey(e.login, e.metric)] === e.completedBy) {
                if (!lastTs[e.completedBy] || e.timestamp > lastTs[e.completedBy]) lastTs[e.completedBy] = e.timestamp;
            }
        });
        var leaders = Object.keys(totals).sort(function(a, b) { return totals[b] - totals[a]; });
        return { leaders: leaders, totals: totals, lastTs: lastTs };
    }

    function openModal(innerHtml) {
        var prior = document.getElementById('mm-markall-modal'); if (prior) prior.remove();
        var overlay = document.createElement('div');
        overlay.id = 'mm-markall-modal';
        overlay.className = 'mm-modal-overlay';
        overlay.innerHTML = '<div class="mm-modal">' + innerHtml + '</div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', function(ev) { if (ev.target === overlay) overlay.remove(); });
        return overlay;
    }

    function showTeamSummary() {
        var t = computeLeaderTotals();
        var grand = t.leaders.reduce(function(s, l) { return s + t.totals[l]; }, 0);
        var rows;
        if (t.leaders.length === 0) {
            rows = '<div class="mm-modal-sub">No coachings completed yet.</div>';
        } else {
            rows = '<table class="mm-sum-table"><thead><tr><th>Leader</th><th>Completed</th><th>Last</th></tr></thead><tbody>';
            t.leaders.forEach(function(l) {
                var d = t.lastTs[l] ? new Date(t.lastTs[l]) : null;
                var when = d ? ((d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : '-';
                rows += '<tr><td><b>' + h(l) + '</b></td><td>' + t.totals[l] + '</td><td>' + when + '</td></tr>';
            });
            rows += '</tbody></table>';
        }
        var overlay = openModal('<div class="mm-modal-h">\uD83C\uDFC6 Team Coaching Summary</div>'
            + '<div class="mm-modal-sub">' + grand + ' coaching(s) completed \u2014 credited to first completer.</div>'
            + rows
            + '<div class="mm-modal-foot"><button class="mm-modal-cancel" id="mm-sum-close">Close</button></div>');
        document.getElementById('mm-sum-close').addEventListener('click', function() { overlay.remove(); });
    }

    // Two-step guarded mark-all: pick scope (All / a shift group), then confirm.
    function markAllPendingComplete() {
        var leader = getLeaderLogin();
        if (!leader) { alert('Set your login first (needed to attribute completions).'); return; }
        var groups = buildShiftGroups();
        var labels = Object.keys(groups);
        var total = labels.reduce(function(s, l) { return s + groups[l].length; }, 0);
        if (total === 0) { alert('No pending coachings to mark complete.'); return; }
        labels.sort(function(a, b) {
            if (a === 'Unscheduled today') return 1;
            if (b === 'Unscheduled today') return -1;
            return a.localeCompare(b);
        });
        var scopeBtns = '<button class="mm-scope-btn" data-scope="__ALL__">All pending <b>' + total + '</b></button>';
        labels.forEach(function(l) { scopeBtns += '<button class="mm-scope-btn" data-scope="' + h(l) + '">' + h(l) + ' <b>' + groups[l].length + '</b></button>'; });
        var overlay = openModal('<div class="mm-modal-h">Mark coachings complete</div>'
            + '<div class="mm-modal-sub">Step 1 of 2 \u2014 choose which group to complete:</div>'
            + '<div class="mm-scope-list">' + scopeBtns + '</div>'
            + '<div class="mm-modal-foot"><button class="mm-modal-cancel" id="mm-markall-cancel">Cancel</button></div>');
        function close() { overlay.remove(); }
        document.getElementById('mm-markall-cancel').addEventListener('click', close);
        overlay.addEventListener('click', function(e) {
            var b = e.target.closest('.mm-scope-btn');
            if (!b) return;
            var scope = b.getAttribute('data-scope');
            var items = (scope === '__ALL__') ? labels.reduce(function(acc, l) { return acc.concat(groups[l]); }, []) : (groups[scope] || []);
            var scopeLabel = (scope === '__ALL__') ? 'ALL pending' : scope;
            overlay.querySelector('.mm-modal').innerHTML = '<div class="mm-modal-h">Are you sure?</div>'
                + '<div class="mm-modal-sub">You are about to mark <b>' + items.length + '</b> coaching(s) complete for <b>' + h(scopeLabel) + '</b>.<br>This updates the whole team\'s shared list.</div>'
                + '<div class="mm-modal-foot">'
                + '<button class="mm-modal-cancel" id="mm-markall-back">Cancel</button>'
                + '<button class="mm-modal-go" id="mm-markall-go">Yes, mark ' + items.length + ' complete</button>'
                + '</div>';
            document.getElementById('mm-markall-back').addEventListener('click', close);
            document.getElementById('mm-markall-go').addEventListener('click', function() {
                var done = 0;
                items.forEach(function(it) {
                    if (!isElevateCompleted(it.login, it.metric)) { addToCoachingLog(it.login, it.metric, leader, 'completed'); done++; }
                });
                close();
                matchAndAlert();
                console.log('[CoachTracker] Mark-all (' + scopeLabel + '): completed ' + done + ' by ' + leader);
            });
        });
    }

    // Delegated click listeners attached ONCE on the persistent #mm-content parent, so they
    // survive innerHTML re-renders (tiles, chips, filters, dropdowns, undo, expand/collapse).
    function attachDashListeners(content) {
        if (!content || content.__ctDashDelegated) return;
        content.__ctDashDelegated = true;
        content.addEventListener('click', function(ev) {
            // Compact row expand/collapse (ignore clicks on interactive children)
            var toggleRow = ev.target.closest('[data-toggle-login]');
            if (toggleRow && content.contains(toggleRow) && !ev.target.closest('a, button, .mm-badge, .mm-elevate-link, .mm-login-copy, .mm-err-btn')) {
                var lg = toggleRow.getAttribute('data-toggle-login');
                if (expandedLogins[lg]) delete expandedLogins[lg]; else expandedLogins[lg] = true;
                updatePanel();
                return;
            }
            // Elevate metric sub-filter chips
            var emPill = ev.target.closest('.mm-type-pill[data-elevmetric]');
            if (emPill && content.contains(emPill)) {
                var em = emPill.getAttribute('data-elevmetric');
                if (em === 'ALL') activeElevMetric = [];
                else { var i0 = activeElevMetric.indexOf(em); if (i0 >= 0) activeElevMetric.splice(i0, 1); else activeElevMetric.push(em); }
                updatePanel();
                return;
            }
            // Type chips (All / Elevate / Positive)
            var tPill = ev.target.closest('.mm-type-pill[data-filter]');
            if (tPill && content.contains(tPill)) {
                var f = tPill.getAttribute('data-filter');
                if (f === 'ALL') { activeFilters = []; activeElevMetric = []; }
                else {
                    var i1 = activeFilters.indexOf(f); if (i1 >= 0) activeFilters.splice(i1, 1); else activeFilters.push(f);
                    if (f !== 'ELEV') activeElevMetric = [];
                }
                updatePanel();
                return;
            }
            // Dashboard tiles / metric pills
            var el = ev.target.closest('[data-filter]');
            if (el && content.contains(el)) {
                var kind = el.getAttribute('data-filter');
                var value = el.getAttribute('data-value');
                if (kind === 'all') activeDashFilter = null;
                else if (activeDashFilter && activeDashFilter.kind === kind && (value == null || activeDashFilter.value === value)) activeDashFilter = null;
                else { activeDashFilter = { kind: kind }; if (value != null) activeDashFilter.value = value; }
                updatePanel();
                return;
            }
            // Dropdown chips (accordion — opening one closes the others)
            var chip = ev.target.closest('.ct-drop-chip');
            if (chip) {
                var which = chip.getAttribute('data-drop');
                openDrop = (openDrop === which) ? '' : which;
                applyDropState();
                return;
            }
            // Hide-type toggle
            var ht = ev.target.closest('.ct-hide-toggle');
            if (ht) {
                var type = ht.getAttribute('data-hidetype');
                var idx = hiddenTypes.indexOf(type);
                if (idx >= 0) hiddenTypes.splice(idx, 1); else hiddenTypes.push(type);
                GM_setValue('hiddenTypes', JSON.stringify(hiddenTypes));
                matchAndAlert();
                return;
            }
            // Undo — own-login only + in-panel triple confirm.
            var undo = ev.target.closest('.ct-undo-btn');
            if (undo) {
                var ul = undo.getAttribute('data-login');
                var um = undo.getAttribute('data-metric');
                var completedBy = (undo.getAttribute('data-by') || '').toLowerCase();
                var me = (getLeaderLogin() || '').toLowerCase();
                if (!me) { ctConfirm('Set your login first', 'Click \'set your login\' at the top before undoing.', 'OK', null); return; }
                if (completedBy && completedBy !== me) {
                    ctConfirm('Not your completion', 'You can only undo coachings YOU completed.<br><br>Completed by: <b>' + h(completedBy) + '</b><br>You are: <b>' + h(me) + '</b>', 'OK', null);
                    return;
                }
                ctConfirm('Undo this completion?', h(ul) + ' \u2014 ' + h(um), 'Undo\u2026', function(){
                    ctConfirm('Are you sure?', 'This will put the coaching back on the pending list.', 'Yes, continue', function(){
                        ctConfirm('FINAL CONFIRM', 'Undo <b>' + h(ul) + '</b> \u2014 ' + h(um) + '?<br><br>Only if completed by mistake.', 'Confirm undo', function(){
                            addToCoachingLog(ul, um, me, 'unmarked');
                            matchAndAlert();
                        });
                    });
                });
                return;
            }
        });
    }

    function applyDropState() {
        [].slice.call(document.querySelectorAll('.ct-drop-panel')).forEach(function(p) {
            p.style.display = (p.id === 'ct-drop-' + openDrop) ? 'block' : 'none';
        });
        [].slice.call(document.querySelectorAll('.ct-drop-chip')).forEach(function(c) {
            var label = c.textContent.replace(/^[\u25B8\u25BE]\s*/, '');
            c.textContent = (c.getAttribute('data-drop') === openDrop ? '\u25BE ' : '\u25B8 ') + label;
        });
    }

    function createPanel() {
        var p = document.createElement('div');
        p.id = 'mm-panel';
        p.innerHTML = '<div class="mm-header" id="mm-drag-handle"><h3>\uD83D\uDEA8 Coaching Tracker <span style="font-size:9px;font-weight:600;color:#ff9900;vertical-align:middle;">v' + h(SCRIPT_VERSION) + '</span></h3>'
            + '<div style="display:flex;align-items:center;gap:2px;position:relative;">'
            + '<button class="mm-ico" id="mm-more" data-tip="More">\u22EF</button>'
            + '<div id="mm-more-menu" class="mm-more-menu" style="display:none;">'
            + '<button id="mm-teamsummary" class="mm-more-item mm-more-item-neutral">\uD83C\uDFC6 Team coaching summary</button>'
            + '<button id="mm-markall" class="mm-more-item">\u2713 Mark ALL pending complete</button>'
            + '</div>'
            + '<button class="mm-ico" id="mm-min" data-tip="Minimize">\u2013</button>'
            + '<button class="mm-ico mm-close" id="mm-close" data-tip="Close">&times;</button>'
            + '</div></div><div class="mm-body"><div id="mm-content"></div></div>';
        document.body.appendChild(p);
        attachDashListeners(document.getElementById('mm-content'));
        document.getElementById('mm-close').onclick = function() { p.classList.remove('visible'); };

        var moreBtn = document.getElementById('mm-more');
        var moreMenu = document.getElementById('mm-more-menu');
        moreBtn.addEventListener('click', function(e){ e.stopPropagation(); moreMenu.style.display = (moreMenu.style.display === 'none' ? 'block' : 'none'); });
        document.addEventListener('click', function(){ moreMenu.style.display = 'none'; });
        document.getElementById('mm-markall').addEventListener('click', function(e){ e.stopPropagation(); moreMenu.style.display = 'none'; markAllPendingComplete(); });
        document.getElementById('mm-teamsummary').addEventListener('click', function(e){ e.stopPropagation(); moreMenu.style.display = 'none'; showTeamSummary(); });

        var minBtn = document.getElementById('mm-min');
        minBtn.addEventListener('click', function(e){
            e.stopPropagation();
            p.classList.toggle('minimized');
            var min = p.classList.contains('minimized');
            minBtn.textContent = min ? '\u2610' : '\u2013';
            minBtn.setAttribute('data-tip', min ? 'Expand' : 'Minimize');
        });

        // Draggable
        var handle = document.getElementById('mm-drag-handle');
        var dragging = false, startX, startY, origX, origY;
        handle.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true; startX = e.clientX; startY = e.clientY;
            var rect = p.getBoundingClientRect(); origX = rect.left; origY = rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!dragging) return;
            p.style.left = (origX + e.clientX - startX) + 'px';
            p.style.top = (origY + e.clientY - startY) + 'px';
            p.style.right = 'auto'; p.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', function() { dragging = false; });

        // Esc closes the panel (the error popup handles its own Esc first).
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && p.classList.contains('visible')) p.classList.remove('visible');
        });
        return p;
    }

    function togglePanel() {
        var p = document.getElementById('mm-panel');
        if (!p) p = createPanel();
        p.classList.toggle('visible');
        updatePanel();
    }

    // === PANEL RENDER ===
    function buildStatusHTML() {
        var leaderLogin = GM_getValue('leader_login', '');
        var currentSite = ELEVATE_SITE_CODE || 'auto-detecting\u2026';
        return '<div class="ct-status">'
            + '<span>\uD83C\uDFED <b>' + h(currentSite) + '</b> <span id="mm-site-change" class="ct-link">(change)</span></span>'
            + '<span>' + (leaderLogin
                ? '\uD83D\uDC64 <b>' + h(leaderLogin) + '</b> <span id="mm-leader-change" class="ct-link">(change)</span>'
                : '\uD83D\uDC64 <span id="mm-leader-set" class="ct-link" style="color:#dc2626;">set your login</span>')
            + '</span>'
            + '<span class="ct-synced">\uD83D\uDD25 Synced</span>'
            + '</div>'
            + '<div id="mm-leader-section" style="display:none;margin:0 14px 8px;"><div style="display:flex;gap:4px"><input id="mm-leader-input" type="text" placeholder="Your login" value="' + h(leaderLogin) + '" style="flex:1;padding:5px 8px;background:#f8fafc;border:1px solid #e2e8f0;color:#1e293b;border-radius:6px;font-size:11px"><button id="mm-leader-save" style="padding:5px 12px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-size:11px;cursor:pointer;font-weight:700">Save</button></div></div>'
            // Collapsible dropdown sections (state kept in openDrop)
            + '<div class="ct-drops">'
            + '<button class="ct-drop-chip" data-drop="log">\u25B8 Coaching Log</button>'
            + '<button class="ct-drop-chip" data-drop="summary">\u25B8 Team Summary</button>'
            + '<button class="ct-drop-chip" data-drop="hide">\u25B8 Hide Types</button>'
            + '<button class="ct-drop-chip" data-drop="completed">\u25B8 Done Today (by leader)</button>'
            + '</div>'
            + '<div id="ct-drop-log" class="ct-drop-panel" style="display:none;">' + buildLogHTML() + '</div>'
            + '<div id="ct-drop-summary" class="ct-drop-panel" style="display:none;">' + buildSummaryHTML() + '</div>'
            + '<div id="ct-drop-hide" class="ct-drop-panel" style="display:none;">' + buildHideTypesHTML() + '</div>'
            + '<div id="ct-drop-completed" class="ct-drop-panel" style="display:none;">' + buildCompletedHTML() + '</div>';
    }

    function applyFilters() {
        var filtered = currentMatches;
        // Dashboard tile / metric pill filter
        if (activeDashFilter && activeDashFilter.kind !== 'all') {
            var adf = activeDashFilter;
            if (adf.kind === 'done') return []; // completed items live in the Done Today section
            filtered = filtered.map(function(m) {
                var kept = (m.alerts || []).filter(function(a) {
                    if (adf.kind === 'inprogress') return !!getActiveClaim(m.login, a.metric);
                    if (adf.kind === 'positive') return a.type === 'POS';
                    if (adf.kind === 'metric') return (a.metric || '') === adf.value;
                    return true; // 'pending'
                });
                return kept.length ? Object.assign({}, m, { alerts: kept }) : null;
            }).filter(Boolean);
        }
        // Type / elevate-metric chips
        if (activeFilters.length > 0) {
            filtered = filtered.filter(function(m) {
                return m.alerts.some(function(a) {
                    if (activeFilters.indexOf(a.type) < 0) return false;
                    if (a.type === 'ELEV' && activeElevMetric.length > 0 && activeElevMetric.indexOf(a.metric) < 0) return false;
                    return true;
                });
            });
        } else if (activeElevMetric.length > 0) {
            filtered = filtered.filter(function(m) {
                return m.alerts.some(function(a) { return a.type === 'ELEV' && activeElevMetric.indexOf(a.metric) >= 0; });
            });
        }
        // Search
        if (activeSearch) {
            var s = activeSearch.toLowerCase();
            filtered = filtered.filter(function(m) { return m.name.toLowerCase().indexOf(s) !== -1 || m.login.indexOf(s) !== -1; });
        }
        // Sort (copy first so currentMatches order is untouched)
        filtered = filtered.slice();
        if (activeSort === 'name') filtered.sort(function(a, b) { return a.name.localeCompare(b.name); });
        else if (activeSort === 'errors') filtered.sort(function(a, b) { return (coachingErrDetails[b.login] || []).length - (coachingErrDetails[a.login] || []).length; });
        else if (activeSort === 'metric') {
            var firstElev = function(m) { var x = m.alerts.find(function(a){ return a.type === 'ELEV'; }); return x ? (x.metric || '') : ''; };
            filtered.sort(function(a, b) { return firstElev(a).localeCompare(firstElev(b)); });
        }
        return filtered;
    }

    function buildFilterBarHTML(typeCounts) {
        var html = '<div class="mm-filter-bar"><span class="mm-filter-label">Filter:</span>';
        html += '<span class="mm-type-pill' + (activeFilters.length === 0 ? ' active-filter' : ' inactive') + '" data-filter="ALL" style="background:#475569;font-size:10px;padding:3px 10px;">All</span>';
        for (var ft in typeCounts) {
            var fcfg = getTypeConfig(ft);
            var fActive = activeFilters.indexOf(ft) >= 0;
            html += '<span class="mm-type-pill' + (fActive ? ' active-filter' : (activeFilters.length === 0 ? '' : ' inactive')) + '" data-filter="' + ft + '" style="background:' + fcfg.bg + ';font-size:10px;padding:3px 10px;">' + fcfg.label + '</span>';
        }
        html += '</div>';
        // Elevate metric sub-filters
        if (activeFilters.indexOf('ELEV') >= 0 || (activeFilters.length === 0 && typeCounts['ELEV'])) {
            var elevMetricCounts = {};
            currentMatches.forEach(function(m) {
                m.alerts.forEach(function(a) { if (a.type === 'ELEV' && a.metric) elevMetricCounts[a.metric] = (elevMetricCounts[a.metric] || 0) + 1; });
            });
            if (Object.keys(elevMetricCounts).length > 1) {
                html += '<div class="mm-filter-bar" style="padding-top:4px;"><span class="mm-filter-label">Elevate Metric:</span>';
                html += '<span class="mm-type-pill' + (activeElevMetric.length === 0 ? ' active-filter' : ' inactive') + '" data-elevmetric="ALL" style="background:#475569;font-size:9px;padding:2px 8px;">All</span>';
                for (var em in elevMetricCounts) {
                    var emActive = activeElevMetric.indexOf(em) >= 0;
                    html += '<span class="mm-type-pill' + (emActive ? ' active-filter' : (activeElevMetric.length === 0 ? '' : ' inactive')) + '" data-elevmetric="' + h(em) + '" style="background:#E74C3C;font-size:9px;padding:2px 8px;">' + h(em) + ' (' + elevMetricCounts[em] + ')</span>';
                }
                html += '</div>';
            }
        }
        return html;
    }

    function buildMatchCardHTML(m) {
        var visibleAlerts = activeFilters.length > 0 ? m.alerts.filter(function(a) { return activeFilters.indexOf(a.type) >= 0; }) : m.alerts;
        var hasElevate = visibleAlerts.some(function(a) { return a.type === 'ELEV'; });
        var isOpen = !!expandedLogins[m.login];
        var dots = '', seen = {};
        visibleAlerts.forEach(function(a){ if (!seen[a.type]) { seen[a.type] = 1; dots += '<span class="mm-dot" style="background:' + getTypeConfig(a.type).bg + ';"></span>'; } });

        var html = '<div class="mm-item">';
        // Compact row: click to expand the full card.
        html += '<div class="mm-compact" data-toggle-login="' + h(m.login) + '">'
            + '<span class="lg">' + h(m.login) + '</span>'
            + '<span class="rt">' + dots
            + '<span class="mm-cnt">' + visibleAlerts.length + '</span>'
            + '<span class="mm-chev">' + (isOpen ? '\u25BE' : '\u25B8') + '</span>'
            + '</span></div>';
        if (isOpen) {
            var fullName = (m.name && m.name !== m.login) ? m.name : '';
            var titleHtml = fullName
                ? (h(fullName) + ' <span style="font-weight:400;color:#64748b;">(' + h(m.login) + ')</span>')
                : (h(m.login) + ' <span style="font-weight:400;color:#94a3b8;font-style:italic;">(name n/a)</span>');
            html += '<div style="display:flex;justify-content:space-between;align-items:center;"><span class="mm-item-name">' + titleHtml + '</span>';
            html += '<span style="display:flex;align-items:center;gap:6px;">';
            if (hasElevate) {
                var errCount = errCountFor(m);
                html += '<span class="mm-err-btn" data-err-login="' + h(m.login) + '" data-err-name="' + h(m.name || '') + '">\uD83D\uDCCB ' + (errCount > 0 ? errCount + ' Errors' : 'View Errors') + '</span>';
            }
            html += '<span style="font-size:10px;color:#64748b;">' + visibleAlerts.length + ' coaching' + (visibleAlerts.length > 1 ? 's' : '') + '</span></span></div>';
            html += '<div class="mm-item-alerts">';
            visibleAlerts.forEach(function(a) {
                var acfg = getTypeConfig(a.type);
                var formLink = a.formURL ? '<a class="mm-elevate-link" data-login="' + h(m.login) + '" data-metric="' + h(a.metric) + '" data-url="' + h(a.formURL) + '">Open Form</a>' : '';
                if (a.type === 'ELEV') {
                    html += '<span class="mm-badge" style="background:' + acfg.bg + ';">' + h(a.metric) + '</span>';
                    html += claimIndicatorHTML(m.login, a.metric);
                    html += formLink;
                } else if (a.type === 'POS') {
                    html += '<span class="mm-badge" style="background:' + acfg.bg + ';">\u2B50 ' + h(a.metric || 'Positive Reinforcement') + '</span>';
                    html += formLink;
                }
            });
            html += '</div>';
            html += '<div class="mm-item-detail">Login: <span class="mm-login-copy" style="cursor:pointer;border-bottom:1px dashed #94a3b8;" title="Click to copy">' + h(m.login) + '</span>' + (m.shift ? ' \u2022 ' + h(m.shift) : '') + '</div>';
        }
        html += '</div>';
        return html;
    }

    function buildRecentlyCompletedHTML() {
        var completed = JSON.parse(GM_getValue('elevateCompleted', '{}'));
        var keys = Object.keys(completed);
        if (keys.length === 0) return '';
        keys.sort(function(a, b) { return (completed[b].timestamp || 0) - (completed[a].timestamp || 0); });
        var html = '<div style="margin:12px 14px 8px;"><button id="mm-toggle-completed" style="background:none;border:none;color:#94a3b8;font-size:10px;cursor:pointer;padding:2px 0;font-weight:600;">' + (recentOpen ? '\u25BC' : '\u25B6') + ' Recently Completed (' + keys.length + ')</button></div>';
        html += '<div id="mm-completed-section" style="display:' + (recentOpen ? '' : 'none') + ';padding:0 14px 14px;">';
        keys.forEach(function(k) {
            var parts = k.split('|');
            var cLogin = parts[0];
            var cMetric = stripDate(parts.slice(1).join('|'));   // drop the trailing |DATE
            var cVal = completed[k];
            var cBy = cVal.completedBy || 'unknown';
            var cAgo = cVal.timestamp ? Math.round((Date.now() - cVal.timestamp) / 60000) : 0;
            var cAgoStr = cAgo < 60 ? cAgo + 'min ago' : Math.round(cAgo / 60) + 'h ago';
            html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;margin-bottom:4px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">';
            html += '<div style="flex:1;"><span style="font-weight:700;font-size:12px;color:#166534;">' + h(cLogin) + '</span> <span style="font-size:11px;color:#475569;">\u2022 ' + h(cMetric) + '</span><div style="font-size:10px;color:#94a3b8;margin-top:2px;">\u2705 Completed ' + cAgoStr + ' by <strong style="color:#1e293b;">' + h(cBy) + '</strong></div></div>';
            html += '<button class="mm-uncomplete-btn" data-login="' + h(cLogin) + '" data-metric="' + h(cMetric) + '" style="background:#dc2626;color:#fff;border:none;border-radius:6px;padding:5px 10px;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;transition:background 0.15s;" title="Restore this item so it shows up for everyone again">\u21A9 Mark Not Completed</button>';
            html += '</div>';
        });
        html += '</div>';
        return html;
    }

    function updatePanel() {
        var content = document.getElementById('mm-content');
        if (!content) return;
        // Preserve search focus/caret across re-renders (don't steal focus otherwise).
        var prevSearch = document.getElementById('mm-search');
        var searchHadFocus = prevSearch && document.activeElement === prevSearch;

        var html = buildDashboardHTML() + buildStatusHTML();

        if (currentMatches.length === 0) {
            var coachingCount = Object.keys(elevateByLogin).length + Object.keys(positiveByLogin).length;
            if (onSiteCount > 0) {
                html += '<div class="mm-allclear">\u2705 ' + onSiteCount + ' on site \u00b7 ' + coachingCount + ' associates have coachings. No on-site overlap with pending coachings right now.</div>';
            } else {
                html += '<div class="ct-loading">\u23F3 On-site roster not loaded yet.<br>on-site: ' + onSiteCount + ' \u00b7 coachings(FB): ' + coachingCount + ' \u00b7 siteId: ' + (fpSiteId ? '\u2713' : 'not captured') + '<br><span style="font-size:10px;color:#94a3b8;">Open the Find People page once so the site ID is captured. Keep the QuickSight coaching tab open so coachings sync.</span></div>';
            }
            content.innerHTML = html;
            applyDropState();
            attachStatusHandlers();
            return;
        }

        var typeCounts = {};
        currentMatches.forEach(function(m) { m.alerts.forEach(function(a) { typeCounts[a.type] = (typeCounts[a.type] || 0) + 1; }); });

        var lastSyncTs = GM_getValue('elevateTimestamp', 0);
        var lastSyncStr = lastSyncTs ? new Date(lastSyncTs).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) : 'never';
        html += '<div style="text-align:right;margin:0 14px 8px;font-size:9px;color:#94a3b8;">Last synced: ' + lastSyncStr + '</div>';
        html += buildFilterBarHTML(typeCounts);

        function opt(v, label) { return '<option value="' + v + '"' + (activeSort === v ? ' selected' : '') + '>' + label + '</option>'; }
        html += '<div style="padding:4px 14px;display:flex;gap:8px;align-items:center;">'
            + '<input id="mm-search" type="text" placeholder="\uD83D\uDD0D Search by name or login..." style="flex:1;padding:6px 10px;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;box-sizing:border-box;" value="' + h(activeSearch) + '">'
            + '<select id="mm-sort" style="padding:4px 6px;border:1px solid #e2e8f0;border-radius:6px;font-size:10px;font-weight:600;color:#475569;">'
            + opt('count', 'Sort: Coaching Count') + opt('name', 'Sort: Name A-Z') + opt('errors', 'Sort: Error Count') + opt('metric', 'Sort: Metric Type')
            + '</select></div>';

        html += '<div class="mm-list">' + applyFilters().map(buildMatchCardHTML).join('') + '</div>';
        html += buildRecentlyCompletedHTML();

        content.innerHTML = html;
        applyDropState();
        attachStatusHandlers();

        // Click-to-copy login
        content.querySelectorAll('.mm-login-copy').forEach(function(span) {
            span.addEventListener('click', function(e) {
                e.stopPropagation();
                var orig = span.textContent.trim();
                navigator.clipboard.writeText(orig);
                span.textContent = '\u2713 Copied';
                span.style.color = '#067D62';
                setTimeout(function() { span.textContent = orig; span.style.color = ''; }, 800);
            });
        });

        // Search + sort
        var searchInput = document.getElementById('mm-search');
        if (searchInput) {
            searchInput.addEventListener('input', function() { activeSearch = this.value; updatePanel(); });
            if (searchHadFocus) {
                searchInput.focus();
                searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
            }
        }
        var sortSelect = document.getElementById('mm-sort');
        if (sortSelect) sortSelect.addEventListener('change', function() { activeSort = this.value; updatePanel(); });

        // Recently Completed toggle + Mark Not Completed
        var toggleCompleted = document.getElementById('mm-toggle-completed');
        if (toggleCompleted) toggleCompleted.addEventListener('click', function() { recentOpen = !recentOpen; updatePanel(); });
        content.querySelectorAll('.mm-uncomplete-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                btn.textContent = '\u21A9 Restoring...';
                btn.disabled = true;
                btn.style.background = '#94a3b8';
                markNotCompleted(btn.dataset.login, btn.dataset.metric);
            });
        });

        // Error details buttons
        content.querySelectorAll('.mm-err-btn[data-err-login]').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                showErrDetailsPopup(btn.dataset.errLogin, btn.dataset.errName, btn);
            });
        });

        // Open Form links (first click opens + marks pending; second click confirms submission)
        content.querySelectorAll('.mm-elevate-link').forEach(function(link) {
            var login = link.dataset.login, metric = link.dataset.metric, url = link.dataset.url;
            var undoBtn = null;
            function normalLook() {
                link.style.color = '#dc2626';
                link.textContent = 'Open Form';
                if (undoBtn) { undoBtn.remove(); undoBtn = null; }
            }
            function pendingLook() {
                link.style.color = '#f59e0b';
                link.textContent = '\u2705 Mark Submitted';
                if (undoBtn) return;
                // Inline "cancel" — clears the pending state without logging anything.
                undoBtn = document.createElement('span');
                undoBtn.textContent = '\u21A9 Mark Not Completed';
                undoBtn.style.cssText = 'display:inline-block;font-size:10px;color:#fff;background:#dc2626;padding:2px 8px;border-radius:6px;cursor:pointer;margin-left:6px;font-weight:600;transition:background 0.15s;';
                undoBtn.title = 'Cancel submission \u2014 restore this item';
                undoBtn.addEventListener('mouseenter', function() { undoBtn.style.background = '#b91c1c'; });
                undoBtn.addEventListener('mouseleave', function() { undoBtn.style.background = '#dc2626'; });
                undoBtn.addEventListener('click', function(ev) {
                    ev.stopPropagation(); ev.preventDefault();
                    clearPending(login, metric);
                    normalLook();
                });
                link.parentNode.insertBefore(undoBtn, link.nextSibling);
            }
            link.addEventListener('click', function(e) {
                e.preventDefault();
                handleFormClick(login, metric, url, pendingLook, normalLook);
            });
            if (isPending(login, metric)) pendingLook();
        });
    }

    // Site / leader controls in the status line.
    function attachStatusHandlers() {
        var siteChange = document.getElementById('mm-site-change');
        if (siteChange) siteChange.addEventListener('click', function() {
            var code = prompt('Enter site code (e.g., UNJ2, UFL6):', ELEVATE_SITE_CODE);
            if (code && code.trim().length >= 3) {
                code = code.trim().toUpperCase();
                GM_setValue('elevate_site_code', code);
                ELEVATE_SITE_CODE = code;
                console.log('[CoachTracker] Site changed to: ' + code);
                pullElevateFromFirebase();
                updatePanel();
            }
        });
        var toggleLeader = function() {
            var sec = document.getElementById('mm-leader-section');
            if (sec) sec.style.display = sec.style.display === 'none' ? 'block' : 'none';
        };
        var leaderSetBtn = document.getElementById('mm-leader-set');
        var leaderChangeBtn = document.getElementById('mm-leader-change');
        if (leaderSetBtn) leaderSetBtn.addEventListener('click', toggleLeader);
        if (leaderChangeBtn) leaderChangeBtn.addEventListener('click', toggleLeader);
        var leaderSaveBtn = document.getElementById('mm-leader-save');
        if (leaderSaveBtn) leaderSaveBtn.addEventListener('click', function() {
            var inp = document.getElementById('mm-leader-input');
            var val = inp ? inp.value.trim().toLowerCase() : '';
            if (!val || val.length < 3) { alert('Please enter a valid login (at least 3 characters)'); return; }
            GM_setValue('leader_login', val);
            leaderSaveBtn.textContent = '\u2705 Saved!';
            setTimeout(function() { updatePanel(); }, 800);
        });
    }

    // In-panel confirm (no native confirm(), so there's no "don't ask again" escape).
    function ctConfirm(title, message, confirmLabel, onConfirm) {
        var old = document.getElementById('ct-confirm-overlay'); if (old) old.remove();
        var ov = document.createElement('div'); ov.id = 'ct-confirm-overlay';
        ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(15,37,64,0.45);display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,0.35);max-width:340px;width:90%;padding:18px 20px;font:400 13px -apple-system,Segoe UI,sans-serif;color:#1e293b;';
        var cancelBtn = onConfirm ? '<button id="ct-cf-cancel" style="background:#e2e8f0;color:#334155;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:12px;cursor:pointer;">Cancel</button>' : '';
        box.innerHTML = '<div style="font-weight:800;font-size:14px;margin-bottom:8px;color:#b91c1c;">\uD83D\uDEA8 ' + title + '</div>'
            + '<div style="font-size:12px;line-height:1.5;margin-bottom:16px;color:#334155;">' + message + '</div>'
            + '<div style="display:flex;gap:8px;justify-content:flex-end;">' + cancelBtn
            + '<button id="ct-cf-ok" style="background:#dc2626;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:800;font-size:12px;cursor:pointer;">' + (confirmLabel || 'OK') + '</button></div>';
        ov.appendChild(box); document.body.appendChild(ov);
        function closeOv(){ ov.remove(); }
        box.querySelector('#ct-cf-ok').addEventListener('click', function(){ closeOv(); if (onConfirm) onConfirm(); });
        var cb = box.querySelector('#ct-cf-cancel'); if (cb) cb.addEventListener('click', closeOv);
        ov.addEventListener('click', function(e){ if (e.target === ov) closeOv(); });
    }

    // ============================================================
    // === FIND PEOPLE — LIVE ON-SITE SOURCE ======================
    // ============================================================
    //   GET https://na.store-management.f3.amazon.dev/api/v1/labortracking/findpeople/{siteId}
    //   -> { associates: [ { associateId, function, zone, lastLocation, ... } ] }
    // associateId = login. The {siteId} is captured once from the Find People page.
    var FP_API_BASE = 'https://na.store-management.f3.amazon.dev/api/v1/labortracking/findpeople/';
    // Known site IDs so a site works without the one-time Find People visit.
    var FP_KNOWN_SITE_IDS = { 'UNJ2': '35fbfe04-3056-42e2-b717-e414a5655105' };
    var fpSiteId = GM_getValue('fp_site_id', '') || (FP_KNOWN_SITE_IDS[GM_getValue('elevate_site_code', '') || ''] || '');
    var onSiteLogins = {};   // login -> true (currently on site)
    var onSiteCount = 0;
    var FP_SITE_RE = /\/labortracking\/findpeople\/([0-9a-f-]{36})/i;

    function fpSaveSiteId(id, how) {
        if (id && id !== fpSiteId) {
            fpSiteId = id;
            GM_setValue('fp_site_id', fpSiteId);
            console.log('[CoachTracker][FP] siteId ' + how + ': ' + fpSiteId);
        }
    }

    // Recover the siteId even if the page's API call fired before our fetch hook installed.
    function fpRecoverSiteIdFromPerf() {
        try {
            var entries = (performance.getEntriesByType ? performance.getEntriesByType('resource') : []) || [];
            for (var i = entries.length - 1; i >= 0; i--) {
                var m = (entries[i].name || '').match(FP_SITE_RE);
                if (m && m[1]) { fpSaveSiteId(m[1], 'recovered from perf'); break; }
            }
        } catch(e) {}
        return fpSiteId;
    }

    function fpInterceptSiteId() {
        fpRecoverSiteIdFromPerf();
        var origFetch = window.fetch;
        window.fetch = function() {
            var args = arguments;
            var url = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url) || '';
            var m = url.match(FP_SITE_RE);
            if (m && m[1]) fpSaveSiteId(m[1], 'captured');
            return origFetch.apply(this, args);
        };
    }

    function fpApplyRoster(j) {
        var arr = j && j.associates ? j.associates : (Array.isArray(j) ? j : null);
        if (!arr) return;
        var next = {};
        arr.forEach(function(p){ var id = (p.associateId || '').trim().toLowerCase(); if (id) next[id] = true; });
        onSiteLogins = next;
        onSiteCount = Object.keys(next).length;
        console.log('[CoachTracker][FP] on-site roster: ' + onSiteCount + ' associates');
        matchAndAlert();
    }

    function fpFetchRoster() {
        if (!fpSiteId) { console.warn('[CoachTracker][FP] no siteId yet'); return; }
        GM_xmlhttpRequest({
            method: 'GET', url: FP_API_BASE + fpSiteId, withCredentials: true, timeout: 15000,
            onload: function(r){
                if (r.status >= 200 && r.status < 300) {
                    try { fpApplyRoster(JSON.parse(r.responseText)); }
                    catch(e){ console.error('[CoachTracker][FP] roster JSON parse failed: ' + (e && e.message)); }
                } else {
                    console.warn('[CoachTracker][FP] roster HTTP ' + r.status + ' (auth? try opening Find People once)');
                }
            },
            onerror: function(err){ console.error('[CoachTracker][FP] roster fetch blocked (cross-domain/@connect?): ' + JSON.stringify(err).slice(0,120)); },
            ontimeout: function(){ console.warn('[CoachTracker][FP] roster fetch timeout'); }
        });
    }

    // ============================================================
    // === QUICKSIGHT AUTO-SCRAPE =================================
    // ============================================================
    // The Elevate coaching table is VIRTUALIZED (~20 rows in the DOM at once), so we wheel-scroll
    // the grid top->bottom collecting + deduping rows, serialize to CSV, and feed parseElevateCSV().
    // One leader keeping the QuickSight tab open keeps everyone current via Firebase.

    function isCoachLink(a) { return /coaching link/i.test(a.textContent || '') && (a.href || '').indexOf('=') !== -1; }
    function coachLinks() { return [].slice.call(document.querySelectorAll('a')).filter(isCoachLink); }

    // The table's scroll container is '.fixed-grid-wrapper' (confirmed 2026-09-25).
    function qsFindGrid() {
        function hasCoachLinks(el){ return [].slice.call(el.querySelectorAll('a')).some(function(a){ return /coaching link/i.test(a.textContent || ''); }); }
        var wrappers = [].slice.call(document.querySelectorAll('.fixed-grid-wrapper'))
            .filter(function(el){ return el.scrollHeight > el.clientHeight + 30 && hasCoachLinks(el); });
        if (wrappers.length) {
            wrappers.sort(function(a, b){ return b.scrollHeight - a.scrollHeight; });
            return wrappers[0];
        }
        // Fallback: nearest scrollable ancestor of a coaching link.
        var link = coachLinks()[0];
        if (link) {
            var el = link.parentElement;
            for (var i = 0; i < 12 && el; i++) {
                if (el.scrollHeight > el.clientHeight + 30) return el;
                el = el.parentElement;
            }
        }
        return null;
    }

    // Site code pattern (UNJ2, UFL6, UGA2, ...)
    var SITE_CODE_RE = /^[A-Z]{3}\d$|^[A-Z]{2}\d{2}$|^[A-Z]{4}$/;
    var DATE_LABEL_RE = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/;
    var qsSiteTally = {}; // site code -> count, to auto-detect the dominant site

    // Read the currently-rendered rows. Each row is anchored on its "Coaching Link" <a> (carries
    // the login); cells come from a <tr> ancestor or the surrounding role=button stream.
    // Column offsets relative to the Associate ID cell (== login), confirmed live:
    //   Metric(-2) | Form URL(-1) | ASSOCIATE ID(0) | Full Name(+1) | Assoc Type(+2) | LC Level(+3) |
    //   Today's Shift(+4) | Next Shift Date(+5) | Next Shift Sched(+6) | Pre Week Total(+7) |
    //   Coaching Time(+8) | Submitted By(+9)
    function qsCollectVisibleRows(store) {
        function cellText(el){ return (el.textContent || '').trim(); }
        function looksLikeName(v){
            v = (v || '').trim();
            return !!v && /[A-Za-z]/.test(v) && !/^coaching/i.test(v) && !SITE_CODE_RE.test(v)
                && !/^\d/.test(v) && !/\d{2}:\d{2}/.test(v) && !/^(FIXED|FLEX)$/i.test(v)
                && !/^(Veteran|LC\d|Positive Reinforcement|Item Quality|Missing Items|Learning Curve|IB Receive|First Pass|False Pick|Combined Cycle|Produce)/i.test(v);
        }
        coachLinks().forEach(function(a) {
            var href = a.href || '';
            var login = decodeURIComponent(href.substring(href.lastIndexOf('=') + 1)).trim().toLowerCase();
            if (!login) return;

            var cells = [];
            var tr = a.closest('tr');
            if (tr) {
                cells = [].slice.call(tr.querySelectorAll('td, th')).map(cellText);
            } else {
                var rowEl = a.parentElement;
                for (var up = 0; up < 4 && rowEl && rowEl.querySelectorAll('[role="button"]').length < 3; up++) rowEl = rowEl.parentElement;
                if (rowEl) cells = [].slice.call(rowEl.querySelectorAll('[role="button"]')).map(cellText);
            }
            if (!cells.length) {
                var k0 = login + '|';
                if (!store[k0]) store[k0] = { login: login, name: '', metric: '', form: href, submitted: '', shift: '', week: '' };
                return;
            }

            var metric = '', fullName = '', todayShift = '', rowSite = '', rowWeek = '';
            for (var c = 0; c < cells.length; c++) {
                var t = cells[c];
                if (!t) continue;
                if (!rowSite && SITE_CODE_RE.test(t)) { rowSite = t.toUpperCase(); continue; }
                if (!rowWeek && DATE_LABEL_RE.test(t)) { rowWeek = t; continue; }
                if (!metric && /Cycle Time|Pick Skip|Pass Yield|Receive|Item Quality|Missing Items|Learning Curve|Produce|Shrink|Positive/i.test(t)) { metric = t; continue; }
            }

            var li = -1;
            for (var i = 0; i < cells.length; i++) { if ((cells[i] || '').trim().toLowerCase() === login) { li = i; break; } }

            // Position fallback for metrics not in the keyword list: Metric is 2 cells before login.
            if (!metric && li >= 2) {
                var cand = (cells[li - 2] || '').trim();
                if (cand && /[A-Za-z]/.test(cand) && !SITE_CODE_RE.test(cand) && !/^\d/.test(cand)
                    && !/\d{2}:\d{2}/.test(cand) && !DATE_LABEL_RE.test(cand)) { metric = cand; }
            }

            // Name anchored to THIS row's login cell (+1 first, then -1). Prefer "Last, First".
            if (li !== -1) {
                var adj = [cells[li + 1], cells[li - 1]];
                for (var ai = 0; ai < adj.length && !fullName; ai++) {
                    var nc = (adj[ai] || '').trim();
                    if (/^[A-Za-z][A-Za-z .'\-]*,\s*[A-Za-z]/.test(nc)) fullName = nc;
                }
                for (var ai2 = 0; ai2 < adj.length && !fullName; ai2++) {
                    if (looksLikeName(adj[ai2])) fullName = (adj[ai2] || '').trim();
                }
            }

            // Today's Shift: first time-range cell like "18:00:00-23:00:00"
            for (var c3 = 0; c3 < cells.length; c3++) { if (/\d{2}:\d{2}:\d{2}\s*-\s*\d{2}:\d{2}:\d{2}/.test(cells[c3])) { todayShift = cells[c3]; break; } }

            // Coaching Time (+8) and Submitted By (+9)
            var submittedBy = '', coachingTime = '';
            if (li !== -1) {
                var ct = (cells[li + 8] || '').trim();
                var sb = (cells[li + 9] || '').trim();
                if (/^\d{4}-\d{2}-\d{2}/.test(ct)) coachingTime = ct.slice(0, 10);
                else if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(ct)) coachingTime = ct;
                if (/^[a-z][a-z0-9]{2,9}$/i.test(sb) && !/^(fixed|flex)$/i.test(sb)) submittedBy = sb.toLowerCase();
            }

            if (rowSite) qsSiteTally[rowSite] = (qsSiteTally[rowSite] || 0) + 1;
            var key = login + '|' + metric;
            var r = store[key];
            if (!r) {
                store[key] = { login: login, name: fullName, metric: metric, form: href, submitted: submittedBy, coachTime: coachingTime, shift: todayShift, week: rowWeek };
            } else {
                if (todayShift && !r.shift) r.shift = todayShift;
                if (fullName && !r.name) r.name = fullName;
                if (submittedBy && !r.submitted) r.submitted = submittedBy;
                if (coachingTime && !r.coachTime) r.coachTime = coachingTime;
            }
        });
        return store;
    }

    // Serialize scraped rows to the CSV header parseElevateCSV expects.
    function qsRowsToCSV(store) {
        function esc(v){ v = (v == null ? '' : String(v)); var needQ = /[,"\n]/.test(v); return needQ ? '"' + v.split('"').join('""') + '"' : v; }
        var out = ['Associate ID,Full Name,Metric Name,Submitted By,Form URL,Pre Num,Today Shift,Pre Week Begin,Coaching Time'];
        Object.keys(store).forEach(function(k){
            var r = store[k];
            out.push([esc(r.login), esc(r.name), esc(r.metric), esc(r.submitted), esc(r.form), '1', esc(r.shift || ''), esc(r.week || ''), esc(r.coachTime || '')].join(','));
        });
        return out.join('\n');
    }

    // Silent by default: progress goes to the console; only errors (ok === false) show a
    // small dismissible chip so a broken scrape is never silent.
    function qsStatus(msg, ok) {
        console.log('[CoachTracker][QS] ' + msg);
        var chip = document.getElementById('ct-qs-status');
        if (ok !== false) { if (chip) chip.remove(); return; }
        if (!chip) {
            chip = document.createElement('div');
            chip.id = 'ct-qs-status';
            chip.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:2147483647;background:#7f1d1d;color:#fff;font:600 11px -apple-system,Segoe UI,sans-serif;padding:7px 12px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,0.3);max-width:280px;cursor:pointer;border-left:3px solid #dc2626;';
            chip.title = 'Click to dismiss';
            chip.addEventListener('click', function(){ chip.remove(); });
            document.body.appendChild(chip);
        }
        chip.textContent = '\u26A0\uFE0F Coaching Tracker: ' + msg;
    }

    // Click any "New data present" prompts so the visual renders latest rows before scraping.
    function qsDismissNewData() {
        [].slice.call(document.querySelectorAll('[role="button"], div, span'))
            .filter(function(e){ return /new data present/i.test(e.textContent || '') && e.children.length <= 2; })
            .forEach(function(p){ try { p.click(); } catch(e) {} });
    }

    var qsScrapeRunning = false;
    function qsScrape(done, attempt) {
        if (qsScrapeRunning) { if (done) done(0); return; }
        attempt = attempt || 0;
        qsDismissNewData();
        var grid = qsFindGrid();
        if (!grid && coachLinks().length === 0) {
            if (attempt < 10) {
                qsStatus('waiting for coaching table\u2026 (' + (attempt + 1) + ')');
                setTimeout(function(){ qsScrape(done, attempt + 1); }, 3000);
            } else {
                qsStatus('coaching table not found \u2014 open the Associate Coaching tab', false);
                if (done) done(0);
            }
            return;
        }
        qsScrapeRunning = true;
        qsStatus('scanning\u2026');
        var store = {};
        // QuickSight's virtualizer listens for real WHEEL events (programmatic scrollTop alone
        // doesn't advance it). Re-read scrollHeight each pass (it grows lazily) and stop only at
        // the true bottom once the row count has been stable for 5 ticks.
        var target = grid || (document.scrollingElement || document.documentElement);
        function tHeight(){ return target.scrollHeight || 0; }
        function tClient(){ return target.clientHeight || window.innerHeight; }
        function wheelStep(dy){
            try { target.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true })); } catch(e){}
            target.scrollTop = Math.min(target.scrollTop + dy, tHeight());
        }
        var stepPx = Math.max(Math.floor(tClient() * 0.6), 120);
        var lastCount = -1, stable = 0, guard = 0;
        target.scrollTop = 0;
        qsCollectVisibleRows(store);
        function pass() {
            wheelStep(stepPx);
            setTimeout(function(){
                qsCollectVisibleRows(store);
                var count = Object.keys(store).length;
                var atBottom = (target.scrollTop + tClient()) >= (tHeight() - 6);
                stable = (count === lastCount) ? stable + 1 : 0;
                lastCount = count;
                guard++;
                if ((atBottom && stable >= 5) || guard > 400) {
                    target.scrollTop = 0;
                    try { target.dispatchEvent(new WheelEvent('wheel', { deltaY: -tHeight(), bubbles: true })); } catch(e){}
                    qsScrapeRunning = false;
                    qsPublish(store, count);
                    if (done) done(count);
                    return;
                }
                qsStatus('scanning\u2026 ' + count + ' rows');
                pass();
            }, 130);
        }
        pass();
    }

    // Scrape BOTH sheet tabs (Associate Coaching + Positive Reinforcement), then restore the
    // user's original tab, so Elevate and Positive both stay fresh.
    function qsFindTab(labelRe) {
        var els = [].slice.call(document.querySelectorAll('[role="tab"], button, a, div'));
        for (var i = 0; i < els.length; i++) {
            var t = (els[i].textContent || '').trim();
            if (t && t.length < 40 && labelRe.test(t) && els[i].offsetParent !== null) return els[i];
        }
        return null;
    }

    var qsBothRunning = false;
    function qsScrapeBothTabs(done) {
        if (qsBothRunning) { if (done) done(0); return; }
        var assocTab = qsFindTab(/^Associate Coaching$/i);
        var posTab   = qsFindTab(/^Positive Reinforcement$/i);
        if (!assocTab && !posTab) { qsScrape(function(n){ if (done) done(n); }); return; }
        qsBothRunning = true;
        var activeEl = document.querySelector('[role="tab"][aria-selected="true"]');
        var original = activeEl ? (activeEl.textContent || '').trim() : '';
        function scrapeTab(tab, label, next) {
            if (tab) { tab.click(); qsStatus('scanning ' + label + '\u2026'); }
            // let the tab render, then scrape
            setTimeout(function(){ qsScrape(function(){ next(); }); }, 2700);
        }
        scrapeTab(assocTab, 'Associate Coaching', function() {
            scrapeTab(posTab, 'Positive Reinforcement', function() {
                var back = original ? qsFindTab(new RegExp('^' + original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')) : null;
                if (back) back.click();
                qsBothRunning = false;
                if (done) done(1);
            });
        });
    }

    // Auto-detect the site from the scraped rows (dominant Site ID).
    function qsAutoDetectSite() {
        var best = '', bestN = 0;
        for (var s in qsSiteTally) { if (qsSiteTally[s] > bestN) { bestN = qsSiteTally[s]; best = s; } }
        if (best && best !== ELEVATE_SITE_CODE) {
            ELEVATE_SITE_CODE = best;
            GM_setValue('elevate_site_code', best);
            console.log('[CoachTracker][QS] Site auto-detected from dashboard: ' + best);
        }
        return ELEVATE_SITE_CODE;
    }

    // Parse scraped rows, rebuild positives, and push everything to Firebase.
    function qsPublish(store, count) {
        try {
            var site = qsAutoDetectSite();
            if (!site) { qsStatus('no site detected yet \u2014 will retry', false); return; }

            // v39.3 ONE-TIME FIREBASE WIPE per site (clears the stale pre-v39.3 shared log).
            if (!GM_getValue('fb_wipe_v39_3_' + site, false)) {
                var rid = 'reset_' + Date.now();
                GM_setValue('coachingLogResetId', rid);
                coachingLog = [];
                GM_setValue('coachingLog', JSON.stringify(coachingLog));
                GM_setValue('elevateCompleted', '{}');
                firebaseRequest('archives/coaching_log_pre_v39_3', 'PUT', { archivedAt: Date.now(), note: 'auto-archived before v39.3 wipe' }).catch(function(){});
                firebaseRequest('coaching_log', 'PUT', { log: [], timestamp: Date.now(), resetId: rid }).then(function(){
                    console.log('[CoachTracker][QS] v39.3 Firebase coaching_log WIPED for ' + site + ' (resetId ' + rid + ')');
                }).catch(function(e){ console.warn('[CoachTracker][QS] wipe failed: ' + (e && e.message)); });
                GM_setValue('fb_wipe_v39_3_' + site, true);
            }

            if (count === 0) { qsStatus('0 rows found (is the coaching table showing?)', false); return; }
            var parsed = parseElevateCSV(qsRowsToCSV(store));
            if (parsed === -1) { qsStatus('parse failed', false); return; }

            // LIVE POSITIVE REBUILD — only when this scrape captured Positive rows (Positive tab).
            var freshPos = {}, posCount = 0;
            Object.keys(store).forEach(function(k){
                var r = store[k];
                if (!/positive reinforcement/i.test(r.metric || '')) return;
                var lg = (r.login || '').trim().toLowerCase(); if (!lg) return;
                var mName = r.metric || 'Positive Reinforcement Conversation';
                if (!freshPos[lg]) freshPos[lg] = [];
                if (!freshPos[lg].some(function(e){ return e.metricName === mName; })) {
                    freshPos[lg].push({ metricName: mName, fullName: r.name || '', formURL: r.form || '', shift: r.shift || '', lastCoachingDate: r.coachTime || '' });
                    posCount++;
                }
            });
            if (posCount > 0) {
                positiveByLogin = freshPos;
                GM_setValue('positiveData', JSON.stringify(positiveByLogin));
                pushPositivesToFirebase();
                console.log('[CoachTracker][QS] LIVE positives rebuilt: ' + Object.keys(freshPos).length + ' AAs (' + posCount + ' rows)');
            }

            qsStatus(count + ' rows \u2014 syncing to ' + site + '\u2026');
            var when = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
            pushElevateToFirebase(true).then(function(ok){
                qsStatus(ok ? ('v' + SCRIPT_VERSION + ' \u00b7 ' + count + ' rows synced \u2713 ' + when) : (count + ' scraped \u2014 Firebase BLOCKED (allow connection?)'), ok);
            }).catch(function(){ qsStatus(count + ' scraped \u2014 Firebase error', false); });
            pushCoachingLogToFirebase();
        } catch (e) { qsStatus('error: ' + (e && e.message), false); }
    }

    // ============================================================
    // === LIVE CLAIMS ("in progress by X") =======================
    // ============================================================
    // Keyed by login|metric in Firebase /claims; auto-expire after 30 min. Completion clears it.
    var CLAIM_TTL_MS = 30 * 60 * 1000;
    var claims = {}; // key -> { by, ts }
    function claimKey(login, metric) { return (login || '').toLowerCase() + '|' + (metric || ''); }
    function claimIsActive(c) { return c && c.by && (Date.now() - (c.ts || 0) < CLAIM_TTL_MS); }
    function getActiveClaim(login, metric) {
        var c = claims[claimKey(login, metric)];
        return claimIsActive(c) ? c : null;
    }

    async function pullClaims() {
        try {
            var payload = await firebaseRequest('claims', 'GET');
            var next = {};
            if (payload && typeof payload === 'object') {
                Object.keys(payload).forEach(function(k){ if (claimIsActive(payload[k])) next[k] = payload[k]; });
            }
            claims = next;
            updatePanel();
        } catch (e) { /* offline: keep local claims */ }
    }

    function setClaim(login, metric) {
        var leader = getLeaderLogin();
        if (!leader) return;
        var key = claimKey(login, metric);
        claims[key] = { by: leader, ts: Date.now() };
        firebaseRequest('claims/' + encodeURIComponent(key), 'PUT', { by: leader, ts: Date.now() }).catch(function(){});
        updatePanel();
    }

    function clearClaim(login, metric) {
        var key = claimKey(login, metric);
        delete claims[key];
        firebaseRequest('claims/' + encodeURIComponent(key), 'DELETE').catch(function(){});
    }

    function claimIndicatorHTML(login, metric) {
        var c = getActiveClaim(login, metric);
        if (!c) return '';
        var leader = (GM_getValue('leader_login', '') || '').toLowerCase();
        var mins = Math.max(0, Math.round((Date.now() - (c.ts || 0)) / 60000));
        var mine = (c.by || '').toLowerCase() === leader;
        var label = mine ? '\uD83D\uDD12 You (' + mins + 'm)' : '\uD83D\uDD12 ' + h(c.by) + ' (' + mins + 'm)';
        return '<span class="ct-claim' + (mine ? ' ct-claim-mine' : '') + '" title="Someone is coaching this right now (auto-expires 30m)">' + label + '</span>';
    }

    // ============================================================
    // === DASHBOARD + DROPDOWN SECTIONS ==========================
    // ============================================================
    var CATEGORY_LABEL = { ELEV: 'Elevate', POS: 'Positive' };

    function isSameLocalDay(ts, now) {
        var a = new Date(ts), b = new Date(now);
        return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    }

    // NET tool completions today (latest action wins) + same-day DASHBOARD completions
    // (Submitted By + Coaching Time == today). Matches the "Done Today (by leader)" list.
    function completedTodayCount() {
        var now = Date.now();
        function baseKey(login, metric){ return (login || '').toLowerCase() + '|' + stripDate(metric); }
        var state = {};
        coachingLog.forEach(function(e) {
            if (!e || !e.timestamp || !isSameLocalDay(e.timestamp, now)) return;
            var k = baseKey(e.login, e.metric);
            if (!state[k] || e.timestamp >= state[k].ts) state[k] = { action: e.action || 'completed', ts: e.timestamp };
        });
        var done = {};
        for (var kk in state) { if (state[kk].action === 'completed') done[kk] = true; }
        Object.keys(elevateByLogin || {}).forEach(function(login){
            (elevateByLogin[login] || []).forEach(function(a){
                if (a.submittedBy && a.coachTime && a.coachTime === todayKey()) done[baseKey(login, a.metric)] = true;
            });
        });
        return Object.keys(done).length;
    }

    // Coaching Log — tool actions only, newest first.
    function buildLogHTML() {
        if (!coachingLog || coachingLog.length === 0) return '<div class="ct-drop-empty">No coaching completions logged yet.</div>';
        var rows = '';
        var sorted = coachingLog.slice().sort(function(a, b){ return (b.timestamp || 0) - (a.timestamp || 0); });
        for (var i = 0; i < sorted.length && i < 200; i++) {
            var e = sorted[i];
            var t = e.timestamp ? new Date(e.timestamp) : null;
            var when = t ? ((t.getMonth() + 1) + '/' + t.getDate() + ' ' + t.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})) : '-';
            var isUndo = e.action !== 'completed';
            var actHtml = isUndo
                ? '<span style="color:#b91c1c;font-weight:700;font-size:9px;">\u21A9 UNDO</span>'
                : '<span style="color:#166534;font-weight:700;font-size:9px;">\u2705 DONE</span>';
            rows += '<tr' + (isUndo ? ' style="background:#fef2f2;"' : '') + '><td>' + h(e.login || '-') + '</td><td>' + h(stripDate(e.metric) || '-') + '</td><td>' + h(e.completedBy || '?') + '</td><td>' + when + '</td><td>' + actHtml + '</td></tr>';
        }
        return '<div style="font-size:9px;color:#64748b;padding:2px 4px 6px;">Full audit trail \u2014 all leaders, newest first. \u2705 DONE / \u21A9 UNDO.</div>'
             + '<table class="ct-drop-table"><thead><tr><th>Assoc</th><th>Metric</th><th>By</th><th>When</th><th>Action</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function buildSummaryHTML() {
        var t = computeLeaderTotals();
        if (t.leaders.length === 0) return '<div class="ct-drop-empty">No leader completions yet.</div>';
        var rows = t.leaders.map(function(l){ return '<tr><td><b>' + h(l) + '</b></td><td>' + t.totals[l] + '</td></tr>'; }).join('');
        return '<table class="ct-drop-table"><thead><tr><th>Leader</th><th>Completed</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    function buildHideTypesHTML() {
        var elevHidden = hiddenTypes.indexOf('ELEV') >= 0;
        var posHidden = hiddenTypes.indexOf('POS') >= 0;
        return '<div class="ct-hide-row">'
            + '<span class="ct-hide-toggle" data-hidetype="ELEV" style="background:' + (elevHidden ? '#cbd5e1' : '#E74C3C') + ';">' + (elevHidden ? '\uD83D\uDEAB' : '\u2705') + ' Elevate</span>'
            + '<span class="ct-hide-toggle" data-hidetype="POS" style="background:' + (posHidden ? '#cbd5e1' : '#10B981') + ';">' + (posHidden ? '\uD83D\uDEAB' : '\u2705') + ' Positive</span>'
            + '</div>';
    }

    // Done Today — merges (1) tool completions today (undoable) and (2) dashboard completions
    // (Submitted By + Coaching Time == today, read-only). Deduped by login|metric.
    function buildCompletedHTML() {
        var todayStart = new Date(); todayStart.setHours(0,0,0,0); var todayMs = todayStart.getTime();
        var completed = JSON.parse(GM_getValue('elevateCompleted', '{}'));
        var rows = [], seen = {};
        Object.keys(completed).forEach(function(k){
            if ((completed[k].timestamp || 0) < todayMs) return;
            var parts = k.split('|');
            var login = parts[0];
            var metric = stripDate(parts.slice(1).join('|'));
            var pk = login + '|' + metric;
            if (seen[pk]) return;
            seen[pk] = true;
            rows.push({ login: login, metric: metric, by: completed[k].completedBy || 'unknown', ts: completed[k].timestamp || 0, source: 'tool' });
        });
        Object.keys(elevateByLogin || {}).forEach(function(login){
            (elevateByLogin[login] || []).forEach(function(a){
                if (a.submittedBy && a.coachTime && a.coachTime === todayKey()) {
                    var pk = login + '|' + (a.metric || '');
                    if (seen[pk]) return;
                    seen[pk] = true;
                    rows.push({ login: login, metric: a.metric || '', by: a.submittedBy, ts: 0, source: 'dashboard' });
                }
            });
        });
        if (rows.length === 0) return '<div class="ct-drop-empty">No coachings completed today yet.</div>';
        rows.sort(function(a, b){ return (b.ts || 0) - (a.ts || 0); });

        var tally = {};
        rows.forEach(function(r){ var by = r.by || 'unknown'; tally[by] = (tally[by] || 0) + 1; });
        var tallyRow = Object.keys(tally).sort(function(a, b){ return tally[b] - tally[a]; })
            .map(function(l){ return '<span style="display:inline-block;background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:10px;padding:1px 8px;margin:2px 3px;font-size:10px;font-weight:700;">' + h(l) + ' \u00b7 ' + tally[l] + '</span>'; }).join('');
        var header = '<div style="padding:6px 4px 8px;font-size:10px;color:#475569;"><b>' + rows.length + '</b> completed today by leader:<div style="margin-top:4px;">' + tallyRow + '</div></div>';
        var body = '';
        for (var i = 0; i < rows.length && i < 300; i++) {
            var r = rows[i];
            var tstr = r.ts ? new Date(r.ts).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}) : (r.source === 'dashboard' ? 'dashboard' : '');
            var undo = (r.source === 'tool')
                ? '<button class="ct-undo-btn" data-login="' + h(r.login) + '" data-metric="' + h(r.metric) + '" data-by="' + h(r.by) + '">\u21A9 undo</button>'
                : '<span style="font-size:9px;color:#94a3b8;">QuickSight</span>';
            body += '<tr><td>' + h(r.login) + '</td><td>' + h(r.metric) + '</td><td>' + h(r.by) + '</td><td style="color:#94a3b8;">' + tstr + '</td><td>' + undo + '</td></tr>';
        }
        return header + '<table class="ct-drop-table"><thead><tr><th>Assoc</th><th>Metric</th><th>By</th><th>Time</th><th></th></tr></thead><tbody>' + body + '</tbody></table>';
    }

    function buildDashboardHTML() {
        var needsCoaching = currentMatches.length;
        var totalPending = 0, claimedCount = 0, positiveCount = 0;
        var byMetric = {};
        currentMatches.forEach(function(m) {
            (m.alerts || []).forEach(function(a) {
                totalPending++;
                var t = a.type || 'ELEV';
                if (t === 'POS') positiveCount++;
                var mk = (a.metric || '').trim() || CATEGORY_LABEL[t] || t;
                byMetric[mk] = (byMetric[mk] || 0) + 1;
                if (getActiveClaim(m.login, a.metric)) claimedCount++;
            });
        });
        var doneToday = completedTodayCount();
        var totalTracked = doneToday + totalPending;
        var pct = totalTracked > 0 ? Math.round((doneToday / totalTracked) * 100) : 0;

        function isActive(kind, value){ return activeDashFilter && activeDashFilter.kind === kind && (value === undefined || activeDashFilter.value === value); }
        function tile(kind, label, val, bg, sub){
            return '<button class="ct-tile' + (isActive(kind) ? ' ct-tile-active' : '') + '" data-filter="' + kind + '" style="background:' + bg + ';"><div class="ct-tile-n">' + val + '</div><div class="ct-tile-l">' + label + '</div>' + (sub ? '<div class="ct-tile-sub">' + sub + '</div>' : '') + '</button>';
        }

        var html = '<div id="ct-dashboard">';
        html += '<div class="ct-tiles">'
            + tile('all', 'On-Site', onSiteCount, '#1e3a5f', '(Clocked In)')
            + tile('pending', 'AAs to Coach', needsCoaching, '#7c2d2d', totalPending + ' coachings')
            + tile('inprogress', 'In Progress', claimedCount, '#5b3a7c')
            + '</div>';
        html += '<div class="ct-tiles">'
            + tile('positive', '\u2b50 Positive', positiveCount, '#8a5a00', '(On-Site)')
            + tile('done', 'Done', doneToday, '#1f5c3a', '(Today)')
            + '</div>';
        html += '<div class="ct-prog-wrap"><div class="ct-prog-label">Coached today vs. remaining &mdash; ' + doneToday + ' / ' + totalTracked + ' (' + pct + '%)</div>'
             +  '<div class="ct-prog-track"><div class="ct-prog-fill" style="width:' + pct + '%;"></div></div></div>';

        var metKeys = Object.keys(byMetric).sort(function(a, b){ return byMetric[b] - byMetric[a]; });
        if (metKeys.length) {
            html += '<div class="ct-break"><div class="ct-break-h">Filter by metric</div><div class="ct-break-row">';
            metKeys.forEach(function(k){
                html += '<button class="ct-pill ct-pill-metric' + (isActive('metric', k) ? ' ct-pill-active' : '') + '" data-filter="metric" data-value="' + h(k) + '">' + h(k) + ' <b>' + byMetric[k] + '</b></button>';
            });
            html += '</div></div>';
        }

        if (activeDashFilter && activeDashFilter.kind !== 'all') {
            var labels = { pending: 'Pending', inprogress: 'In progress', positive: 'Positive', done: 'Done today' };
            var lbl = activeDashFilter.kind === 'metric' ? activeDashFilter.value : (labels[activeDashFilter.kind] || activeDashFilter.kind);
            html += '<div class="ct-activefilter">Showing: <b>' + h(lbl) + '</b> <button class="ct-clearfilter" data-filter="all">\u2715 clear</button></div>';
        }
        html += '</div>';
        return html;
    }

    // ============================================================
    // === INIT ===================================================
    // ============================================================
    // QuickSight is the single home (panel + scrape). Find People only donates its site ID.
    var IS_QUICKSIGHT = /quicksight\.aws\.amazon\.com$/.test(location.hostname);
    var IS_FINDPEOPLE = /store-management\.[a-z0-9.]*amazon\.dev$/.test(location.hostname);

    if (IS_FINDPEOPLE) {
        console.log('%c[CoachTracker] v' + SCRIPT_VERSION + ' FIND PEOPLE \u2014 capturing site ID for QuickSight', 'background:#0f2d4a;color:#fff;padding:2px 6px;border-radius:3px;');
        fpInterceptSiteId();
        var fpTries = 0;
        var fpPoll = setInterval(function(){
            fpTries++;
            fpRecoverSiteIdFromPerf();
            if (fpSiteId) { console.log('[CoachTracker][FP] site ID saved for QuickSight: ' + fpSiteId); clearInterval(fpPoll); }
            else if (fpTries > 40) clearInterval(fpPoll);
        }, 3000);
        return;
    }

    if (!IS_QUICKSIGHT) {
        console.log('[CoachTracker] v' + SCRIPT_VERSION + ' loaded on an unmatched host \u2014 idle.');
        return;
    }

    console.log('%c[CoachTracker] v' + SCRIPT_VERSION + ' QUICKSIGHT \u2014 coaching scrape + live Find People on-site', 'background:#0f2d4a;color:#fff;padding:2px 6px;border-radius:3px;');
    createButton();
    loadElevateCache();
    loadCoachingLogCache();

    // Site code is normally auto-detected from the scrape; only prompt if still unknown later.
    if (!ELEVATE_SITE_CODE) {
        setTimeout(function() {
            if (ELEVATE_SITE_CODE) return;
            if (getElevateSiteCode()) pullElevateFromFirebase();
        }, 60 * 1000);
    }

    // First run scrapes BOTH tabs. After that, only switch tabs when the user has been idle for
    // 60s; otherwise scrape the current tab only (no disruptive switching).
    var qsLastActivity = Date.now();
    ['mousemove','mousedown','keydown','wheel','scroll','touchstart'].forEach(function(ev){
        document.addEventListener(ev, function(e){ if (e.isTrusted) qsLastActivity = Date.now(); }, true);
    });
    var QS_IDLE_MS = 60 * 1000;
    var qsDidFirstRun = false;
    function qsKick() {
        var runBoth = !qsDidFirstRun || (Date.now() - qsLastActivity >= QS_IDLE_MS);
        qsDidFirstRun = true;
        var run = function() {
            if (runBoth) qsScrapeBothTabs(function(){ matchAndAlert(); });
            else qsScrape(function(){ matchAndAlert(); });
        };
        pullCoachingLogFromFirebase().then(run, run);
    }
    setTimeout(qsKick, 6000);
    setInterval(qsKick, 5 * 60 * 1000);

    // LIVE on-site roster from the Find People API (needs the site ID captured once).
    var rosterTries = 0;
    var rosterPoll = setInterval(function(){
        rosterTries++;
        if (!fpSiteId) fpSiteId = GM_getValue('fp_site_id', '') || (FP_KNOWN_SITE_IDS[ELEVATE_SITE_CODE || GM_getValue('elevate_site_code', '')] || '');
        if (fpSiteId) { fpFetchRoster(); if (onSiteCount > 0) clearInterval(rosterPoll); }
        if (rosterTries > 40) clearInterval(rosterPoll);
    }, 3000);
    setInterval(function(){ if (!fpSiteId) fpSiteId = GM_getValue('fp_site_id', ''); if (fpSiteId) fpFetchRoster(); }, 90 * 1000);

    setInterval(pullElevateFromFirebase, ELEVATE_SYNC_MS);
    setInterval(pullCoachingLogFromFirebase, 2 * 60 * 1000);
    setInterval(pullClaims, 45 * 1000);
    setTimeout(pullClaims, 3000);
})();
