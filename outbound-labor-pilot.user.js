// ==UserScript==
// @name         Outbound Labor Pilot - Labor Plan / Pick Ahead By Zone / Daily Totals (API)
// @namespace    http://tampermonkey.net/
// @version      1.34
// @description  Intercepts HoudiniPickCapacity API. Two tabs: Full Day Totals (all days with sold units) + Pick Ahead By Zone. Shift window now INCLUDES the anchor CPT (nights 09:15 / days 19:15); zone is DONE only when its anchor-window remaining is 0. OB Indirect splits BATCH vol (Helm) from PICK vol AUTO-PULLED from Labor Allocation get_active_plans (full 24hr array cached, resolves current hr live, cross-domain via GM storage) with manual override. Batching-done end state. Free-resize panel. Unpicked Summary shows picked + remaining cap + pick-ahead flag (Days>2 / Nights>3). Minimizable, Nights/Days toggle.
// @match        https://helm-iad.iad.proxy.amazon.com/*
// @match        https://helm-*.amazon.com/*
// @match        https://*.helm.*.amazon.com/*
// @match        https://helm.*.amazon.com/*
// @match        https://na.store-management.f3.amazon.dev/*
// @match        https://*.store-management.*.amazon.dev/*
// @match        https://api.prod.na.central-flow.gsf.a2z.com/*
// @include      https://*helm*amazon.com/*
// @include      https://*store-management*amazon.dev/*
// @run-at       document-start
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      api.prod.na.central-flow.gsf.a2z.com
// @updateURL    https://raw.githubusercontent.com/gabrerut/outbound-labor-pilot/main/outbound-labor-pilot.user.js
// @downloadURL  https://raw.githubusercontent.com/gabrerut/outbound-labor-pilot/main/outbound-labor-pilot.user.js
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
       CONFIG
       ============================================================ */
    const ZONES = ['Chilled', 'Ambient', 'Frozen', 'Bigs', 'Hv Bigs']; // display order (by typical volume)
    const ZONE_FIELD = {
        'Ambient': 'ambient',
        'Bigs':    'bigs',
        'Hv Bigs': 'hv_bigs',
        'Frozen':  'frozen',
        'Chilled': 'chilled',
    };
    const MAX_DAYS = 4; // Daily Totals shows up to 4 days (9/20+9/21+9/22 and headroom). Pick Ahead roll is UNAFFECTED — it stays single-day (9/21 only).
    const MAX_ZONE_WINDOWS = 5;  // Pick Ahead By Zone: show at most 5 current windows per zone
    const PICK_AHEAD_LIMIT  = 3; // flag picks landing more than 3 windows ahead of the earliest unfinished one
    const DEBUG = false;          // show a diagnostic readout of every date/count in the store
    // Shift is 'done' only when its ANCHOR CPT is fully picked: Nights = 09:15, Days = 19:15.
    // ============================================================
    //  REGIONAL SETTINGS (editable via the gear icon; saved to localStorage)
    //  Defaults below are UNJ2 FHN. Other sites edit these in the UI.
    // ============================================================
    const SETTINGS_DEFAULTS = {
        // Planned pack rate (UPH) per zone — drives 'pickers needed'.
        rates: { 'Chilled': 105, 'Ambient': 105, 'Frozen': 90, 'Bigs': 105, 'Hv Bigs': 105 },
        // Shift PRIMARY windows: first pick CPT (start) and anchor CPT (last pick) per shift.
        // Times are 'HH:15' CPT labels. The anchor CPT is also the shift-completion gate.
        shifts: {
            nights: { start: '19:15', anchor: '09:15' },   // Nights picks 19:15 -> 09:15
            days:   { start: '07:15', anchor: '20:15' },   // Days picks 07:15 -> 20:15
        },
        // Site time zone: null = AUTO-DETECT from the browser (v26.5). All epoch->local conversions
        // route through tzName(), which uses the browser's IANA zone when this is null.
        timezone: null,
        // OB INDIRECT planning — all divisors + batch schedule customizable per region.
        // Each function's headcount = window volume / divisor.
        obind: {
            divisors: {
                pickers:  105,   // Vol / 105 UPH
                batching: 400,   // Vol / 400
                stage:    1100,  // Vol / 1,100
                handoff:  1500,  // Vol / 1,500
                slam:     2500,  // Vol / 2,500 (Slam Standalone)
            },
            // Batch schedule: first & last CPT batched, and the batch-lead (min before CPT).
            // 'Currently batching' = the window whose deadline most recently passed within these bounds.
            firstBatchCpt: '02:15',
            lastBatchCpt:  '23:15',
            supportHrs: 1,   // Outbound Indirect Support hours (dock hero, freezer hero, etc.) — set in Settings
        },
    };
    // AUTO-DETECT the user's time zone from the browser (v26.5). No manual setting needed — the
    // site associate's machine is on site-local time. Honors a saved override if one exists (legacy),
    // else uses the browser IANA zone, falling back to Eastern only if detection fails.
    function tzName() {
        if (SETTINGS.timezone) return SETTINGS.timezone;   // legacy explicit override, if present
        try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone; if (z) return z; } catch (e) {}
        return 'America/New_York';
    }
    // ---- OB Indirect accessors + calc ----
    function obDiv(k) { const d = SETTINGS.obind && SETTINGS.obind.divisors; return (d && d[k]) || SETTINGS_DEFAULTS.obind.divisors[k]; }
    // Round-up division helper (whole headcount; 0 when no volume/divisor).
    function ceil(v, d) { return (v > 0 && d > 0) ? Math.ceil(v / d) : 0; }
    // Compute OB Indirect headcount from a volume, per function (round UP; 0 volume -> 0).
    function obindPlan(vol) {
        vol = Math.max(vol || 0, 0);
        return {
            pickers:  ceil(vol, obDiv('pickers')),
            batching: ceil(vol, obDiv('batching')),
            stage:    ceil(vol, obDiv('stage')),
            handoff:  ceil(vol, obDiv('handoff')),
            slam:     ceil(vol, obDiv('slam')),
        };
    }
    // Identify the window CURRENTLY being batched from the deadline-passed rule:
    // the in-shift window (within firstBatchCpt..lastBatchCpt) whose `deadline` most recently
    // passed (deadline <= now, latest such). Falls back to the next upcoming deadline pre-shift.
    function currentBatchWindow(rows) {
        const now = Date.now();
        const fb = cptHour(SETTINGS.obind.firstBatchCpt), lb = cptHour(SETTINGS.obind.lastBatchCpt);
        // eligible = rows with a deadline and CPT hour within [fb, lb] OR wrapping past midnight
        const eligible = rows.filter(r => typeof r.deadline === 'number' && !isNaN(r.hr));
        if (!eligible.length) return null;
        const passed = eligible.filter(r => r.deadline <= now).sort((a, b) => b.deadline - a.deadline);
        if (passed.length) return passed[0];                 // most recently passed deadline
        // none passed yet -> the soonest upcoming (about to start)
        return eligible.slice().sort((a, b) => a.deadline - b.deadline)[0];
    }
    // TRUE when the LAST batch CPT's deadline has already passed AND there are no
    // upcoming batch deadlines left -> batching is complete for the shift.
    // Drives a 'batching done' end state instead of pinning a stale last window.
    function isBatchingDone(rows) {
        const now = Date.now();
        const eligible = rows.filter(r => typeof r.deadline === 'number' && !isNaN(r.hr));
        if (!eligible.length) return false;
        const lastCpt = SETTINGS.obind.lastBatchCpt;
        const lastWins = eligible.filter(r => r.cpt === lastCpt).sort((a, b) => b.deadline - a.deadline);
        if (!lastWins.length) return false;
        const lastDeadlinePassed = lastWins[0].deadline <= now;
        const anyUpcoming = eligible.some(r => r.deadline > now);
        return lastDeadlinePassed && !anyUpcoming;
    }
    function loadSettings() {
        try {
            const v = JSON.parse(localStorage.getItem('mh_settings'));
            if (v && v.rates && v.shifts) return v;
        } catch (e) {}
        // deep clone defaults
        return JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
    }
    let SETTINGS = loadSettings();
    function saveSettings() { try { localStorage.setItem('mh_settings', JSON.stringify(SETTINGS)); } catch (e) {} }
    function resetSettings() { SETTINGS = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS)); saveSettings(); }
    // Derived accessors (used throughout) — read live from SETTINGS.
    // ANCHOR_CPT is now a getter-like object built from settings.
    function anchorCptFor(shift) { return SETTINGS.shifts[shift].anchor; }
    function startCptFor(shift) { return SETTINGS.shifts[shift].start; }
    function cptHour(cptStr) { const m = /^(\d{1,2}):/.exec(cptStr || ''); const h = m ? parseInt(m[1],10) : NaN; return (h >= 0 && h <= 23) ? h : null; }
    // Safe start/anchor HOURS with fallback to defaults if a setting is somehow invalid (never NaN).
    function startHour(shift) { const h = cptHour(startCptFor(shift)); return h == null ? cptHour(SETTINGS_DEFAULTS.shifts[shift].start) : h; }
    function anchorHour(shift) { const h = cptHour(anchorCptFor(shift)); return h == null ? cptHour(SETTINGS_DEFAULTS.shifts[shift].anchor) : h; }
    const ANCHOR_CPT = { get nights(){ return SETTINGS.shifts.nights.anchor; }, get days(){ return SETTINGS.shifts.days.anchor; } };  // last CPT each shift PICKS
    // PICKERS NEEDED: pack rate (UPH) per zone. 105 everywhere except Frozen = 90.
    // pickers = zone unpicked / packRate / runwayHours, where runwayHours = now -> anchor CPT.
    // Planned pack rate per zone — now read from editable SETTINGS.rates (falls back to 105).
    function packRate(zone) { const r = SETTINGS.rates[zone]; return (typeof r === 'number' && r > 0) ? r : 105; }
    // ROLLING HORIZON: once the shift's anchor CPT is cleared, the shift set keeps including
    // FUTURE windows that still have unpicked units (tomorrow's board), so the panel never falsely
    // reads DONE while sold work remains. (The roll is implemented inline in zoneAggAndWindows.)

    // Shift windows by CPT hour. Nights = 19:00-07:00 (wraps). Days = 07:00-19:00.
    // ET date string (YYYY-MM-DD) for an epoch-ms
    function etDate(ms) {
        return new Intl.DateTimeFormat('en-CA', { timeZone: tzName(),
            year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(ms));
    }
    // ET hour (0-23) for an epoch-ms
    function etHour(ms) {
        const s = new Intl.DateTimeFormat('en-US', { timeZone: tzName(),
            hour:'2-digit', hour12:false }).format(new Date(ms));
        return parseInt(s, 10) % 24;
    }
    // Compute the active shift window [startMs, endMs) based on 'now' and shift type.
    // Nights: anchor date D 19:00 -> D+1 07:00. Days: date D 07:00 -> D 19:00.
    // Anchor D so the window that CONTAINS now (or the most recent one) is chosen.
    function shiftWindow(shift, nowMs, isPicker) {
        const now = new Date(nowMs);
        const hr = etHour(nowMs);
        const dstr = etDate(nowMs);                 // 'YYYY-MM-DD' in ET
        const [Y, M, D] = dstr.split('-').map(Number);
        // Build an ET-anchored Date at a given local hour by using the date parts.
        // We approximate ET offset via the difference between the ms and its ET wall clock.
        function etAnchor(y, m, d, hour) {
            // Find ms such that etDate/etHour match (y-m-d hour:00 ET). Binary-free: start from UTC guess and correct.
            let guess = Date.UTC(y, m - 1, d, hour, 0, 0);
            for (let i = 0; i < 4; i++) {
                const gd = etDate(guess), gh = etHour(guess);
                const [gy, gm, gday] = gd.split('-').map(Number);
                const dayDiff = Date.UTC(y, m-1, d) - Date.UTC(gy, gm-1, gday);
                const hrDiff = hour - gh;
                guess += dayDiff + hrDiff * 3600000;
            }
            return guess;
        }
        // Shift windows INCLUDE the handoff CPTs on both ends (visibility for both shifts):
        //   Days  : 07:00 -> 19:16  (CPTs 07:15 .. 19:15; 19:15 is the Days anchor/handoff)
        //   Nights: 19:00 -> D+1 09:16 (CPTs 19:15 .. 09:15; 07:15/08:15/09:15 are the Nights tail
        //           handoff, 09:15 is the Nights anchor). 19:15 is shared with Days on purpose.
        // The tab is a MANUAL selector — Days shows the current calendar date's board no matter
        // what time you're viewing it (a nights AM checking the Days board at 04:00 wants TODAY's
        // Days windows, which just got sold, not yesterday's finished ones).
        if (shift === 'days') {
            // Days PICKS start->anchor from SETTINGS (default 07:15 -> 20:15). Window: D startHr:00
            // -> D anchorHr:16 (so the anchor CPT is included).
            // v28.6: Days ALWAYS anchors to the CURRENT CALENDAR DAY (real date), regardless of hour.
            // At 2AM on 9/19 the Days view shows 9/19's windows (not 9/18's) — matching the operational
            // model where the current day's Days board is what you plan, even overnight. (Removed the
            // old 'roll back a day before 07:15' logic that caused the off-by-a-day 0-windows bug.)
            const dStart = startHour('days');   // safe (never NaN)
            const dAnchor = anchorHour('days');
            let y=Y,m=M,d=D;
            const start = etAnchor(y,m,d,dStart);
            // If anchor hour <= start hour, the Days shift wraps past midnight -> end is NEXT day.
            let end;
            if (dAnchor > dStart) {
                end = etAnchor(y,m,d,dAnchor) + 16*60000;              // same-day anchor
            } else {
                const nd = new Date(etAnchor(y,m,d,12) + 24*3600000); const ndp = etDate(nd).split('-').map(Number);
                end = etAnchor(ndp[0],ndp[1],ndp[2],dAnchor) + 16*60000; // wraps to next day
            }
            return [start, end];
        } else {
            // Nights PICKS 19:15 -> 09:15 (batches 19:15 from 6PM; picks through 09:15).
            // Nights spans two calendar dates. The Helm picker's START date is the Nights SOS
            // (start) date, so the window is:
            //     pickerDate 19:00  ->  (pickerDate + 1) 09:16
            // In wall-clock mode we anchor off 'now': before ~09:16 we're still finishing the
            // shift that STARTED the prior evening, so roll the SOS date back one day.
            // Nights start/anchor hours from SETTINGS (default 19 / 9). The 'still finishing'
            // guard uses anchor+1 (e.g. before 10:00 = still on last night's shift).
            const nStart = startHour('nights');   // safe (never NaN)
            const nAnchor = anchorHour('nights');
            const nGuard = nAnchor + 1;                       // e.g. 10
            let sosY, sosM, sosD;   // SOS (evening) date
            // ALWAYS prefer the IN-PROGRESS shift based on the REAL clock, even in picker mode.
            // The Nights shift that's active right now started:
            //   - this evening (>= nStart hour today), OR
            //   - last evening (if we're before the nGuard tail cutoff in the early AM).
            // This prevents the picker being set a day ahead (e.g. 9/17 while working the 9/16 SOS
            // shift) from showing an empty future shift.
            {
                const realNow = Date.now();
                const rHr = etHour(realNow);
                const rToday = etDate(realNow).split('-').map(Number);
                if (rHr >= nStart) {
                    // evening/onward -> shift started TODAY (real date)
                    [sosY, sosM, sosD] = rToday;
                } else if (rHr < nGuard) {
                    // early AM before tail cutoff -> shift started YESTERDAY
                    const pv = new Date(realNow - 24*3600000);
                    [sosY, sosM, sosD] = etDate(pv).split('-').map(Number);
                } else {
                    // daytime gap (no Nights shift in progress) -> honor the picker date as SOS
                    if (isPicker) { sosY=Y; sosM=M; sosD=D; }
                    else {
                        let y=Y,m=M,d=D;
                        if (hr < nGuard) { const pv=new Date(nowMs-24*3600000); const pd=etDate(pv).split('-').map(Number); [y,m,d]=pd; }
                        sosY=y; sosM=m; sosD=d;
                    }
                }
            }
            const start = etAnchor(sosY,sosM,sosD,nStart);
            const nd = new Date(start + 24*3600000); const ndp = etDate(nd).split('-').map(Number);
            const end = etAnchor(ndp[0],ndp[1],ndp[2],nAnchor) + 16*60000;  // anchor CPT included
            return [start, end];
        }
    }

    let currentShift = 'nights';
    let activeTab = 'plan';        // 'plan' | 'zone' | 'day'
    let minimized = false;         // whole-panel minimize
    let settingsOpen = false;      // settings panel open/closed
    let summaryOpen = false;       // zone-summary snapshot open/closed
    let obindOpen = false;         // OB Indirect plan open/closed
    let infoOpen = false;          // ℹ️ How-to / instructions overlay open/closed
    // MANUAL PICK VOLUME (v25.1): pick volume comes from the Labor Allocation page
    // (na.store-management.f3.amazon.dev/laborallocation, current hour) — NOT the Helm
    // batch API. Batch vol drives Batchers; this manual pick vol drives Pickers/Stage/Handoff/Slam.
    // ---- PICK VOLUME (v28.0): AUTO-PULL from Labor Allocation get_active_plans + editable override ----
    // manualPickVol > 0 means the user typed an override (session-only, wins over the pull).
    let manualPickVol = 0;
    function obSupportHrs() { const v = SETTINGS.obind && SETTINGS.obind.supportHrs; return (typeof v === 'number' && v >= 0) ? v : SETTINGS_DEFAULTS.obind.supportHrs; }
    function saveManualPickVol(v) { manualPickVol = Math.max(parseInt(v, 10) || 0, 0); }
    // Confirmed endpoint (real URL captured 2026-09-19). Commas URL-encoded. Rolling today+2 days.
    // Endpoint candidates (v29.2): the /v1/pools/... path 404'd; the BARE path is the working one
    // (both captured from real Network traffic). Try bare first, fall back to /v1/pools/.
    const LABOR_PLAN_BASES = [
        'https://api.prod.na.central-flow.gsf.a2z.com/get_active_plans',
        'https://api.prod.na.central-flow.gsf.a2z.com/v1/pools/HoudiniPickCapacity/get_active_plans'
    ];
    // DETECTED SITE (v1.31): the true site (fc) comes from the API data's matcher (parts[0],
    // e.g. 'UNJ2' or 'UMA4'), captured on every ingest. This makes the tool follow WHATEVER site's
    // Helm data is loaded — so UMA4 (or any site) pulls its OWN labor plan, not UNJ2's. Falls back
    // to the URL's sites/ segment, then 'UNJ2' only if nothing else is known.
    let detectedSite = null;
    function siteCode() {
        if (detectedSite) return detectedSite;
        const m = location.href.match(/sites\/([^/?#]+)/);
        return (m && m[1]) ? m[1] : 'UNJ2';
    }
    function laborPlanUrl(base) {
        const site = siteCode();
        const fmt = (dt) => new Intl.DateTimeFormat('en-CA', { timeZone: tzName(), year:'numeric', month:'2-digit', day:'2-digit' }).format(dt);
        const now = Date.now();
        const dates = [0,1,2].map(n => fmt(new Date(now + n*86400000))).join(',');
        return base + '?site_code=' + encodeURIComponent(site) + '&dates=' + encodeURIComponent(dates);
    }
    // Parse get_active_plans -> { 'YYYY-MM-DD': [24 hourly outboundVolume] }.
    function parseLaborPlan(text) {
        try {
            const data = JSON.parse(text) && JSON.parse(text).data;
            if (!data) return null;
            const days = {};
            Object.keys(data).forEach(dk => {
                const pv = data[dk] && data[dk].intradayPlan && data[dk].intradayPlan.plannedValues;
                if (Array.isArray(pv)) days[dk] = pv.map(r => (r && typeof r.outboundVolume === 'number') ? Math.max(Math.round(r.outboundVolume), 0) : null);
            });
            return Object.keys(days).length ? days : null;
        } catch (e) { return null; }
    }
    // Current clock hour's planned volume from a days map.
    // Adjustable hour offset (v29.11): the plannedValues index that matches the CURRENT pick hour can
    // differ from the raw wall-clock hour by a fixed offset (batch-vs-pick timing / site setup).
    // Tune this so the pulled value matches the Labor Allocation page's current-hour Outbound Total.
    // PERIOD MODEL (v29.14): the Intraday Plan groups hours into periods P1-P6. The pick volume we want
    // is the CURRENT PERIOD's Outbound Total Volume (e.g. at 4AM you're in P2, total 17,288), NOT a
    // single hour. We sum the hourly outboundVolume across the current period's hour indices.
    //   P1 00:00-02:00 (hrs 0-1) | P2 02:00-07:00 (2-6) | P3 07:00-12:00 (7-11)
    //   P4 12:00-17:00 (12-16)  | P5 17:00-22:00 (17-21) | P6 22:00-24:00 (22-23)
    let mhPlanHr = null;   // resolved hour (for the diagnostic readout)
    // v29.16: pull the CURRENT HOUR's planned outbound volume — each hour is uniquely planned on the
    // Labor Allocation page, so we plan for the hour in progress (not the whole-period sum). The plan
    // can self-adjust to aggressive volumes, which is why manual override stays available.
    function planVolForNow(days) {
        if (!days) return null;
        const hr = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tzName(), hour:'2-digit', hour12:false }).format(new Date()), 10) % 24;
        mhPlanHr = hr;
        const dstr = new Intl.DateTimeFormat('en-CA', { timeZone: tzName(), year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
        const arr = days[dstr] || days[Object.keys(days).sort()[0]];
        const v = arr && arr[hr];
        return (typeof v === 'number' && v > 0) ? Math.round(v) : null;
    }
    // Cross-tab cache (GM storage if available, else localStorage).
    function planCacheSet(days) { const rec = JSON.stringify({ days, ts: Date.now() });
        try { if (typeof GM_setValue === 'function') { GM_setValue('mh_laborPlan', rec); return; } } catch (e) {}
        try { localStorage.setItem('mh_laborPlan', rec); } catch (e) {} }
    function planCacheGet() {
        try { if (typeof GM_getValue === 'function') { const v = GM_getValue('mh_laborPlan', null); return v ? JSON.parse(v).days : null; } } catch (e) {}
        try { const v = localStorage.getItem('mh_laborPlan'); return v ? JSON.parse(v).days : null; } catch (e) { return null; }
    }
    // FETCH the plan directly (works from Helm or the labor page — same API host, credentialed).
    function handleLaborPlanText(t) {
        const days = t && parseLaborPlan(t);
        if (days) { planCacheSet(days); scheduleRender(); }
    }
    let mhPullDiag = 'idle';   // live status of the last pull attempt (shown on OB Indirect card)
    function tryLaborBase(idx) {
        if (idx >= LABOR_PLAN_BASES.length) { mhPullDiag = 'all bases failed'; return; }
        const url = laborPlanUrl(LABOR_PLAN_BASES[idx]);
        const onGood = (text) => { const days = parseLaborPlan(text); if (days) { mhPullDiag = 'OK ' + Object.keys(days).length + 'd'; handleLaborPlanText(text); } else { tryLaborBase(idx+1); } };
        try {
            if (typeof GM_xmlhttpRequest === 'function') {
                mhPullDiag = 'GMX try#' + (idx+1);
                GM_xmlhttpRequest({
                    method: 'GET', url, withCredentials: true,
                    onload: (res) => {
                        if (res && res.status >= 200 && res.status < 300) onGood(res.responseText);
                        else { mhPullDiag = 'GMX ' + (res && res.status) + ' #' + (idx+1); tryLaborBase(idx+1); }
                    },
                    onerror: () => { mhPullDiag = 'GMX err #' + (idx+1); tryLaborBase(idx+1); },
                    ontimeout: () => { mhPullDiag = 'GMX timeout #' + (idx+1); tryLaborBase(idx+1); }
                });
                return;
            }
        } catch (e) {}
        // Fallback: same-origin fetch
        try {
            fetch(url, { credentials: 'include' })
                .then(r => r.ok ? r.text() : null)
                .then(t => { if (t) onGood(t); else tryLaborBase(idx+1); })
                .catch(() => tryLaborBase(idx+1));
        } catch (e) { tryLaborBase(idx+1); }
    }
    function fetchLaborPlan() { tryLaborBase(0); }
    // Effective pick vol: manual override wins; else the live pulled plan value; else 0.
    function effectivePickVol() {
        // v29.2: manual override wins; else the live auto-pulled plan value; else 0.
        if (manualPickVol > 0) return manualPickVol;
        const v = planVolForNow(planCacheGet());
        return (typeof v === 'number' && v > 0) ? v : 0;
    }
    let settingsTab = 'rate';      // 'rate' | 'obind'
    let latestData = null;      // most recent raw payload (kept for compatibility)
    let windowStore = new Map(); // PERSISTENT across payloads: key 'YYYY-MM-DD|CPT' -> raw window obj
    let lastUpdated = null;
    const PANEL_ID = 'mh-api-panel';

    // ---- Persistent UI state (localStorage) ----
    // Zone visibility filter: which temp zones to render (reduce clutter, show only what's relevant).
    let visibleZones = (() => {
        try { const v = JSON.parse(localStorage.getItem('mh_visibleZones')); if (Array.isArray(v) && v.length) return v; } catch (e) {}
        return ZONES.slice();   // default: all zones
    })();
    function saveVisibleZones() { try { localStorage.setItem('mh_visibleZones', JSON.stringify(visibleZones)); } catch (e) {} }
    let zoneMenuOpen = false;   // dropdown open/closed state
    // Draggable panel position (top/left in px). null = use default top-right anchor.
    let panelPos = (() => {
        try { const v = JSON.parse(localStorage.getItem('mh_panelPos')); if (v && typeof v.top === 'number') return v; } catch (e) {}
        return null;
    })();
    function savePanelPos() { try { localStorage.setItem('mh_panelPos', JSON.stringify(panelPos)); } catch (e) {} }
    // PANEL SIZE (v27.2): session-only, not persisted.
    // v27.2: panel size is SESSION-ONLY — it is NOT persisted. Every page refresh starts at
    // Normal (null). The ⤢ button cycles Normal/Large/XL within the session; a reload always
    // returns to Normal so the panel can never get stuck oversized.
    let panelZoomLevel = 0;   // 0=Original,1=Larger,2=Largest (session-only, resets on refresh)
    // Clear any size saved by older versions so a previously-stuck size doesn't linger.
    try { localStorage.removeItem('mh_panelSize'); } catch (e) {}

    // Light theme mirroring Helm's pick-capacity page row colors
    const C = {
        bg:'#ffffff', card:'#f4f5f7', head:'#0f2d4a', headTxt:'#ffffff',
        border:'#d9dce1', track:'#e6e8eb', tabInactive:'#e6e8eb', tabActive:'#0f2d4a',
        txt:'#1b2a3a', mut:'#5b6b7b',
        // Helm status palette
        green:'#2e9e5b',       // open / healthy
        amber:'#e6a417',       // S&OP / tight (Helm's yellow rows)
        red:'#e05b4b',         // over-cap / closed (Helm's pink/red rows)
        pinkBg:'#fbe0dc',      // over-cap row tint (matches Helm pink)
        amberBg:'#fcefc9',     // at-threshold row tint (matches Helm yellow)
        greenBg:'#e4f4ea',     // healthy row tint
    };
    const barColor = p => p >= 90 ? C.green : (p >= 40 ? C.amber : C.red);
    // Row status by remaining capacity (mirrors Helm): over cap = pink, tight = yellow, healthy = green
    function capStatus(remCap) {
        if (remCap == null) return { bg:'#ffffff', edge:C.border };
        if (remCap < 0)   return { bg:C.pinkBg,  edge:C.red };
        if (remCap < 200) return { bg:C.amberBg, edge:C.amber };
        return { bg:C.greenBg, edge:C.green };
    }

    /* ============================================================
       1) INTERCEPT the HoudiniPickCapacity API (fetch + XHR)
       ============================================================ */
    function looksLikeCapacity(url) {
        return typeof url === 'string' && /HoudiniPickCapacity|pick-capacity|retrieve-slot-capacity/i.test(url);
    }
    // Derive 'YYYY-MM-DD|CPT' key for a raw window object (site TZ from matcher epoch-ms).
    function windowKey(w) {
        const matcher = w && w.input_config && w.input_config.max_capacity && w.input_config.max_capacity.matcher;
        if (!matcher) return null;
        const parts = matcher.split('.');            // [fc, Weekday, CPT, ms] — parts[0] is the SITE
        if (parts[0] && /^[A-Z]{3}\d$/.test(parts[0])) detectedSite = parts[0];   // capture the live site (e.g. UNJ2/UMA4)
        const cpt = parts[2] || '';
        const ms = parseInt(parts[3], 10);
        let date = parts[1] || '';                   // fallback: weekday
        if (!isNaN(ms)) {
            try { date = new Intl.DateTimeFormat('en-CA', { timeZone: tzName(),
                year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(ms)); } catch (e) {}
        }
        return date + '|' + cpt;
    }
    // SAFEGUARD (v25.4): bound windowStore memory. windowStore accumulates every window
    // the panel has ever seen; over a long shift that grows unbounded. Keep only windows whose
    // ET date is within +/- HORIZON_DAYS of the current operational day (covers Nights' post-
    // midnight roll into the next day and the Daily Totals MAX_DAYS view). Keying is date|cpt,
    // so we parse the date from the key. Pruning stale days is invisible to the user's view.
    const STORE_HORIZON_DAYS = 3;   // keep today +/- 3 days of windows (well beyond MAX_DAYS=3 view)
    function pruneWindowStore() {
        try {
            if (windowStore.size <= 200) return;   // cheap guard: only prune once it's actually large
            const todayMs = Date.now();
            const dayMs = 86400000;
            for (const [k, w] of windowStore) {
                // Prefer the window's own timestamp; fall back to parsing the key's date.
                let ms = null;
                const dl = w && w.input_config && w.input_config.max_capacity && w.input_config.max_capacity.matcher;
                if (dl) { const parts = String(dl).split('.'); const e = parseInt(parts[parts.length - 1], 10); if (!isNaN(e)) ms = e; }
                if (ms == null) { const d = String(k).split('|')[0]; const t = Date.parse(d + 'T12:00:00'); if (!isNaN(t)) ms = t; }
                if (ms == null) continue;   // can't date it -> keep (safe)
                if (Math.abs(ms - todayMs) > STORE_HORIZON_DAYS * dayMs) windowStore.delete(k);
            }
        } catch (e) { /* never let pruning break ingest */ }
    }
    function ingest(text) {
        try {
            const data = JSON.parse(text);
            if (Array.isArray(data) && data.length && data[0] && data[0].input_config) {
                // MERGE into the persistent store instead of replacing. Helm may fire separate
                // API calls per day (or the current-day call would otherwise overwrite a prior
                // multi-day payload), which previously left only the current day visible.
                // Keying by date|cpt and always taking the newest payload's version keeps ALL
                // days the panel has ever seen (9/9 + 9/10 + ...), freshest wins per window.
                // SITE DETECTION (v1.31): the matcher's first segment is the authoritative site
                // code for THIS data (e.g. 'UMA4.Wednesday.02:15.<ms>'). Capture it so the Labor
                // Allocation pull + header reflect whatever site's Helm data is actually loaded —
                // not a hardcoded UNJ2. Updates every payload so switching sites is picked up live.
                try {
                    const mt0 = data[0].input_config && data[0].input_config.max_capacity && data[0].input_config.max_capacity.matcher;
                    const sc = mt0 ? String(mt0).split('.')[0] : null;
                    if (sc && /^[A-Z0-9]{3,6}$/.test(sc) && sc !== detectedSite) { detectedSite = sc; }
                } catch (e) {}
                data.forEach(w => { const k = windowKey(w); if (k) windowStore.set(k, w); });
                pruneWindowStore();   // SAFEGUARD: bound memory — drop windows outside the visible horizon
                latestData = [...windowStore.values()];
                lastUpdated = Date.now();
                scheduleRender();
            }
        } catch (e) { /* not our payload */ }
    }
    // ET now helpers (used by the next-day roll + scraper).
    function etHourNow() { return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tzName(), hour:'2-digit', hour12:false }).format(new Date()), 10) % 24; }
    function etDateNow() { return new Intl.DateTimeFormat('en-CA', { timeZone: tzName(), year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date()); }

    const origFetch = window.fetch;
    if (origFetch) {
        window.fetch = function (...args) {
            const url = (args[0] && args[0].url) ? args[0].url : args[0];
            return origFetch.apply(this, args).then(res => {
                if (looksLikeCapacity(url)) res.clone().text().then(ingest).catch(() => {});
                return res;
            });
        };
    }
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) { this.__mh_url = url; return origOpen.call(this, method, url, ...rest); };
    XMLHttpRequest.prototype.send = function (...a) {
        this.addEventListener('load', function () {
            if (looksLikeCapacity(this.__mh_url) && this.responseText) ingest(this.responseText);
        });
        return origSend.apply(this, a);
    };

    /* ============================================================
       2) TRANSFORM
       ============================================================ */
    function parseWindows(data) {
        const rows = [];
        data.forEach(w => {
            const matcher = w.input_config && w.input_config.max_capacity && w.input_config.max_capacity.matcher;
            let day = '', cpt = '', hr = null;
            if (matcher) {
                const parts = matcher.split('.');   // [UNJ2, Wednesday, 02:15, ms]
                day = parts[1] || '';
                cpt = parts[2] || '';
                const hm = /^(\d{1,2}):(\d{2})$/.exec(cpt);
                if (hm) hr = parseInt(hm[1], 10);
            }
            if (hr === null) return;

            // Calendar date (YYYY-MM-DD) in site timezone from the matcher's epoch-ms part
            let date = day;
            const ms = matcher ? parseInt(matcher.split('.')[3], 10) : NaN;
            if (!isNaN(ms)) {
                try {
                    date = new Intl.DateTimeFormat('en-CA', { timeZone: tzName(),
                        year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
                } catch (e) { date = day; }
            }

            const zones = {};
            let wo = 0, wp = 0;
            ZONES.forEach(z => {
                const f = ZONE_FIELD[z];
                const o = Math.max(w['units_ordered_' + f] || 0, 0);
                const p = Math.max(w['units_picked_' + f] || 0, 0);
                zones[z] = { o, p };
                wo += o; wp += p;
            });

            // TRUE totals for Daily Totals tab: sum EVERY units_ordered_* / units_picked_*
            // field (includes not_dropped + *_large/_medium/_small + cold/produce/asrs).
            // Future/forecast windows carry volume in not_dropped before zone classification,
            // so zone-only sums undercount them. Matches Helm's raw "Units Ordered" column.
            let totO = 0, totP = 0;
            for (const k in w) {
                if (k.startsWith('units_ordered_')) totO += Math.max(w[k] || 0, 0);
                else if (k.startsWith('units_picked_')) totP += Math.max(w[k] || 0, 0);
            }

            const remCap = (w.capacity && typeof w.capacity.effectiveRemainingCapacity === 'number')
                ? w.capacity.effectiveRemainingCapacity : null;

            const ndO = Math.max(w['units_ordered_not_dropped'] || 0, 0);
            const ndP = Math.max(w['units_picked_not_dropped'] || 0, 0);
            // Helm's per-window pick deadline (epoch ms) — drives OB Indirect batch detection.
            const deadline = (typeof w.deadline === 'number') ? w.deadline : NaN;
            rows.push({ day, date, ms, cpt, hr, zones, remCap, deadline,
                        batchVol: totO,                    // window total ordered = batch volume
                        ordered: wo, picked: wp,           // zone-only (Pick Ahead tab)
                        notDroppedO: ndO, notDroppedP: ndP, // unclassified catch-all
                        dayOrdered: totO, dayPicked: totP, // full totals (Daily Totals tab)
                        maxCap: w.max_capacity || 0 });
        });
        return rows;
    }
    // De-dupe: keep the freshest row per (day+cpt)
    function dedupe(rows) {
        // Key by CALENDAR DATE + cpt (NOT weekday name). r.day is a weekday ('Wednesday'),
        // so two different calendar dates that share a weekday within the range would collide
        // and overwrite each other, corrupting day totals. Use r.date (YYYY-MM-DD) instead.
        const map = new Map();
        rows.forEach(r => map.set((r.date || r.day) + '|' + r.cpt, r));
        return [...map.values()];
    }
    // ---- DOM TABLE SCRAPER (Daily Totals source of truth) ----
    // The HoudiniPickCapacity API only returns the CURRENT operational day. The Helm table,
    // however, renders EVERY date in the picker range (9/9, 9/10, 9/11...). To show all days
    // in Daily Totals we scrape the rendered AntD table \u2014 same approach as the reference
    // "Mega Helm - Units Ordered" script. Each data row's cells (0-indexed):
    //   0 Date | 1 SlotStart | 2 CPT | 3 UnitsOrdered | 4 UnitsPicked | 5 AllocLabor
    //   6 LaborCap | 7 MaxCap | 8 RemCap | 9 Constraint ...
    // Cell text often carries a "(xx%)" suffix -> strip to the leading integer.
    function numFromCell(el) {
        if (!el) return 0;
        const t = (el.textContent || '').replace(/,/g, '');
        const m = t.match(/-?\d+/);            // first integer (ignores the % part)
        return m ? parseInt(m[0], 10) : 0;
    }
    function isDateStr(t) { return /^\d{4}-\d{2}-\d{2}$/.test((t || '').trim()); }
    function scrapeTableDays() {
        const days = {};
        // Native <td> table. There is a leading expand ('+') column, so the DATE is NOT always
        // cell[0] — find the date cell dynamically, then read columns RELATIVE to it:
        //   date(d) | SlotStart(d+1) | CriticalPull(d+2) | UnitsOrdered(d+3) | UnitsPicked(d+4)
        //   | AllocLabor(d+5) | LaborCap(d+6) | MaxUnitCap(d+7) | RemCap(d+8) | Constraint(d+9)
        // Values carry a "(xx%)" suffix -> numFromCell strips to the leading integer.
        // Only main data rows have a date cell; expansion/zone sub-rows don't -> naturally skipped.
        const trs = document.querySelectorAll('tr');
        trs.forEach(tr => {
            const cells = tr.querySelectorAll('td');
            if (cells.length < 4) return;
            // locate the date cell
            let d = -1;
            for (let i = 0; i < cells.length; i++) {
                if (isDateStr((cells[i].textContent || '').trim())) { d = i; break; }
            }
            if (d === -1) return;                       // no date in this row -> not a main data row
            const dateTxt = (cells[d].textContent || '').trim();
            const ordered = numFromCell(cells[d + 3]);
            const picked  = numFromCell(cells[d + 4]);
            const maxCap  = numFromCell(cells[d + 7]);
            if (!days[dateTxt]) days[dateTxt] = { ordered: 0, picked: 0, maxCap: 0, n: 0 };
            days[dateTxt].ordered += ordered;
            days[dateTxt].picked  += picked;
            days[dateTxt].maxCap  += maxCap;
            days[dateTxt].n++;
        });
        return days;
    }

    function dayTotals(rows) {
        const days = {};
        rows.forEach(r => {
            const key = r.date || r.day || '?';
            if (!days[key]) days[key] = { ordered: 0, picked: 0, maxCap: 0 };
            days[key].ordered += r.dayOrdered;
            days[key].picked  += r.dayPicked;
            days[key].maxCap  += r.maxCap;
        });
        return days;
    }
    // Read the Helm date-picker's START date so the panel follows the day the table is set to
    // (instead of the wall clock). Returns an ET-noon epoch-ms for that date, or null if not found.
    function getSelectedDateMs() {
        // The picker renders two date fields ("from" and "to"). Grab the FIRST date-looking value.
        let dstr = null;
        // Prefer real <input> values
        document.querySelectorAll('input').forEach(inp => {
            if (dstr) return;
            const v = (inp.value || '').trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(v)) dstr = v;
        });
        // Fallback: any element whose trimmed text is exactly a date (AntD sometimes uses spans)
        if (!dstr) {
            const els = document.querySelectorAll('.ant-picker-input input, [class*="picker"] input, span, div');
            for (const el of els) {
                const v = (el.textContent || '').trim();
                if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { dstr = v; break; }
            }
        }
        if (!dstr) return null;
        const [y, m, d] = dstr.split('-').map(Number);
        // ET-noon anchor for that date (noon avoids DST edge issues; shiftWindow re-derives hours)
        let guess = Date.UTC(y, m - 1, d, 12, 0, 0);
        for (let i = 0; i < 4; i++) {
            const gd = etDate(guess), gh = etHour(guess);
            const [gy, gm, gday] = gd.split('-').map(Number);
            const dayDiff = Date.UTC(y, m-1, d) - Date.UTC(gy, gm-1, gday);
            guess += dayDiff + (12 - gh) * 3600000;
        }
        return guess;
    }

    // ============================================================
    //  NEXT-DAY ZONE SCRAPE (v27.4) — additive, safe-fallback.
    //  The HoudiniPickCapacity API is current-day only. NEXT-DAY (+1) windows come from the rendered
    //  Helm table. Per-zone data lives in each row's EXPANDED child row (flat <td> cells). Confirmed
    //  layout (image_250): after the CPT/summary cells, each zone is a 4-col block
    //  [Units Ordered, Units Picked, UPH, Allocated Labor] in order Ambient, Bigs, Hv Bigs, Frozen,
    //  Chilled. We AUTO-EXPAND rows, then read the child row's cells positionally, validated by count.
    //  Produces row objects shaped like parseWindows() output so the roll + render reuse them.
    // ============================================================
    function autoExpandTableRows() {
        try {
            document.querySelectorAll('.ant-table-row-expand-icon-collapsed, [aria-label="Expand row"]').forEach(ic => { try { ic.click(); } catch (e) {} });
        } catch (e) {}
    }
    // ET-noon epoch-ms for a 'YYYY-MM-DD' + 'HH:15' CPT (so ms sorts correctly; hour from CPT).
    function cptMs(dateStr, cpt) {
        try {
            const [y,m,d] = dateStr.split('-').map(Number);
            const hh = parseInt((cpt||'').split(':')[0], 10); if (isNaN(hh)) return NaN;
            let guess = Date.UTC(y, m-1, d, hh, 15, 0);
            for (let i=0;i<4;i++){ const gd=etDate(guess), gh=etHour(guess); const [gy,gm,gday]=gd.split('-').map(Number);
                guess += (Date.UTC(y,m-1,d)-Date.UTC(gy,gm-1,gday)) + (hh-gh)*3600000; }
            return guess;
        } catch (e) { return NaN; }
    }
    // Scrape next-day (and any non-current-day) window rows WITH zone detail from the expanded table.
    function scrapeNextDayZoneRows() {
        // The MAIN row carries date + CPT + summary; the EXPANDED sibling row (next <tr>) carries the
        // per-zone cells. AntD renders the expanded content as the NEXT <tr> after the main row. So we
        // PAIR each main row with the following wide row and read zones from the sibling.
        // Zone cells in the expanded row (from confirmed DOM): after 6 leading summary cells,
        // each zone = 4 cells [Units Ordered, Units Picked, UPH, Allocated Labor], in order
        // Ambient, Bigs, Hv Bigs, Frozen, Chilled. We consume Ambient/Bigs/Frozen/Chilled.
        const out = [];
        try {
            autoExpandTableRows();
            // v28.2: do NOT skip by wall-clock date. Return ALL dated zone rows; the roll selects the
            // correct next-day date relative to the SHIFT's SOS date (not the wall clock), so the panel
            // works even when the Helm picker is set to a prior/other day.
            const trs = [...document.querySelectorAll('tr')];
            for (let ti = 0; ti < trs.length; ti++) {
                const cells = trs[ti].querySelectorAll('td');
                if (cells.length < 4) continue;
                // main row must have a date cell
                let d = -1;
                for (let i = 0; i < cells.length; i++) { if (isDateStr((cells[i].textContent||'').trim())) { d = i; break; } }
                if (d === -1) continue;
                const dateTxt = (cells[d].textContent||'').trim();
                const cpt = (cells[d+2].textContent||'').trim();
                if (!/^\d{1,2}:\d{2}$/.test(cpt)) continue;
                // The expanded sibling is the NEXT <tr> — find the first following row that's WIDE.
                let zcells = null;
                for (let k = ti+1; k < Math.min(ti+3, trs.length); k++) {
                    const cc = trs[k].querySelectorAll('td');
                    // sibling expanded row has NO date and many cells (zone blocks)
                    if (cc.length >= 18) {
                        let hasDate = false;
                        for (let i=0;i<cc.length;i++){ if (isDateStr((cc[i].textContent||'').trim())){ hasDate=true; break; } }
                        if (!hasDate) { zcells = cc; break; }
                    }
                }
                if (!zcells) continue;
                // Zone blocks: skip leading summary cells. Find the first numeric run — the confirmed
                // layout has 6 summary columns before Ambient's Units Ordered. Use offset 6.
                // Each zone = 4 cells [Ordered, Picked, UPH, Labor]; order Ambient,Bigs,Hv Bigs,Frozen,Chilled.
                const ZBASE = 6;
                const TABLE_ZONE_ORDER = ['Ambient','Bigs','Hv Bigs','Frozen','Chilled'];
                const zones = {}; ZONES.forEach(z => zones[z] = { o:0, p:0 });
                let wo=0, wp=0, ok=false;
                TABLE_ZONE_ORDER.forEach((zoneName, zi) => {
                    const oCell = zcells[ZBASE + zi*4];
                    const pCell = zcells[ZBASE + zi*4 + 1];
                    if (!oCell || !zones[zoneName]) return;
                    const o = numFromCell(oCell), p = numFromCell(pCell);
                    zones[zoneName] = { o, p }; wo += o; wp += p; ok = true;
                });
                if (!ok) continue;
                const ms = cptMs(dateTxt, cpt);
                out.push({ day:'', date:dateTxt, ms, cpt, hr: parseInt(cpt,10), zones, remCap:null, deadline:NaN,
                           batchVol: wo, ordered: wo, picked: wp, notDroppedO:0, notDroppedP:0,
                           dayOrdered: wo, dayPicked: wp, _scraped:true });
            }
        } catch (e) {}
        return out;
    }

    function zoneAggAndWindows(rows) {
        // REAL CLOCK ALWAYS WINS (v28.5): anchor off the ACTUAL current time, IGNORING the Helm date
        // picker. Shifts are universal — Nights 6PM-6AM, Days 6AM-6PM — so the in-progress shift is
        // determined by the real clock (see shiftWindow). This fixes the off-by-a-day bug where a
        // picker set to the wrong day showed the wrong shift's windows.
        const anchorMs = Date.now();
        let [wStart, wEnd] = shiftWindow(currentShift, anchorMs, false);
        // NIGHTS is a FIXED window (19:15 -> 09:15) and NEVER rolls. Its total reflects only its
        // own windows through the 09:15 anchor.
        // DAYS ROLLS: Days runs 07:15 -> 20:15, but once ALL Days windows are fully picked we roll
        // FORWARD into the next (Nights) windows so it shows the upcoming work instead of "DONE".
        let effEnd = wEnd;
        let daysRolled = false;
        let rolledDate = null;   // the next-day date we rolled into (for the banner)
        // First pass: this shift's own windows.
        let ownRows = rows.filter(r => !isNaN(r.ms) && r.ms >= wStart && r.ms < wEnd);
        // DAYS NEXT-DAY ROLL (restored v1.16): once 9/20's Days windows are FULLY PICKED, show
        // 9/21's Days windows — no matter what day the Helm picker is set to. The prior double-count
        // bug was NOT the roll itself; it was concatenating scraped next-day rows ON TOP of API/DOM
        // rows that already existed for that day (ordered volume ~2x). Fix: DEDUPE by date+cpt so
        // scraped rows REPLACE, never add.
        if (currentShift === 'days') {
            const anchorCpt = ANCHOR_CPT.days;   // '20:15'
            const anchorRows = ownRows.filter(r => r.cpt === anchorCpt);
            const anchorVolume = anchorRows.reduce((a, r) =>
                a + ZONES.reduce((b, z) => b + r.zones[z].o, 0), 0);
            const anchorUnpicked = anchorRows.reduce((a, r) =>
                a + ZONES.reduce((b, z) => b + Math.max(r.zones[z].o - r.zones[z].p, 0), 0), 0);
            // Roll trigger: 20:15 has sold volume AND is fully picked -> current Days board is complete.
            if (anchorVolume > 0 && anchorUnpicked === 0) {
                const nd = scrapeNextDayZoneRows();
                const sosStr = etDate(wStart);
                const nextDayStr = etDate(cptMs(sosStr, '12:00') + 24*3600000);   // +1 day, ET-safe
                const dStartH = startHour('days'), dAnchorH = anchorHour('days');
                const ndDays = nd.filter(r => r.date === nextDayStr && r.hr >= dStartH && r.hr <= dAnchorH);
                if (ndDays.length) {
                    // DEDUPE FIX: drop any existing rows whose date+cpt matches a scraped next-day row
                    // BEFORE concat, so scraped next-day rows REPLACE (never double) the API/DOM copies.
                    const ndKeys = new Set(ndDays.map(r => (r.date || r.day) + '|' + r.cpt));
                    rows = rows.filter(r => !ndKeys.has((r.date || r.day) + '|' + r.cpt)).concat(ndDays);
                    const ms0 = Math.min(...ndDays.map(r => r.ms));
                    const ms1 = Math.max(...ndDays.map(r => r.ms)) + 60000;
                    wStart = ms0; effEnd = ms1;
                    daysRolled = true;
                    rolledDate = nextDayStr;
                }
            }
        }
        // NIGHTS NEXT-SHIFT ROLL (v1.23): once this Nights shift's ANCHOR (09:15) is fully picked,
        // roll forward to TONIGHT's Nights windows (next SOS 19:15 -> following-day 09:15). Example:
        // at ~9AM Mon 9/21, once 9/21 09:15 is picked -> show 9/21 19:15 through 9/22 09:15. The Helm
        // table carries 3 days of windows, so tonight's board is always present in the scrape. Mirrors
        // the Days roll: DEDUPE by date+cpt (replace, never add), re-scope the window.
        if (currentShift === 'nights') {
            const anchorCpt = ANCHOR_CPT.nights;   // '09:15'
            const anchorRows = ownRows.filter(r => r.cpt === anchorCpt);
            const anchorVolume = anchorRows.reduce((a, r) =>
                a + ZONES.reduce((b, z) => b + r.zones[z].o, 0), 0);
            const anchorUnpicked = anchorRows.reduce((a, r) =>
                a + ZONES.reduce((b, z) => b + Math.max(r.zones[z].o - r.zones[z].p, 0), 0), 0);
            if (anchorVolume > 0 && anchorUnpicked === 0) {
                const nd = scrapeNextDayZoneRows();
                // Next Nights shift SOS = the evening AFTER this shift's SOS date. This shift's SOS is
                // etDate(wStart) (the 19:15 date). Next SOS = +1 day; window = SOS 19:00 -> SOS+1 09:16.
                const thisSos = etDate(wStart);
                const nextSos = etDate(cptMs(thisSos, '12:00') + 24*3600000);      // +1 day
                const nextEnd = etDate(cptMs(nextSos, '12:00') + 24*3600000);      // +2 days (morning tail)
                const nStartH = startHour('nights'), nAnchorH = anchorHour('nights');
                // Next Nights windows: evening CPTs (>= 19:15) on nextSos OR morning CPTs (<= 09:15) on nextEnd.
                const ndNights = nd.filter(r =>
                    (r.date === nextSos && r.hr >= nStartH) ||
                    (r.date === nextEnd && r.hr <= nAnchorH));
                if (ndNights.length) {
                    const ndKeys = new Set(ndNights.map(r => (r.date || r.day) + '|' + r.cpt));
                    rows = rows.filter(r => !ndKeys.has((r.date || r.day) + '|' + r.cpt)).concat(ndNights);
                    const ms0 = Math.min(...ndNights.map(r => r.ms));
                    const ms1 = Math.max(...ndNights.map(r => r.ms)) + 60000;
                    wStart = ms0; effEnd = ms1;
                    daysRolled = true;              // reuse the rolled flag for the banner
                    rolledDate = nextSos;
                }
            }
        }
        let shiftRows = rows
            .filter(r => !isNaN(r.ms) && r.ms >= wStart && r.ms < effEnd)
            .sort((a, b) => a.ms - b.ms);
        // DEDUPE BY DATE+CPT (v1.32): a window must appear ONCE. Duplicates (mid-mile dual-delivery
        // CPTs, or a Days-roll scrape overlapping API rows) otherwise get their zones summed twice —
        // producing impossible figures like Ambient 227% picked, TOTAL 132%, and a wildly inflated
        // pick-ahead number (e.g. 121,105). Keep one row per date|cpt (last wins = freshest/scraped).
        {
            const seen = new Map();
            shiftRows.forEach(r => seen.set((r.date || r.day) + '|' + r.cpt, r));
            shiftRows = [...seen.values()].sort((a, b) => a.ms - b.ms);
        }
        // REMAINING-ONLY (v28.9): show only windows from NOW forward through the anchor — drop windows
        // whose CPT has already fully passed (they're done/in the past). At 2AM Nights this yields
        // 02:15→09:15, not the passed evening windows. A window is 'passed' when its CPT time is
        // >1h behind now (grace so the just-current window still shows). Keeps any window with unpicked
        // units regardless (never hide real remaining work).
        {
            const nowMs2 = Date.now();
            shiftRows = shiftRows.filter(r => {
                const unp = ZONES.reduce((a, z) => a + Math.max(r.zones[z].o - r.zones[z].p, 0), 0);
                if (unp > 0) return true;                       // real remaining work -> always show
                return r.ms >= (nowMs2 - 3600000);              // else only current/upcoming windows
            });
        }
        // SOS HANDOFF RULE (v28.5): the shift's SOS window (Nights 19:15 / Days 07:15) is BATCHED by
        // this shift but PICKED by the PREVIOUS shift. Hide it when fully picked (noise); if it still
        // has unpicked units, KEEP it and flag __handoff so the render can label it "handoff".
        const sosCpt = SETTINGS.shifts[currentShift].start;
        shiftRows = shiftRows.filter(r => {
            if (r.cpt !== sosCpt) return true;
            const unp = ZONES.reduce((a, z) => a + Math.max(r.zones[z].o - r.zones[z].p, 0), 0);
            if (unp <= 0) return false;         // fully picked SOS handoff -> hide
            r.__handoff = true;                 // unpicked remains -> keep + label
            return true;
        });
        const totals = {};
        ZONES.forEach(z => totals[z] = { ordered: 0, picked: 0 });
        shiftRows.forEach(r => ZONES.forEach(z => {
            totals[z].ordered += r.zones[z].o;
            totals[z].picked  += r.zones[z].p;
        }));
        return { totals, windows: shiftRows, daysRolled, rolledDate };
    }
    // Day ordering: sort chronologically (by calendar date) and include EVERY day that has
    // sold units (ordered > 0). This guarantees 9/10, 9/11, etc. show as soon as they have
    // volume — not gated by API array position. MAX_DAYS only trims trailing empty-ish days.
    function orderedDayKeys(rows, days) {
        const withUnits = Object.keys(days).filter(k => (days[k].ordered || 0) > 0);
        withUnits.sort();  // 'YYYY-MM-DD' strings sort chronologically
        return withUnits.slice(0, MAX_DAYS);
    }

    /* ============================================================
       3) RENDER
       ============================================================ */
    // A window is GLOBALLY COMPLETE when every zone is fully picked (o - p <= 0 for all zones).
    // Such windows drop out of the zone view entirely so they don't consume a "5 shown" slot.
    function windowComplete(w) {
        return ZONES.every(z => (w.zones[z].o - w.zones[z].p) <= 0);
    }

    function zoneSVG(name, zt, windows, runwayHours) {
        // Windows still needing work in THIS zone. Also exclude any window that is GLOBALLY
        // complete (all zones fully picked) so a finished window never consumes a "5 shown" slot
        // in any zone. Over-cap windows still count as long as units remain.
        const allRows = windows
            .filter(w => !windowComplete(w) && (w.zones[name].o - w.zones[name].p) > 0)
            .sort((a, b) => a.ms - b.ms);

        // "Done" rule: the shift is fully picked only when the ANCHOR CPT (09:15 nights /
        // 19:15 days) has no remaining units. A zone can be net-positive-picked overall
        // (picked >= ordered => negative "left") yet still have earlier windows OR the anchor
        // window incomplete. So we judge completion off the anchor window, not the net.
        const anchorCpt = ANCHOR_CPT[currentShift];
        // With ROLLING HORIZON the window set can span two days (today's + tomorrow's sold
        // windows), so there may be multiple anchor-CPT rows. Sum unpicked across ALL of them.
        const anchorRows = windows.filter(w => w.cpt === anchorCpt);
        const anchorLeft = anchorRows.reduce((a, w) => a + Math.max(w.zones[name].o - w.zones[name].p, 0), 0);
        const anchorDone = anchorLeft === 0;             // every anchor CPT cleared
        // DONE only when NOTHING remains in the whole horizon for this zone. Because `windows`
        // now includes tomorrow's unpicked windows, allRows stays non-empty while work remains
        // ahead — so the panel never falsely reads DONE with sold windows still to pick.
        const shiftComplete = (allRows.length === 0);

        // Pick-ahead detection: earliest unfinished window is index 0. Any window whose
        // position (index) is more than PICK_AHEAD_LIMIT beyond it AND already has picks
        // means work is happening too far ahead. Flag those windows + the zone header.
        let zoneAheadFlag = false;
        allRows.forEach((w, idx) => {
            const p = w.zones[name];
            w.__ahead = (idx > PICK_AHEAD_LIMIT && p.p > 0);
            if (w.__ahead) zoneAheadFlag = true;
        });

        // Cap the view to the 5 current (earliest) windows; note how many are hidden.
        const rows = allRows.slice(0, MAX_ZONE_WINDOWS);
        const hidden = allRows.length - rows.length;

        const W = 400, rowH = 30, top = 58;
        // extra footer lines: hidden note, pick-ahead flag, anchor-not-done note
        const anchorNote = (!anchorDone && allRows.length === 0);  // net done but anchor still open
        const extra = (hidden > 0 ? 20 : 0) + (zoneAheadFlag ? 20 : 0) + (anchorNote ? 20 : 0);
        const H = top + Math.max(rows.length, 1) * rowH + 12 + extra;
        const barX = 66, barW = 176, numX = W - 10;
        const pct = zt.ordered ? Math.round(zt.picked / zt.ordered * 1000) / 10 : 0;
        // Header "left" = true remaining across in-shift windows (never negative). Net over-pick
        // in some windows must NOT cancel out real remaining units in others.
        const trueLeft = allRows.reduce((a, w) => a + (w.zones[name].o - w.zones[name].p), 0);
        let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="background:#fff;border:1px solid ${zoneAheadFlag ? C.amber : C.border};border-radius:6px;font-family:Arial">`;
        // zone header band
        s += `<rect x="0" y="0" width="${W}" height="50" fill="${C.card}"/>`;
        s += `<text x="12" y="22" font-size="17" font-weight="bold" fill="${C.txt}">${name}</text>`;
        s += `<text x="${numX}" y="22" font-size="15" font-weight="bold" fill="${trueLeft > 0 ? C.red : C.green}" text-anchor="end">${trueLeft > 0 ? trueLeft.toLocaleString() + ' left' : (anchorDone ? 'DONE' : '\u2014')}</text>`;
        // Pickers needed for THIS zone = unpicked / packRate / runway-to-anchor hours.
        // Shown at the header right, under the "X left" number (y=42). Frozen uses 90 UPH.
        const zoneRate = packRate(name);
        const pickers = (trueLeft > 0 && runwayHours && runwayHours > 0)
            ? Math.ceil(trueLeft / zoneRate / runwayHours) : 0;   // round UP to whole pickers
        if (trueLeft > 0 && pickers > 0) {
            // pickers needed (bold) + planned pack rate (lighter) — e.g. "11 pickers needed · 105 UPH"
            s += `<text x="${numX}" y="42" text-anchor="end"><tspan font-size="12" font-weight="bold" fill="${C.head}">${pickers} pickers needed</tspan><tspan font-size="11" fill="${C.mut}"> · ${zoneRate} UPH</tspan></text>`;
        }
        s += `<text x="12" y="42" font-size="13" fill="${barColor(pct)}" font-weight="bold">${pct}%</text>`;
        s += `<text x="78" y="42" font-size="13" fill="${C.mut}">${zt.picked.toLocaleString()} / ${zt.ordered.toLocaleString()}</text>`;
        if (!rows.length) {
            if (shiftComplete) s += `<text x="12" y="${top + 14}" font-size="13" fill="${C.green}" font-weight="bold">\u2713 fully picked (${anchorCpt} clear)</text>`;
            else s += `<text x="12" y="${top + 14}" font-size="13" fill="${C.mut}">no windows with units left in view</text>`;
        }
        rows.forEach((w, i) => {
            const y = top + i * rowH, p = w.zones[name], u = p.o - p.p;
            const fw = p.o ? Math.min(p.p / p.o, 1) * barW : 0;
            const wpct = p.o ? Math.round(p.p / p.o * 100) : 0;
            const isAnchor = (w.cpt === anchorCpt);
            // amber tint on rows picked too far ahead; light navy tint on the anchor CPT row
            if (w.__ahead) s += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="${C.amberBg}"/>`;
            else if (isAnchor) s += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="#eef2f7"/>`;
            else if (i % 2) s += `<rect x="0" y="${y}" width="${W}" height="${rowH}" fill="#fafbfc"/>`;
            const rowTip = isAnchor ? '\u2605 Anchor (shift-end) CPT \u2014 must be picked by end of shift' : (w.__ahead ? '\u26a0 Picked ahead of the current active CPT' : w.cpt);
            s += `<text x="12" y="${y + 19}" font-size="13" fill="${C.txt}" font-family="monospace" font-weight="${isAnchor ? 'bold' : 'normal'}"><title>${rowTip}</title>${w.__ahead ? '\u26a0 ' : ''}${isAnchor ? '\u2605 ' : ''}${w.cpt}${w.__handoff ? ' \u00b7 handoff' : ''}</text>`;
            s += `<rect x="${barX}" y="${y + 7}" width="${barW}" height="14" rx="3" fill="${C.track}"/>`;
            if (fw > 0) s += `<rect x="${barX}" y="${y + 7}" width="${Math.max(fw, 3).toFixed(1)}" height="14" rx="3" fill="${barColor(wpct)}"/>`;
            s += `<text x="${numX}" y="${y + 19}" font-size="13" font-weight="bold" fill="${u > 0 ? C.red : C.mut}" text-anchor="end" font-family="monospace">${u > 0 ? u.toLocaleString() + ' left' : '0'}</text>`;
        });
        let footY = top + Math.max(rows.length, 1) * rowH + 4;
        if (hidden > 0) {
            s += `<text x="12" y="${footY + 12}" font-size="12" fill="${C.mut}" font-style="italic">+${hidden} more window${hidden > 1 ? 's' : ''} beyond the 5 current</text>`;
            footY += 20;
        }
        if (zoneAheadFlag) {
            s += `<text x="12" y="${footY + 12}" font-size="12" fill="${C.amber}" font-weight="bold">\u26a0 picking ahead &gt;${PICK_AHEAD_LIMIT} windows</text>`;
            footY += 20;
        }
        if (anchorNote) {
            s += `<text x="12" y="${footY + 12}" font-size="12" fill="${C.amber}" font-weight="bold">\u2605 ${anchorCpt} still has ${anchorLeft.toLocaleString()} \u2014 not done</text>`;
        }
        return s + `</svg>`;
    }
    // Build the OB Indirect plan card: identifies the CURRENT batch window (deadline-passed rule),
    // shows its volume + the function headcounts (batching/pickers/stage/handoff/slam), plus a
    // compact look-ahead of the next few batch windows.
    function obindPlanHtml(rows) {
        // END STATE: last batch CPT deadline passed and nothing upcoming -> batching is done.
        if (isBatchingDone(rows)) {
            return `<div style="border:1px solid ${C.border};border-radius:6px;margin-bottom:10px;overflow:hidden;">
                <div style="background:#1f7a4d;color:#fff;font-size:12px;font-weight:bold;padding:6px 10px;">✓ Outbound Labor — batching complete</div>
                <div style="padding:10px 12px;font-size:12px;color:${C.mut};">
                    Last batch window (${SETTINGS.obind.lastBatchCpt}) has closed. No further batch-ahead volume — remaining work is pick/stage/handoff on the board.
                </div></div>`;
        }
        const cur = currentBatchWindow(rows);
        // BATCH volume (Helm API) drives Batchers only. PICK volume is MANUAL (from the Labor
        // Allocation page, current hour) and drives Pickers/Stage/Handoff/Slam. When 02:15 is
        // being batched, that batch-ahead volume is NOT the current pick volume — keep them split.
        const batchVol = cur ? Math.max(cur.batchVol || 0, 0) : 0;
        const pickVol  = Math.max(effectivePickVol() || 0, 0);
        const batchPlan = obindPlan(batchVol);
        const pickPlan  = obindPlan(pickVol);
        // Function row: label (left, bold) with a tiny muted divisor sub-line; big right-aligned
        // headcount. Alternating hairline separators keep the list scannable (v29.25 readability).
        const fmtRow = (label, val, div, src2) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 2px;border-bottom:1px solid ${C.border};">
            <span style="flex:1;min-width:0;line-height:1.2;"><span style="color:${C.txt};font-size:13.5px;font-weight:600;">${label}</span>
                <span style="display:block;color:${C.mut};font-size:11.5px;margin-top:1px;">\u00f7${div} \u00b7 ${src2}</span></span>
            <span style="flex:none;min-width:56px;padding-left:10px;font-weight:800;color:${C.head};font-size:19px;line-height:1;letter-spacing:-.3px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">${val}</span></div>`;
        let card = `<div style="border:1px solid ${C.border};border-top:none;border-radius:0 0 6px 6px;margin-bottom:10px;overflow:hidden;">`;
        card += `<div style="padding:8px 12px;">`;
        // PICK VOLUME (v29.2): AUTO-FILLED from Labor Allocation (current hr), click-to-edit override.
        const planNow = planVolForNow(planCacheGet());
        const effVol = manualPickVol > 0 ? manualPickVol : (typeof planNow === 'number' ? planNow : 0);
        const isOverride = manualPickVol > 0 && typeof planNow === 'number' && manualPickVol !== planNow;
        let pvNote;
        if (isOverride) pvNote = `<span style="color:#b06a00;font-weight:bold;">Manually adjusted</span> \u00b7 plan was ${planNow.toLocaleString()}`;
        else if (typeof planNow === 'number') { const h12 = ((mhPlanHr % 12) || 12); const ap = mhPlanHr < 12 ? 'AM' : 'PM'; pvNote = `WLM ${h12}${ap} Plan (Labor Alloc)`; }
        else pvNote = `<span style="opacity:.7;">No plan pulled \u2014 enter manually</span> <span style="font-family:monospace;font-size:8px;color:#b06a00;">[${mhPullDiag}]</span>`;
        // The input's value is the effective volume; clicking selects-all so you can type freely.
        card += `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px dashed ${C.border};">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <span style="font-size:10px;color:${C.mut};text-transform:uppercase;letter-spacing:.4px;">Pick Volume</span>
                <input id="mh-pickvol" type="text" inputmode="numeric" value="${effVol > 0 ? effVol : ''}" placeholder="click to enter"
                    style="width:96px;box-sizing:border-box;font-size:13px;font-weight:bold;padding:3px 6px;border:1px solid ${isOverride ? '#e0a030' : C.border};border-radius:4px;color:${C.head};text-align:right;">
            </div>
            <div style="font-size:9px;color:${C.mut};margin-top:3px;text-align:right;">${pvNote}${manualPickVol > 0 ? ` · <span id="mh-pickvol-clear" style="cursor:pointer;text-decoration:underline;">use plan</span>` : ''}</div>
        </div>`;
        // ---- SECTION BAND helper: tinted strip, section name left + context right (v29.25) ----
        const sectionBand = (name, ctx) => `<div style="display:flex;justify-content:space-between;align-items:center;background:${C.card};border-radius:4px;padding:3px 8px;margin:6px 0 1px;">
            <span style="font-size:10px;font-weight:bold;color:${C.txt};text-transform:uppercase;letter-spacing:.6px;">${name}</span>
            <span style="font-size:11px;color:${C.mut};">${ctx}</span></div>`;
        // ---- BATCHING: from Helm batch-ahead window ----
        const batchCtx = cur ? `${cur.cpt} \u00b7 vol ${batchVol.toLocaleString()}` : 'no batch window yet';
        card += sectionBand('Batching', batchCtx);
        card += fmtRow('Batchers', batchPlan.batching, obDiv('batching'), 'batch vol');
        // ---- PICKING: from manual pick volume ----
        card += sectionBand('Picking', `pick vol ${pickVol.toLocaleString()}`);
        if (pickVol <= 0) {
            card += `<div style="font-size:11px;color:${C.mut};padding:6px 2px;font-style:italic;">Enter planned pick volume above to size Pickers / Stage / Handoff / Slam.</div>`;
        } else {
            card += fmtRow('Pickers', pickPlan.pickers, obDiv('pickers'), 'pick vol');
            card += fmtRow('Staging', pickPlan.stage, obDiv('stage'), 'pick vol');
            card += fmtRow('Handoff', pickPlan.handoff, obDiv('handoff'), 'pick vol');
            card += fmtRow('Slam Standalone', pickPlan.slam, obDiv('slam'), 'pick vol');
        }
        // ---- OUTBOUND INDIRECT SUPPORT: editable hours (set in Settings). Styled like a function row. ----
        card += `<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 2px;border-bottom:1px solid ${C.border};">
            <span style="flex:1;min-width:0;line-height:1.2;"><span style="color:${C.txt};font-size:13.5px;font-weight:600;">Outbound Support (Indirect)</span>
                <span style="display:block;color:${C.mut};font-size:11.5px;margin-top:1px;">hours \u00b7 problem solve, etc</span></span>
            <span style="flex:none;min-width:56px;padding-left:10px;font-weight:800;color:${C.head};font-size:19px;line-height:1;letter-spacing:-.3px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">${obSupportHrs()}</span></div>`;
        // ---- TOTAL OUTBOUND LABOR: prominent tinted band, big number (batch + pick + support). ----
        const pickHrs = pickVol > 0 ? (pickPlan.pickers + pickPlan.stage + pickPlan.handoff + pickPlan.slam) : 0;
        const totalOutHrs = batchPlan.batching + pickHrs + obSupportHrs();
        card += `<div style="display:flex;justify-content:space-between;align-items:center;background:${C.head};color:#fff;border-radius:5px;padding:9px 2px 9px 12px;margin-top:8px;">
            <span style="flex:1;min-width:0;font-size:12.5px;font-weight:bold;letter-spacing:.2px;">Total Outbound Labor Hours <span style="opacity:.7;font-size:10px;font-weight:normal;">Needed</span></span>
            <span style="flex:none;min-width:56px;padding-left:10px;font-size:22px;font-weight:800;line-height:1;letter-spacing:-.5px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">${totalOutHrs.toLocaleString()}</span></div>`;
        card += `</div></div>`;
        return card;
    }
    let renderTimer = null;
    // SAFETY WRAPPER: never let a render exception silently freeze the panel (dead buttons).
    // If renderInner throws, show the error inline instead of aborting mid-repaint.
    function render() {
        // TYPING GUARD (v29.2, broadened v29.39): never re-render while the user is typing in ANY
        // input inside the panel — rebuilding innerHTML wipes the field mid-keystroke (the 'can't
        // type into the box' bug). Covers pick-volume AND every Settings input (rates, CPTs, divisors,
        // support hrs). It refreshes on blur/Enter or the next timer tick once focus leaves.
        try {
            const ae = document.activeElement;
            const panelEl = document.getElementById(PANEL_ID);
            if (ae && ae.tagName === 'INPUT' && panelEl && panelEl.contains(ae)) return;
        } catch (e) {}
        try {
            renderInner();
        } catch (err) {
            try {
                let panel = document.getElementById(PANEL_ID);
                if (!panel) { panel = document.createElement('div'); panel.id = PANEL_ID; document.body.appendChild(panel); }
                panel.style.cssText = 'position:fixed;top:70px;right:20px;z-index:99999;background:#fff;color:#b00020;border:2px solid #b00020;border-radius:8px;padding:10px 12px;font-family:Arial;font-size:12px;max-width:420px;box-shadow:0 4px 16px rgba(0,0,0,.25);';
                panel.innerHTML = '<b>MegaHelm render error</b><br>' + String(err && err.message ? err.message : err) +
                    '<br><span style="font-size:10px;color:#666;">(' + (err && err.stack ? String(err.stack).split('\n')[1] || '' : '') + ')</span>';
            } catch (e2) { /* last resort: swallow */ }
            console.error('[MegaHelm] render failed:', err);
        }
    }
    function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(render, 400); }

    function renderInner() {
        if (!location.hash.match(/pick-capacity-detail/)) { const p = document.getElementById(PANEL_ID); if (p) p.remove(); return; }
        if (!latestData) return;

        const rows = dedupe(parseWindows(latestData));
        const days = dayTotals(rows);
        const { totals, windows, daysRolled, rolledDate } = zoneAggAndWindows(rows);
        // Runway to the primary anchor CPT (Nights 09:15 / Days 20:15) for pickers-needed.
        // Use the anchor window's timestamp within the current shift set; hours = (anchorMs - now)/h.
        const anchorCptGlobal = ANCHOR_CPT[currentShift];
        const anchorWin = windows.filter(w => w.cpt === anchorCptGlobal).sort((a,b)=>a.ms-b.ms).pop();
        let runwayHours = null;
        if (anchorWin) runwayHours = (anchorWin.ms - Date.now()) / 3600000;
        if (runwayHours != null && runwayHours < 0.1) runwayHours = 0.1;  // floor to avoid div blowup

        let panel = document.getElementById(PANEL_ID);
        if (!panel) { panel = document.createElement('div'); panel.id = PANEL_ID; document.body.appendChild(panel); }
        const posCss = panelPos
            ? `top:${panelPos.top}px;left:${panelPos.left}px;right:auto;`
            : `top:70px;right:20px;left:auto;`;
        // FREE-RESIZE: when expanded, honor a user-set width/height (native corner resize).
        // Minimized always uses the compact fixed width. Default expanded = 440px auto-height.
        // ENLARGE SCALES TEXT TOO (v27.1): derive a zoom factor from the width preset so fonts,
        // bars, and spacing all grow proportionally — not just the panel box. zoom scales the whole
        // panel's rendering without breaking fixed positioning. Normal 440=1.0, Large 620=1.18, XL 820=1.35.
        // ZOOM LEVELS (v27.3): magnifier button cycles Original -> Larger -> Largest. zoom scales
        // ALL text/bars/spacing so snips are legible in public chats. Session-only (resets on refresh).
        const ZOOM_STEPS = [1.0, 1.25, 1.55];              // Original, Larger, Largest
        const ZOOM_WIDTHS = [470, 500, 530];               // base width per step (zoom amplifies it)
        const zl = Math.max(0, Math.min(panelZoomLevel || 0, ZOOM_STEPS.length - 1));
        const panelZoom = minimized ? 1 : ZOOM_STEPS[zl];
        const baseW = ZOOM_WIDTHS[zl];
        const sizeCss = minimized
            ? `width:320px;max-height:90vh;overflow:auto;resize:none;zoom:1;`
            : `width:${baseW}px;max-height:90vh;min-width:380px;overflow:auto;resize:none;zoom:${panelZoom};`;
        panel.style.cssText = `position:fixed;${posCss}z-index:99999;background:${C.bg};color:${C.txt};
            border:1px solid ${C.border};border-radius:8px;box-shadow:0 4px 16px rgba(9,30,66,.25);font-family:"Amazon Ember",Arial;${sizeCss}`;

        const site = siteCode();

        // ---- Header (no title — the tabs label the views) ----
        const stamp = lastUpdated ? new Intl.DateTimeFormat('en-US', { timeZone: tzName(), hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(lastUpdated)) : '—';
        // Credit line (from the shared team version) — shown when expanded.
        // LEFT: Last Update + 'Created by gabrerut' underneath (smaller). RIGHT: Settings (gear) left
        // of the magnifier, then minimize.
        const leftBlock = minimized
            ? `<div style="font-size:12px;color:${C.headTxt};font-weight:bold;">${site + ' \u00b7 Helm'}</div>`
            : `<div style="display:flex;flex-direction:column;line-height:1.15;">
                   <span style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:rgba(255,255,255,.9);font-weight:600;letter-spacing:.2px;">
                       ${site} \u00b7 Updated ${stamp} ET
                       <span class="mh-tip mh-tip-left" data-tip="${infoOpen ? 'Close Help' : 'How To Use'}"><button id="mh-info" style="background:${infoOpen ? 'rgba(255,255,255,.25)' : 'transparent'};color:#fff;border:none;border-radius:5px;font-size:13px;line-height:1;padding:1px 4px;cursor:pointer;opacity:${infoOpen ? '1' : '.8'};">\u2139\ufe0f</button></span>
                   </span>
                   <span style="font-size:7.5px;color:rgba(255,255,255,.4);font-weight:normal;white-space:nowrap;letter-spacing:.2px;">Created by gabrerut</span>
               </div>`;
        // Header icon buttons — crisper gear (emoji variation selector) + INSTANT custom tooltips
        // (native title= is slow/unreliable in the SPA overlay). Each button wrapped in .mh-tip[data-tip].
        const btnCss = 'border:none;border-radius:6px;font-size:16px;line-height:1;padding:3px 6px;cursor:pointer;opacity:.82;';
        const zoomLabel = ['Original','Larger','Largest'][(panelZoomLevel||0)] || 'Original';
        const gearBtn = minimized ? '' : `<span class="mh-tip" data-tip="${settingsOpen ? 'Close Settings' : 'Settings'}"><button id="mh-gear" style="background:${settingsOpen ? 'rgba(255,255,255,.22)' : 'transparent'};color:#fff;border:none;border-radius:6px;font-size:16px;line-height:1;padding:3px 6px;cursor:pointer;opacity:${settingsOpen ? '1' : '.82'};">\u2699\ufe0f</button></span>`;
        const sizeBtn = minimized ? '' : `<span class="mh-tip" data-tip="Zoom"><button id="mh-size" style="background:transparent;color:#fff;border:none;border-radius:6px;font-size:16px;line-height:1;padding:3px 6px;cursor:pointer;opacity:.82;">\ud83d\udd0d${(panelZoomLevel||0) ? '<span style=\"font-size:11px;font-weight:bold;\">'+'+'.repeat(panelZoomLevel)+'</span>' : ''}</button></span>`;
        const minBtn = `<span class="mh-tip" data-tip="${minimized ? 'Expand' : 'Minimize'}"><button id="mh-min" style="background:transparent;color:#fff;${btnCss}">${minimized ? '\u25a2' : '\u2014'}</button></span>`;
        let h = `<style>.mh-tip{position:relative;display:inline-flex;}.mh-tip::after{content:attr(data-tip);position:absolute;top:calc(100% + 6px);right:0;white-space:nowrap;background:#0b1f33;color:#fff;font-size:11px;font-weight:600;padding:4px 8px;border-radius:4px;box-shadow:0 2px 6px rgba(0,0,0,.35);opacity:0;pointer-events:none;transition:opacity .12s;z-index:100000;}.mh-tip:hover::after{opacity:1;}.mh-tip-left::after{left:0;right:auto;}</style>`;
        h += `<div id="mh-header" style="display:flex;justify-content:space-between;align-items:center;padding:7px 11px;background:${C.head};border-radius:8px 8px 0 0;position:sticky;top:0;cursor:move;">
            ${leftBlock}
            <div style="display:flex;align-items:center;gap:5px;">${gearBtn}${sizeBtn}${minBtn}</div>
            </div>`;

        if (!minimized) {
            // ---- ℹ️ HOW-TO / INSTRUCTIONS OVERLAY (v1.18) — click the ℹ️ button to open ----
            if (infoOpen) {
                const sec = (title) => `<div style="font-size:11px;font-weight:bold;color:${C.head};text-transform:uppercase;letter-spacing:.6px;margin:14px 0 5px;padding-bottom:3px;border-bottom:1px solid ${C.border};">${title}</div>`;
                const tRow = (a, b) => `<tr><td style="padding:4px 8px 4px 0;font-weight:600;color:${C.txt};vertical-align:top;white-space:nowrap;">${a}</td><td style="padding:4px 0;color:${C.txt};">${b}</td></tr>`;
                const tbl = (rowsHtml) => `<table style="width:100%;border-collapse:collapse;font-size:12px;line-height:1.45;">${rowsHtml}</table>`;
                h += `<div style="padding:16px 16px 18px;background:${C.bg};border-bottom:1px solid ${C.border};font-size:12px;color:${C.txt};line-height:1.55;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                        <span style="font-size:15px;font-weight:bold;color:${C.txt};">\ud83d\udce6 How To Use Outbound Labor Pilot</span>
                        <button id="mh-info-close" style="background:${C.head};color:#fff;border:none;border-radius:5px;font-size:11px;font-weight:bold;padding:5px 12px;cursor:pointer;">Close</button>
                    </div>
                    <div style="background:${C.card};border-left:3px solid ${C.head};border-radius:4px;padding:9px 11px;margin-bottom:4px;">
                        <b>Why this exists:</b> An effective, efficient Outbound planning tool that pulls from our sources (WLM + Helm) in real time \u2014 surfacing <b>every CPT at once</b> so you can plan the full board ahead instead of reacting as windows roll in.
                    </div>
                    ${sec('The three tabs')}
                    <div>\u2022 <b>Daily Totals</b> \u2014 units ordered / pickable / max capacity per day.</div>
                    <div style="margin-top:4px;">\u2022 <b>Pick Ahead By Zone</b> \u2014 units sold + unpicked per temp zone (Chilled, Ambient, Frozen, Bigs, Hv Bigs) and pickers needed per zone, for balanced staffing and clean handoff. Tap the big <b>UNPICKED</b> number for the zone summary.</div>
                    <div style="margin-top:4px;">\u2022 <b>Outbound Labor Plan</b> \u2014 full hourly plan: pickers per zone (direct) plus the OB Indirect planner (batchers, staging, handoff, slam + support). Tap <b>\ud83d\udce6 OUTBOUND LABOR PLAN</b> to open.</div>
                    ${sec('Where the numbers come from')}
                    ${tbl(
                        tRow('Pick volume', 'WLM / Labor Allocation (STORM), current hour \u2014 sizes pickers, staging, handoff, slam.') +
                        tRow('Batch volume', 'Helm \u2014 sizes batchers.')
                    )}
                    <div style="margin-top:4px;color:${C.mut};">Pulled automatically in the background \u2014 you do <b>not</b> need the Labor Allocation page open. Just be logged in on the network.</div><div style="margin-top:3px;color:${C.mut};">Planned volume needs a tweak? Click the Pick Volume box to override; \u201cuse plan\u201d reverts it.</div>
                    ${sec('Nights vs Days')}
                    <div>Use the <b>Nights / Days</b> toggle to switch boards. The panel auto-anchors to the shift in progress. Once a shift picks through its anchor (Days 20:15 / Nights 09:15), it rolls forward to that shift\u2019s next set of windows.</div>
                    ${sec('\u2699\ufe0f Make it your site (Settings)')}
                    <div style="margin-bottom:6px;">Nothing is hardcoded \u2014 open the <b>\u2699\ufe0f gear</b> and set your site\u2019s values:</div>
                    ${tbl(
                        tRow('Pack Rate tab', 'Planned UPH per zone + Shift Windows (your Shift Start / Shift End CPTs for Nights &amp; Days).') +
                        tRow('OB Indirect tab', 'Planning divisors (pick / batch / staging / handoff / slam), support hours, and batch window CPTs.')
                    )}
                    <div style="margin-top:6px;">Type your values \u2192 <b>Save</b>. Settings save to <i>your</i> browser, so <b>set them once</b>. <b>Reset defaults</b> restores UNJ2. Time zone auto-detects.</div>
                    ${sec('Other controls')}
                    <div>\u2022 \ud83d\udd0d zoom \u2014 clear snippets (Original / Larger / Largest)</div>
                    <div style="margin-top:2px;">\u2022 \u2014 minimize to hide the panel</div>
                    <div style="margin-top:2px;">\u2022 Drag the header to move it</div>
                    <div style="margin-top:2px;">\u2022 Zone dropdown \u2014 check any zones to show (multi-select); unchecking all restores every zone</div>
                </div>`;
            }
            // (Settings button moved into the header, left of the magnifier.)
            // ---- SETTINGS PANEL (rates + shift primary/anchor CPTs) ----
            if (settingsOpen) {
                h += `<div style="padding:12px;background:${C.card};border-bottom:1px solid ${C.border};">`;
                h += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-size:13px;font-weight:bold;color:${C.txt};">\ud83d\udce6 Outbound Labor Plan</span><button id="mh-set-close" style="background:${C.head};color:#fff;border:none;border-radius:5px;font-size:11px;font-weight:bold;padding:5px 12px;cursor:pointer;">Close</button></div>`;
                // Sub-tabs: Pack Rate | OB Indirect
                const setTab = (id,label) => `<button data-settab="${id}" style="flex:1;background:${settingsTab===id?C.head:C.card};color:${settingsTab===id?'#fff':C.txt};border:1px solid ${C.border};font-size:11px;font-weight:bold;padding:5px;cursor:pointer;">${label}</button>`;
                h += `<div style="display:flex;gap:0;margin-bottom:10px;border-radius:5px;overflow:hidden;">${setTab('rate','Pack Rate')}${setTab('obind','OB Indirect')}</div>`;
                if (settingsTab === 'rate') {
                // Time zone is AUTO-DETECTED from the browser (no selector needed). Show it read-only.
                h += `<div style="font-size:10px;color:${C.mut};margin-bottom:10px;">Time zone: <b>${tzName()}</b> <span style="opacity:.7;">(auto-detected)</span></div>`;
                // Planned rates per zone
                h += `<div style="font-size:11px;font-weight:bold;color:${C.mut};margin-bottom:4px;">Planned Pack Rate (UPH)</div>`;
                ZONES.forEach(z => {
                    h += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                        <span style="font-size:12px;color:${C.txt};">${z}</span>
                        <input type="text" inputmode="numeric" pattern="[0-9]*" data-rate-zone="${z}" value="${packRate(z)}" style="width:70px;font-size:12px;padding:3px 6px;border:1px solid ${C.border};border-radius:4px;text-align:right;"></div>`;
                });
                // Shift CPTs
                h += `<div style="font-size:11px;font-weight:bold;color:${C.mut};margin:10px 0 4px;">Shift Windows (Primary CPTs)</div>`;
                [['nights','Nights'],['days','Days']].forEach(([key,label]) => {
                    h += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:6px;">
                        <span style="font-size:12px;color:${C.txt};width:52px;">${label}</span>
                        <span style="font-size:10px;color:${C.mut};">Shift Start</span>
                        <input type="text" data-shift-start="${key}" value="${startCptFor(key)}" style="width:56px;font-size:12px;padding:3px 5px;border:1px solid ${C.border};border-radius:4px;text-align:center;">
                        <span style="font-size:10px;color:${C.mut};">Shift End</span>
                        <input type="text" data-shift-anchor="${key}" value="${anchorCptFor(key)}" style="width:56px;font-size:12px;padding:3px 5px;border:1px solid ${C.border};border-radius:4px;text-align:center;"></div>`;
                });
                } // end rate tab
                if (settingsTab === 'obind') {
                    // OB Indirect divisors
                    h += `<div style="font-size:11px;font-weight:bold;color:${C.mut};margin-bottom:4px;">OB Indirect Divisors (Vol \u00f7 N)</div>`;
                    [['pickers','Pick rate'],['batching','Batch rate'],['stage','Staging'],['handoff','Handoff'],['slam','Slam Standalone']].forEach(([k,label]) => {
                        h += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                            <span style="font-size:12px;color:${C.txt};">${label}</span>
                            <input type="text" inputmode="numeric" pattern="[0-9]*" data-obdiv="${k}" value="${obDiv(k)}" style="width:70px;font-size:12px;padding:3px 6px;border:1px solid ${C.border};border-radius:4px;text-align:right;"></div>`;
                    });
                    // Outbound Indirect Support (hours) — single inline row (no section header).
                    h += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                        <span style="font-size:12px;color:${C.txt};">Outbound Support (hrs)</span>
                        <input type="text" inputmode="decimal" data-obsupport="1" value="${obSupportHrs()}" style="width:70px;font-size:12px;padding:3px 6px;border:1px solid ${C.border};border-radius:4px;text-align:right;"></div>`;
                    // Batch schedule CPTs
                    h += `<div style="font-size:11px;font-weight:bold;color:${C.mut};margin:10px 0 4px;">Batch Window (CPTs)</div>`;
                    h += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;gap:6px;">
                        <span style="font-size:10px;color:${C.mut};">First Batch</span>
                        <input type="text" data-obfirst="1" value="${SETTINGS.obind.firstBatchCpt}" style="width:56px;font-size:12px;padding:3px 5px;border:1px solid ${C.border};border-radius:4px;text-align:center;">
                        <span style="font-size:10px;color:${C.mut};">Last Batch</span>
                        <input type="text" data-oblast="1" value="${SETTINGS.obind.lastBatchCpt}" style="width:56px;font-size:12px;padding:3px 5px;border:1px solid ${C.border};border-radius:4px;text-align:center;"></div>`;
                } // end obind tab
                // Actions
                h += `<div style="display:flex;gap:6px;margin-top:10px;">
                    <button id="mh-set-save" style="flex:1;background:${C.head};color:#fff;border:none;border-radius:4px;font-size:12px;font-weight:bold;padding:6px;cursor:pointer;">Save</button>
                    <button id="mh-set-reset" style="flex:1;background:#fff;color:${C.txt};border:1px solid ${C.border};border-radius:4px;font-size:12px;padding:6px;cursor:pointer;">Reset defaults</button>
                    </div>`;
                h += `</div>`;
            }
            // ---- Tab bar ----
            const tabBtn = (id, label) => `<button data-tab="${id}" style="flex:1;background:${activeTab === id ? C.tabActive : C.tabInactive};color:${activeTab === id ? '#fff' : C.txt};border:none;padding:8px 3px;font-size:10.5px;line-height:1.15;font-weight:${activeTab === id ? 'bold' : 'normal'};cursor:pointer;">${label}</button>`;
            h += `<div style="display:flex;border-bottom:1px solid ${C.border};">${tabBtn('day', 'Daily Totals')}${tabBtn('zone', 'Pick Ahead By Zone')}${tabBtn('plan', 'Outbound Labor Plan')}</div>`;

            h += `<div style="padding:12px;">`;

            if (activeTab === 'day') {
                // ===== FULL DAY TOTALS TAB =====
                // PREFER the DOM-scraped days (has ALL dates in the picker range). Fall back to
                // API-derived days only if the table scrape finds nothing.
                const scraped = scrapeTableDays();
                const scrapedKeys = Object.keys(scraped).filter(k => (scraped[k].ordered || 0) > 0).sort();
                const useScrape = scrapedKeys.length > 0;
                const srcDays = useScrape ? scraped : days;
                const dks = (useScrape ? scrapedKeys : orderedDayKeys(rows, days)).slice(0, MAX_DAYS);
                if (DEBUG) {
                    const apiKeys = Object.keys(days).sort();
                    const apiLine = apiKeys.map(k => `${k}: ${days[k].ordered.toLocaleString()}u`).join(', ') || '(none)';
                    const scLine  = scrapedKeys.map(k => `${k}: ${scraped[k].ordered.toLocaleString()}u`).join(', ') || '(none)';
                    // RAW payload probe: distinct weekday names + epoch-derived dates in latestData,
                    // and how many total window objects the API actually returned. Reveals whether
                    // the API carries any non-9/9 windows at all.
                    let rawDates = {}, rawDays = {}, rawN = 0;
                    (latestData || []).forEach(w => {
                        rawN++;
                        const mt = w.input_config && w.input_config.max_capacity && w.input_config.max_capacity.matcher;
                        if (!mt) return;
                        const pr = mt.split('.');
                        rawDays[pr[1] || '?'] = (rawDays[pr[1] || '?'] || 0) + 1;
                        const ms = parseInt(pr[3], 10);
                        let d = pr[1] || '?';
                        if (!isNaN(ms)) { try { d = new Intl.DateTimeFormat('en-CA',{timeZone: tzName(),year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ms)); } catch(e){} }
                        rawDates[d] = (rawDates[d] || 0) + 1;
                    });
                    const rdLine = Object.keys(rawDates).sort().map(k => `${k}:${rawDates[k]}`).join(' ') || '(none)';
                    const wdLine = Object.keys(rawDays).sort().map(k => `${k}:${rawDays[k]}`).join(' ') || '(none)';
                    // Also probe the DOM: how many <td> and [role=cell] and date-looking cells exist
                    const nTd = document.querySelectorAll('td').length;
                    const nCell = document.querySelectorAll('[role="cell"]').length;
                    let nDateCells = 0;
                    document.querySelectorAll('td,[role="cell"]').forEach(c => { if (isDateStr((c.textContent||'').trim())) nDateCells++; });
                    h += `<div style="font-size:10px;font-family:monospace;background:#fff8e1;border:1px solid ${C.amber};border-radius:4px;padding:6px;margin-bottom:8px;color:#5b4a00;line-height:1.4;">
                        <b>DEBUG</b><br>API days: ${apiLine}<br>Table days: ${scLine}<br>Using: ${useScrape ? 'TABLE' : 'API'}
                        <br>── raw payload ──<br>windows: ${rawN}<br>epoch-dates: ${rdLine}<br>weekday-names: ${wdLine}
                        <br>── DOM probe ──<br>td:${nTd} role=cell:${nCell} date-cells:${nDateCells}</div>`;
                }
                if (!dks.length) h += `<div style="font-size:12px;color:${C.mut};">Waiting for capacity data…</div>`;
                dks.forEach(d => {
                    const m = srcDays[d], pick = m.ordered - m.picked;
                    // tint by ordered vs max capacity (over cap = pink, tight = amber, headroom = green)
                    const head = m.maxCap - m.ordered;
                    const st = capStatus(head);
                    h += `<div style="background:${st.bg};border:1px solid ${C.border};border-left:4px solid ${st.edge};border-radius:5px;padding:10px;margin-bottom:8px;">
                        <div style="font-weight:bold;font-size:13px;margin-bottom:6px;color:${C.txt};">${d}</div>
                        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;"><span style="color:${C.mut}">Units Ordered</span><b>${m.ordered.toLocaleString()}</b></div>
                        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;"><span style="color:${C.mut}">Total Pickable</span><b>${pick.toLocaleString()}</b></div>
                        <div style="display:flex;justify-content:space-between;font-size:12px;"><span style="color:${C.mut}">Max Capacity</span><b>${m.maxCap.toLocaleString()}</b></div>
                    </div>`;
                });
            } else {
                // ===== SHARED HEADER (Plan + Zone tabs): unpicked total, shift toggle, zone summary =====
                // ===== then Plan tab appends the Outbound Labor Plan card; Zone tab appends per-zone bars =====
                const withData = ZONES.filter(z => totals[z].ordered > 0);   // v1.33: keep FIXED ZONES order (Chilled, Ambient, Frozen, Bigs, Hv Bigs) so Hv Bigs is always last — clean top-4 snip. (was: re-sorted by volume)
                if (DEBUG) {
                    // Per-window probe: window-total ordered vs zone-classified vs not_dropped.
                    // Reveals whether a window (e.g. 08:15) has units that are unclassified.
                    let rowsDbg = windows.map(w => {
                        const zoneO = ZONES.reduce((a, z) => a + w.zones[z].o, 0);
                        return `${w.cpt}: tot=${(w.dayOrdered||0).toLocaleString()} zone=${zoneO.toLocaleString()} nd=${(w.notDroppedO||0).toLocaleString()}`;
                    }).join('<br>');
                    h += `<div style="font-size:10px;font-family:monospace;background:#fff8e1;border:1px solid ${C.amber};border-radius:4px;padding:6px;margin-bottom:8px;color:#5b4a00;line-height:1.4;">
                        <b>DEBUG — in-shift windows (tot / zone-classified / not_dropped):</b><br>${rowsDbg || '(none)'}</div>`;
                }
                // Shift-total unpicked = sum of remaining across EVERY in-shift window x zone,
                // clamped at 0 per window. `windows` is the shiftWindow-filtered set, which for
                // Nights runs 19:00 -> D+1 09:16, so it INCLUDES the 09:15 anchor CPT (and the
                // 07:15/08:15 tail). Summing at the window level (not zone-net) guarantees the
                // 09:15 unpicked units always count, even if earlier windows were over-picked.
                let shiftUnpicked = 0;
                windows.forEach(w => ZONES.forEach(z => {
                    shiftUnpicked += Math.max(w.zones[z].o - w.zones[z].p, 0);
                }));
                // DIAG (v28.3): dates + CPT span being totaled — reveals a multi-day over-count.
                // Sort windows CHRONOLOGICALLY by ms so the range reads true across midnight.
                const winSorted = windows.filter(w => ZONES.reduce((a,z)=>a+Math.max(w.zones[z].o-w.zones[z].p,0),0) > 0).slice().sort((a,b) => a.ms - b.ms);
                const winDates = [...new Set(winSorted.map(w => w.date))].sort();
                const firstCpt = winSorted.length ? winSorted[0].cpt : '-';
                const lastCpt = winSorted.length ? winSorted[winSorted.length-1].cpt : '-';
                const remainingCpts = [...new Set(winSorted.map(w => w.cpt))];
                const winCount = remainingCpts.length;
                const winDiag = winCount + (winCount === 1 ? ' Remaining Window · ' : ' Remaining Windows · ') + firstCpt + '→' + lastCpt;
                // Title row: shift label + total unpicked sit together (left of the toggle button).
                // ROW 1: shift label (left) + Nights/Days toggle (right)
                h += `<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
                    <div>
                        <span style="font-size:16px;font-weight:bold;color:${C.txt};">${currentShift === 'nights' ? 'Nights' : 'Days'}</span>
                        <span class="mh-tip mh-tip-left" data-tip="${winDiag}" style="font-size:11px;color:${C.mut};margin-left:6px;letter-spacing:.3px;cursor:help;">${SETTINGS.shifts[currentShift].start}\u2192${SETTINGS.shifts[currentShift].anchor}</span>
                    </div>
                    <button id="mh-shift" style="background:${C.head};color:#fff;border:none;border-radius:4px;font-size:11px;padding:3px 11px;cursor:pointer;font-weight:bold;">${currentShift === 'nights' ? 'Nights' : 'Days'}</button>
                </div>`;
                // Per-tab summary behavior (v29.27): Plan tab ALWAYS shows the zone summary (part of
                // the page, no collapse); Zone tab uses the click toggle (default collapsed).
                const onPlan = activeTab === 'plan';
                const showSummary = summaryOpen;   // v29.35: Plan tab now toggles the summary too (matching button)
                // ROW 2: BIG unpicked number (bigger on 3-tab layout — no toggle button crowding it now, v29.26)
                h += `<div style="margin-bottom:12px;">
                    <div ${onPlan ? '' : 'id="mh-summary-toggle"'} class="${onPlan ? '' : 'mh-tip'}" ${onPlan ? '' : `data-tip="${summaryOpen ? 'Hide summary' : 'Expand for summary'}"`} style="${onPlan ? '' : 'cursor:pointer;'}user-select:none;display:inline-flex;align-items:baseline;gap:7px;">
                        <span style="font-size:44px;font-weight:900;color:${C.red};line-height:1;letter-spacing:-1px;text-shadow:0 1px 0 rgba(0,0,0,.06);">${shiftUnpicked.toLocaleString()}</span>
                        <span style="font-size:16px;color:${C.mut};text-transform:uppercase;letter-spacing:.6px;font-weight:bold;">unpicked</span>
                        ${onPlan ? '' : `<span style="font-size:16px;color:${C.head};font-weight:900;line-height:1;">${summaryOpen ? '\u25be' : '\u25b8'}</span>`}
                    </div>
                </div>`;
                // UNPICKED SUMMARY toggle button — matches the OUTBOUND LABOR PLAN button style (v29.35).
                // Click to expand/collapse the by-zone summary. Shown on both tabs now.
                if (onPlan) {   // full button only on the Plan tab; Zone tab uses the arrow on the number
                h += `<button id="mh-summary-toggle" style="width:100%;display:flex;justify-content:space-between;align-items:center;background:${summaryOpen ? C.head : C.card};color:${summaryOpen ? '#fff' : C.txt};border:1px solid ${summaryOpen ? C.head : C.border};border-radius:${summaryOpen ? '6px 6px 0 0' : '6px'};font-size:12.5px;font-weight:bold;letter-spacing:.3px;padding:9px 12px;cursor:pointer;margin-bottom:0;">
                        <span>\ud83d\udcca UNPICKED SUMMARY (BY ZONE)</span>
                        <span style="opacity:.7;font-size:13px;">${summaryOpen ? '\u25be' : '\u25b8'}</span></button>`;
                }
                // ---- EXPANDABLE ZONE SUMMARY (snip-friendly): per-zone unpicked + % + pickers + TOTAL ----
                if (showSummary) {
                    // v26.6: COUNT ALL PICKS AS REAL THROUGHPUT (removed the blanket SOS subtraction —
                    // shift-overlap/handoff picks are legitimate work, not something to hide).
                    // Per-zone: unpicked, PICKED (all picks counted), % picked, pickers, remaining cap.
                    const rowsHtml = ZONES.map(z => {
                        const o = totals[z].ordered, pk = totals[z].picked;
                        if (o <= 0) return null;                       // skip zones with no volume this shift
                        const unp = windows.reduce((a, w) => a + Math.max(w.zones[z].o - w.zones[z].p, 0), 0);
                        const pct = o ? Math.round(pk / o * 100) : 0;
                        const zr = packRate(z);
                        const pickers = (unp > 0 && runwayHours && runwayHours > 0) ? Math.ceil(unp / zr / runwayHours) : 0;
                        return { z, unp, picked: pk, pct, pickers };
                    }).filter(Boolean);
                    const totUnp = rowsHtml.reduce((a, r) => a + r.unp, 0);
                    const totPickedZ = rowsHtml.reduce((a, r) => a + r.picked, 0);
                    const totPickers = rowsHtml.reduce((a, r) => a + r.pickers, 0);
                    const totOrd = ZONES.reduce((a,z)=>a+totals[z].ordered,0);
                    const totPk  = totPickedZ;
                    const totPct = totOrd ? Math.round(totPk/totOrd*100) : 0;
                    const totRemCap = windows.reduce((a, w) => a + (typeof w.remCap === 'number' ? Math.max(w.remCap, 0) : 0), 0);

                    // ---- EXCESS PICK-AHEAD (v26.6): count by REAL CPT WINDOWS AHEAD, not clock hours. ----
                    // UNJ2 (and every site) has GAPS in the CPT timeline (e.g. no CPTs 22:15->02:15) and
                    // mid-mile CPTs that repeat. So "N windows ahead" is measured against the sorted list
                    // of DISTINCT CPTs THAT EXIST in the data — gaps auto-skip, duplicates collapse.
                    // Anchor = earliest window with unpicked units that is DUE by now (CPT ms <= now);
                    // if none is due yet, anchor to the shift's earliest window. Flag = units picked in
                    // windows more than AHEAD_LIMIT real CPTs beyond the anchor. Days=3 (dense CPTs, constant
                    // batching, no gaps). Nights=3 (gap-aware — the real-CPT sequence skips the 22:15->02:15 gap).
                    const AHEAD_LIMIT = currentShift === 'days' ? 2 : 3;   // Days=2 (dense, no gaps), Nights=3 (gap-aware)
                    const nowMs = Date.now();
                    // Distinct windows by CPT (mid-mile dedupe), chronological. Aggregate ordered/picked per CPT.
                    const byCpt = new Map();
                    windows.forEach(w => {
                        const key = w.cpt;
                        if (!byCpt.has(key)) byCpt.set(key, { cpt: w.cpt, ms: w.ms, ordered: 0, picked: 0 });
                        const e = byCpt.get(key);
                        e.ms = Math.min(e.ms, w.ms);   // earliest ms for this CPT
                        ZONES.forEach(z => { e.ordered += w.zones[z].o; e.picked += w.zones[z].p; });
                    });
                    const seq = [...byCpt.values()].sort((a, b) => a.ms - b.ms);   // real CPT sequence, gaps excluded
                    // Anchor index: earliest unfinished window due by now; else earliest unfinished; else 0.
                    let anchorIdx = seq.findIndex(w => (w.ordered - w.picked) > 0 && w.ms <= nowMs);
                    if (anchorIdx < 0) anchorIdx = seq.findIndex(w => (w.ordered - w.picked) > 0);
                    if (anchorIdx < 0) anchorIdx = 0;
                    // Excess pick-ahead = picks in windows more than AHEAD_LIMIT real CPTs past the anchor.
                    let aheadUnits = 0, aheadWins = [];
                    for (let k = anchorIdx + AHEAD_LIMIT + 1; k < seq.length; k++) {
                        if (seq[k].picked > 0) { aheadUnits += seq[k].picked; aheadWins.push(seq[k].cpt); }
                    }
                    const pickAhead = aheadUnits > 0;

                    let card = `<div style="border:1px solid ${C.border};border-radius:0 0 6px 6px;border-top:none;margin-bottom:10px;overflow:hidden;">`;
                    // PICK-AHEAD banner (only when it fires)
                    if (pickAhead) {
                        card += `<div style="background:#fff4e5;border-bottom:1px solid #e0a030;color:#8a5200;font-size:11px;font-weight:bold;padding:6px 10px;">⚠ ${aheadUnits.toLocaleString()} units are picked ${AHEAD_LIMIT}+ CPT windows ahead (${aheadWins.slice(0,3).join(', ')}${aheadWins.length>3?'…':''}). Consider an Inbound labor move.</div>`;
                    }
                    // Zone rows styled like the Outbound Labor Plan card: label + tiny context sub-line
                    // on the left, BIG right-aligned Unpicked number (red if remaining, green if clear). v29.35
                    card += `<div style="padding:2px 12px 4px;">`;
                    rowsHtml.forEach((r) => {
                        const unpColor = r.unp > 0 ? C.red : C.green;
                        card += `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid ${C.border};font-variant-numeric:tabular-nums;">
                            <span style="flex:1;min-width:0;line-height:1.2;"><span style="color:${C.txt};font-size:13.5px;font-weight:600;">${r.z}</span>
                                <span style="display:block;color:${C.mut};font-size:10px;margin-top:0px;">picked ${r.picked.toLocaleString()} \u00b7 ${r.pct}% \u00b7 ${r.pickers} picker${r.pickers===1?'':'s'}</span></span>
                            <span style="font-weight:800;color:${unpColor};font-size:19px;line-height:1;letter-spacing:-.3px;flex:none;min-width:56px;padding-left:10px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">${r.unp.toLocaleString()}</span></div>`;
                    });
                    card += `</div>`;
                    // TOTAL — prominent navy band with the big unpicked number (matches labor plan total).
                    card += `<div style="display:flex;justify-content:space-between;align-items:center;background:${C.head};color:#fff;padding:8px 12px;font-variant-numeric:tabular-nums;">
                        <span style="flex:1;min-width:0;line-height:1.2;"><span style="font-size:12.5px;font-weight:bold;letter-spacing:.2px;">TOTAL UNPICKED</span>
                            <span style="display:block;opacity:.7;font-size:10px;margin-top:1px;">picked ${totPickedZ.toLocaleString()} \u00b7 ${totPct}% \u00b7 ${totPickers} pickers</span></span>
                        <span style="font-size:22px;font-weight:800;line-height:1;letter-spacing:-.5px;flex:none;min-width:56px;padding-left:12px;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;">${totUnp.toLocaleString()}</span></div>`;
                    // REMAINING CAP footer
                    card += `<div style="display:flex;justify-content:space-between;font-size:11px;color:${C.mut};padding:6px 10px;border-top:1px solid ${C.border};">
                        <span>Total Remaining Capacity</span><span style="font-weight:bold;color:${C.head};">${totRemCap.toLocaleString()}</span></div>`;
                    // EXCESS PICK-AHEAD figure — separate from total picked (which stays whole). Only when > 0.
                    if (aheadUnits > 0) {
                        card += `<div style="display:flex;justify-content:space-between;font-size:11px;font-weight:bold;color:#8a5200;background:#fff4e5;padding:6px 10px;border-top:1px solid #e0a030;">
                            <span>Picked ${AHEAD_LIMIT}+ CPT windows ahead of the current active CPT</span><span>${aheadUnits.toLocaleString()} ⚠</span></div>`;
                    }
                    card += `</div>`;
                    h += card;
                }
                // OUTBOUND LABOR PLAN: on the Plan tab, show a toggle button (below the summary);
                // the labor plan card appears only when clicked (v29.32). Zone tab shows neither.
                if (activeTab === 'plan') {
                    h += `<button id="mh-obind-toggle" style="width:100%;display:flex;justify-content:space-between;align-items:center;background:${obindOpen ? C.head : C.card};color:${obindOpen ? '#fff' : C.txt};border:1px solid ${obindOpen ? C.head : C.border};border-radius:${obindOpen ? '6px 6px 0 0' : '6px'};font-size:12.5px;font-weight:bold;letter-spacing:.3px;padding:9px 12px;cursor:pointer;margin-bottom:0;">
                        <span>\ud83d\udce6 OUTBOUND LABOR PLAN</span>
                        <span style="opacity:.7;font-size:13px;">${obindOpen ? '\u25be' : '\u25b8'}</span></button>`;
                    if (obindOpen) { h += obindPlanHtml(rows); }
                }
                // ---- PER-ZONE BARS: only on the Pick Ahead By Zone tab (v29.26) ----
                if (activeTab === 'zone') {
                // ROLLED banner (v1.22): current shift's board is fully picked -> showing the next shift's windows.
                if (daysRolled) {
                    h += `<div style="background:${C.greenBg};border:1px solid ${C.green};border-radius:5px;padding:7px 10px;margin-bottom:10px;font-size:12px;color:#1c6b3a;font-weight:bold;">
                        ✓ ${currentShift === 'nights' ? 'Nights 09:15' : 'Days 20:15'} picked — showing NEXT ${currentShift === 'nights' ? 'NIGHTS' : 'DAY'}${rolledDate ? ' ' + rolledDate : ''} board (${SETTINGS.shifts[currentShift].start}→${SETTINGS.shifts[currentShift].anchor})</div>`;
                }
                // Zone filter DROPDOWN — collapses to one line; shows only the zones you care about.
                const selLabel = visibleZones.length === ZONES.length ? 'All zones'
                    : visibleZones.length === 0 ? 'No zones'
                    : visibleZones.length <= 2 ? visibleZones.join(', ')
                    : visibleZones.length + ' zones';
                h += `<div style="position:relative;margin-bottom:10px;display:inline-block;min-width:170px;">`;
                h += `<button id="mh-zonebtn" style="width:100%;text-align:left;background:${C.card};color:${C.txt};border:1px solid ${C.border};border-radius:5px;font-size:12px;padding:6px 10px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;">
                    <span>Zones: <b>${selLabel}</b></span><span style="opacity:.6;">${zoneMenuOpen ? '▲' : '▼'}</span></button>`;
                if (zoneMenuOpen) {
                    h += `<div style="position:relative;background:${C.bg};border:1px solid ${C.border};border-radius:5px;margin-top:4px;padding:5px;">`;
                    // Single 'Select All' toggle: checks all if not all-on, else clears all.
                    const allOn = visibleZones.length === ZONES.length;
                    h += `<button data-zone-toggle="1" style="width:100%;font-size:11px;font-weight:bold;padding:6px;cursor:pointer;background:${allOn ? C.head : C.card};color:${allOn ? '#fff' : C.txt};border:1px solid ${C.border};border-radius:4px;margin-bottom:4px;letter-spacing:.3px;">${allOn ? '✓ SELECT ALL' : 'SELECT ALL'}</button>`;
                    // Each zone is a clickable row. Click = ISOLATE to that zone (show only it).
                    // Sharper: bold rows, navy highlight on active, crisp dividers, hover affordance.
                    ZONES.forEach(z => {
                        const on = visibleZones.includes(z);
                        // MULTI-SELECT (v1.31): every SELECTED zone shows checked + light-green tint;
                        // unselected rows are neutral grey. No single-isolate highlight anymore.
                        const bg = on ? '#e4f4ea' : '#f4f5f7';
                        h += `<div data-zone="${z}" style="display:flex;align-items:center;justify-content:space-between;font-size:13px;font-weight:${on ? '700' : '600'};
                            color:${C.txt};background:${bg};
                            padding:8px 11px;cursor:pointer;border-radius:5px;margin-bottom:3px;border:1px solid ${on ? C.green : C.border};transition:background .1s;">
                            <span>${z}</span><span style="font-size:12px;font-weight:bold;color:${on ? C.green : C.mut};">${on ? '\u2713' : ''}</span></div>`;
                    });
                    h += `</div>`;
                }
                h += `</div>`;
                // Apply the filter to the rendered zone cards.
                const shownZones = withData.filter(z => visibleZones.includes(z));
                if (!withData.length) h += `<div style="font-size:12px;color:${C.mut};">No zone volume in this shift window.</div>`;
                else if (!shownZones.length) h += `<div style="font-size:12px;color:${C.mut};">No zones selected — check a box above.</div>`;
                shownZones.forEach(z => { h += `<div style="margin-bottom:8px;">${zoneSVG(z, totals[z], windows, runwayHours)}</div>`; });
                }  // end zone-only per-zone bars
            }
            h += `</div>`;
        }

        panel.innerHTML = h;
        // NOTE: toggle controls (min, tabs, gear, summary, obind, shift, zone) are handled by the
        // single delegated listener below (attached once). Only input-reading buttons kept direct.
        const saveBtn = document.getElementById('mh-set-save');
        if (saveBtn) saveBtn.onclick = () => {
            // Time zone is auto-detected (no input to read).
            // Read rate inputs
            panel.querySelectorAll('input[data-rate-zone]').forEach(inp => {
                const z = inp.getAttribute('data-rate-zone');
                const v = parseInt(inp.value, 10);
                if (!isNaN(v) && v > 0) SETTINGS.rates[z] = v;
            });
            // Read shift CPT inputs (validate HH:MM)
            // Valid CPT = HH:MM with hour 0-23 and minute 0-59 (rejects garbage / out-of-range).
            const cptOk = (t) => {
                const m = /^(\d{1,2}):(\d{2})$/.exec((t || '').trim());
                return !!m && +m[1] >= 0 && +m[1] <= 23 && +m[2] >= 0 && +m[2] <= 59;
            };
            panel.querySelectorAll('input[data-shift-start]').forEach(inp => {
                const k = inp.getAttribute('data-shift-start');
                if (cptOk(inp.value)) SETTINGS.shifts[k].start = inp.value.trim();
            });
            panel.querySelectorAll('input[data-shift-anchor]').forEach(inp => {
                const k = inp.getAttribute('data-shift-anchor');
                if (cptOk(inp.value)) SETTINGS.shifts[k].anchor = inp.value.trim();
            });
            // Read OB Indirect divisors
            if (!SETTINGS.obind) SETTINGS.obind = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS.obind));
            panel.querySelectorAll('input[data-obdiv]').forEach(inp => {
                const k = inp.getAttribute('data-obdiv');
                const v = parseInt(inp.value, 10);
                if (!isNaN(v) && v > 0) SETTINGS.obind.divisors[k] = v;
            });
            // Read batch schedule CPTs
            const obFirst = panel.querySelector('input[data-obfirst]');
            if (obFirst && cptOk(obFirst.value)) SETTINGS.obind.firstBatchCpt = obFirst.value.trim();
            const obLast = panel.querySelector('input[data-oblast]');
            if (obLast && cptOk(obLast.value)) SETTINGS.obind.lastBatchCpt = obLast.value.trim();
            const obSup = panel.querySelector('input[data-obsupport]');
            if (obSup) { const sv = parseFloat(obSup.value); if (!isNaN(sv) && sv >= 0) SETTINGS.obind.supportHrs = sv; }
            saveSettings();
            settingsOpen = false;
            render();
        };
        // Settings sub-tab switches — DELEGATED on the panel so it survives re-renders and never
        // points at a stale/detached node (root cause of 'sub-tab won't open'). Attached once.
        if (!panel.__mhDelegated) {
            panel.__mhDelegated = true;
            // ONE delegated click listener for ALL toggle controls — survives every re-render and
            // never points at a stale/detached node (root cause of 'button stopped working').
            panel.addEventListener('click', (e) => {
                const settab = e.target.closest('[data-settab]');
                if (settab && panel.contains(settab)) { settingsTab = settab.getAttribute('data-settab'); render(); return; }
                if (e.target.closest('#mh-obind-toggle')) { obindOpen = !obindOpen; render(); return; }
                if (e.target.closest('#mh-summary-toggle')) { summaryOpen = !summaryOpen; render(); return; }
                if (e.target.closest('#mh-info')) { infoOpen = !infoOpen; render(); return; }
                if (e.target.closest('#mh-info-close')) { infoOpen = false; render(); return; }
                if (e.target.closest('#mh-gear')) { settingsOpen = !settingsOpen; render(); return; }
                if (e.target.closest('#mh-set-close')) { settingsOpen = false; render(); return; }
                if (e.target.closest('#mh-size')) {
                    // Cycle zoom: Original(0) -> Larger(1) -> Largest(2) -> Original. Text scales each step.
                    panelZoomLevel = ((panelZoomLevel || 0) + 1) % 3;
                    render(); return;
                }
                if (e.target.closest('#mh-pickvol-clear')) { manualPickVol = 0; render(); return; }
                if (e.target.closest('#mh-min')) { minimized = !minimized; render(); return; }
                if (e.target.closest('#mh-shift')) { currentShift = currentShift === 'nights' ? 'days' : 'nights'; render(); return; }
                if (e.target.closest('#mh-zonebtn')) { zoneMenuOpen = !zoneMenuOpen; render(); return; }
                const tab = e.target.closest('[data-tab]');
                if (tab && panel.contains(tab)) { activeTab = tab.getAttribute('data-tab'); render(); return; }
                const ztog = e.target.closest('[data-zone-toggle]');
                if (ztog && panel.contains(ztog)) { visibleZones = (visibleZones.length === ZONES.length) ? [] : ZONES.slice(); zoneMenuOpen = false; saveVisibleZones(); render(); return; }
                const zrow = e.target.closest('[data-zone]');
                if (zrow && panel.contains(zrow)) {
                    // MULTI-SELECT (v1.31): click TOGGLES a zone in/out so you can view several at once.
                    // Keep the dropdown OPEN so you can check multiple zones in one go. Never allow zero
                    // (un-checking the last one restores all). Order follows ZONES for stable display.
                    const z = zrow.getAttribute('data-zone');
                    if (visibleZones.includes(z)) {
                        const next = visibleZones.filter(v => v !== z);
                        visibleZones = next.length ? next : ZONES.slice();   // never empty
                    } else {
                        visibleZones = ZONES.filter(v => visibleZones.includes(v) || v === z);   // add, keep ZONES order
                    }
                    saveVisibleZones(); render(); return;   // dropdown stays open for multi-pick
                }
            });
            // Delegated INPUT listener for the manual pick-volume field. Persist on each keystroke
            // WITHOUT a full re-render (which would blur/reset the field); re-render on blur/Enter
            // so the Pickers/Stage/Handoff/Slam rows update once the user is done typing.
            // Click/focus the box -> select-all so you can immediately type over the auto-filled number.
            panel.addEventListener('focusin', (e) => {
                const pv = e.target.closest('#mh-pickvol');
                if (pv) { try { pv.select(); } catch (e2) {} }
            });
            panel.addEventListener('input', (e) => {
                const pv = e.target.closest('#mh-pickvol');
                if (pv) { saveManualPickVol(pv.value); }   // save each keystroke; render is guarded (no focus steal)
            });
            panel.addEventListener('keydown', (e) => {
                const pv = e.target.closest('#mh-pickvol');
                if (pv && e.key === 'Enter') { e.preventDefault(); saveManualPickVol(pv.value); render(); }
            });
            panel.addEventListener('blur', (e) => {
                const pv = e.target.closest('#mh-pickvol');
                if (pv) { saveManualPickVol(pv.value); render(); }
            }, true);
        }
        const resetBtn = document.getElementById('mh-set-reset');
        if (resetBtn) resetBtn.onclick = () => { resetSettings(); render(); };
        // (shift toggle, zone dropdown, zone rows, select-all — all delegated above)

        // ---- Drag-to-move (header is the handle; ignore drags starting on the minimize button) ----
        const header = document.getElementById('mh-header');
        if (header) {
            header.onmousedown = (e) => {
                if (e.target.closest('#mh-min')) return;   // let the minimize button click normally
                e.preventDefault();
                const rect = panel.getBoundingClientRect();
                const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
                const onMove = (ev) => {
                    let top = ev.clientY - offY, left = ev.clientX - offX;
                    // keep it on-screen
                    top = Math.max(0, Math.min(top, window.innerHeight - 40));
                    left = Math.max(0, Math.min(left, window.innerWidth - 60));
                    panel.style.top = top + 'px';
                    panel.style.left = left + 'px';
                    panel.style.right = 'auto';
                    panelPos = { top, left };
                };
                const onUp = () => {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup', onUp);
                    savePanelPos();   // persist final position
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            };
        }
        // (Free drag-resize removed in v27.2 — the ⤡ button cycles Normal/Large/XL instead,
        //  which always returns to Normal so the panel can never get stuck oversized.)
    }

    window.addEventListener('hashchange', scheduleRender);
    // Recreate panel quickly if the SPA wipes it — SKIP while the tab is hidden (SAFEGUARD).
    setInterval(() => { if (!document.hidden && latestData && location.hash.match(/pick-capacity-detail/) && !document.getElementById(PANEL_ID)) render(); }, 3000);
    // Auto-refresh every 60s (like Helm). SAFEGUARD: skip while the tab is hidden so a backgrounded
    // Helm tab uses no idle CPU. On re-focus, visibilitychange (below) renders immediately.
    setInterval(() => { if (!document.hidden && location.hash.match(/pick-capacity-detail/)) render(); }, 60000);
    // SAFEGUARD: when the tab becomes visible again, refresh at once so a second-monitor glance
    // is never more than ~60s stale and focusing the tab shows current data instantly.
    document.addEventListener('visibilitychange', () => { if (!document.hidden && location.hash.match(/pick-capacity-detail/)) render(); });

    // DOM-table observer: the Daily Totals tab is scraped from the rendered table, which the API
    // interception can't see (API is current-day only). When Helm re-renders the table — e.g. you
    // change the date picker to include 9/10/9/11 — this fires a debounced render so scraped days
    // refresh promptly instead of waiting up to 60s.
    let domTimer = null;
    const domObserver = new MutationObserver(() => {
        if (!location.hash.match(/pick-capacity-detail/)) return;
        clearTimeout(domTimer);
        domTimer = setTimeout(render, 500);   // debounce bursty AntD virtual-scroll mutations
    });
    // FIX (v27.0): script runs at document-start, so document.body can be null here -> observe()
    // throws "Argument 1 is not an object". Wait until body exists before observing.
    function startDomObserver() {
        if (document.body) {
            try { domObserver.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
        } else {
            // body not ready yet — retry on DOMContentLoaded or a short poll.
            if (document.addEventListener) document.addEventListener('DOMContentLoaded', startDomObserver, { once: true });
            setTimeout(startDomObserver, 300);
        }
    }
    // AUTO-PULL trigger (v28.0): fetch the plan on load + every 5 min. Direct fetch works from Helm
    // (and the labor page) since the API host is credentialed/reachable. Falls back to cached value.
    // AUTO-PULL (v29.2): fetch the plan on load + every 5 min (dual-base, GMX-CORS-bypass).
    setTimeout(fetchLaborPlan, 1200);
    setInterval(fetchLaborPlan, 300000);
    startDomObserver();
})();
