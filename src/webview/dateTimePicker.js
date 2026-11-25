/*
 * Date and time picker — a 24-hour picker for a plain text input, shared by
 * the Data Viewer (filter row, cell editing, Query Builder tab), the join
 * dialog and the View Data variables form.
 *
 * `attachDateTimePicker(input, { kind, onCommit, allowEmpty, sqlLiteral })`
 * keeps the input a free text field and puts a calendar button next to it.
 * Typed text is read on Enter and blur: `2026-11-25`, `2026-11-25 10:39`,
 * `2026-11-25T10:39:15.123`, `25.11.2026 10:39`, `10:39` (today), `today` and
 * `now` become ISO text with a space (`2026-11-25 10:39`, seconds only when
 * typed); text that is no date keeps its value and gets an error mark. The
 * button opens a popover with a Monday-first month grid, ISO week numbers and,
 * for timestamps, 24-hour hour / minute (/ second) fields.
 *
 * Time zones: `now`, `today`, a bare time and the Now button use the
 * browser's local wall-clock time, and every value picked in the popover is
 * a wall-clock time too — all are written without an offset, so PostgreSQL
 * reads them in the session's TimeZone, the zone the grid shows values in.
 * An offset survives only when it was typed, or when the popover is confirmed
 * without changing the value it opened with. A date takes no offset.
 *
 * With `sqlLiteral` the input holds SQL (the Query Builder's value fields):
 * typed text is left alone and a picked value is written as a quoted literal.
 *
 * Load order: anywhere before its first use; it then offers
 * `window.DateTimePicker`. The pure helpers at the top need no DOM and are
 * exported for the tests. Events are wired with addEventListener (the
 * webviews' CSP blocks inline handlers) and the markup holds no user text.
 */
(function (root) {
    'use strict';

    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    const WEEKDAY_SHORT = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
    const WEEKDAY_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    // ===== Calendar arithmetic ===============================================

    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    function pad4(n) { return ('000' + n).slice(-4); }

    function isLeapYear(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }

    /** Days of month `m` (1–12) of year `y`. */
    function daysInMonth(y, m) {
        return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    }

    /** The month `delta` months after `m` (1–12) of `y`. */
    function addMonths(y, m, delta) {
        const index = y * 12 + (m - 1) + delta;
        const year = Math.floor(index / 12);
        return { y: year, m: index - year * 12 + 1 };
    }

    /** The day `delta` days after `y-m-d`; years below 100 stay what they are. */
    function addDays(y, m, d, delta) {
        const t = new Date(0);
        t.setUTCFullYear(y, m - 1, d + delta);
        return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
    }

    /** 0 for Monday … 6 for Sunday. */
    function weekdayIndex(y, m, d) {
        const t = new Date(0);
        t.setUTCFullYear(y, m - 1, d);
        return (t.getUTCDay() + 6) % 7;
    }

    function dayOfYear(y, m, d) {
        let n = d;
        for (let i = 1; i < m; i++) n += daysInMonth(y, i);
        return n;
    }

    /** ISO 8601 week number: weeks start on Monday, week 1 holds the year's first Thursday. */
    function isoWeek(y, m, d) {
        const thursday = addDays(y, m, d, 3 - weekdayIndex(y, m, d));
        return Math.floor((dayOfYear(thursday.y, thursday.m, thursday.d) - 1) / 7) + 1;
    }

    /** Six weeks of seven days, Monday first, around month `m` (1–12) of `y`. */
    function monthGrid(y, m) {
        const start = addDays(y, m, 1, -weekdayIndex(y, m, 1));
        const weeks = [];
        for (let w = 0; w < 6; w++) {
            const week = [];
            for (let i = 0; i < 7; i++) {
                const day = addDays(start.y, start.m, start.d, w * 7 + i);
                week.push({ y: day.y, m: day.m, d: day.d, inMonth: day.y === y && day.m === m });
            }
            weeks.push(week);
        }
        return weeks;
    }

    // ===== Text ==============================================================

    /**
     * `{ y, m, d, hh, mm, ss, frac, tz }` as ISO text with a space. A date
     * gives `YYYY-MM-DD`; a timestamp adds `HH:MM` when `hh` is set, the
     * seconds (and their fraction) only when `ss` is set, then the time zone
     * as given (`+01`, `Z`).
     */
    function formatDateTime(parts, kind) {
        const p = parts || {};
        const date = pad4(p.y) + '-' + pad2(p.m) + '-' + pad2(p.d);
        if (kind === 'date' || p.hh == null) return date;
        let time = pad2(p.hh) + ':' + pad2(p.mm || 0);
        if (p.ss != null) time += ':' + pad2(p.ss) + (p.frac || '');
        return date + ' ' + time + (p.tz || '');
    }

    const DATE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})/;
    const DATE_DOTTED = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/;
    const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?(Z|\s*[+-]\d{2}(?::?\d{2})?)?$/i;

    function hint(kind) {
        return kind === 'date'
            ? 'Type a date as YYYY-MM-DD or DD.MM.YYYY.'
            : 'Type a date and time as YYYY-MM-DD HH:MM (24-hour), DD.MM.YYYY HH:MM or HH:MM for today.';
    }

    function todayParts(now) {
        return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
    }

    /** `{ hh, mm, ss, frac, tz }` of a time text, `{ error }`, or null when it is no time at all. */
    function parseTime(text) {
        const t = TIME.exec(text);
        if (!t) return null;
        const hh = Number(t[1]), mm = Number(t[2]), ss = t[3] === undefined ? null : Number(t[3]);
        if (hh > 23) return { error: 'Hours run from 00 to 23.' };
        if (mm > 59) return { error: 'Minutes run from 00 to 59.' };
        if (ss !== null && ss > 59) return { error: 'Seconds run from 00 to 59.' };
        return { hh, mm, ss, frac: ss === null ? '' : (t[4] || ''), tz: (t[5] || '').trim() };
    }

    /**
     * Read what the user typed. `kind` is `'date'` or `'timestamp'`; `now`
     * (default: the current time) resolves `today`, `now` and a bare time.
     * Returns `{ value, parts }` — `value` is ISO text with a space and
     * `parts` its pieces (`hh` null when no time was typed); `{ value: '' }`
     * for empty text; `{ value: 'infinity' }` for ±infinity; or `{ error }`.
     */
    function parseDateTimeInput(text, kind, now) {
        const k = kind === 'date' ? 'date' : 'timestamp';
        const clock = now instanceof Date ? now : new Date();
        const s = String(text == null ? '' : text).trim();
        if (!s) return { value: '', parts: null };
        const lower = s.toLowerCase();
        if (lower === 'infinity' || lower === '-infinity' || lower === '+infinity') {
            return { value: lower.replace('+', ''), parts: null };
        }
        const done = parts => ({ value: formatDateTime(parts, k), parts: k === 'date' ? Object.assign(parts, { hh: null }) : parts });
        const blank = { hh: null, mm: null, ss: null, frac: '', tz: '' };
        if (lower === 'today') return done(Object.assign(todayParts(clock), blank));
        if (lower === 'now') {
            return done(Object.assign(todayParts(clock), blank, { hh: clock.getHours(), mm: clock.getMinutes() }));
        }

        let y, m, d, rest;
        const iso = DATE_ISO.exec(s);
        const dotted = iso ? null : DATE_DOTTED.exec(s);
        if (iso) {
            y = Number(iso[1]); m = Number(iso[2]); d = Number(iso[3]);
            rest = s.slice(iso[0].length);
        } else if (dotted) {
            y = Number(dotted[3]); m = Number(dotted[2]); d = Number(dotted[1]);
            rest = s.slice(dotted[0].length);
        } else {
            const timeOnly = parseTime(s);
            if (!timeOnly) return { error: hint(k) };
            if (timeOnly.error) return timeOnly;
            if (k === 'date') return { error: 'A date needs a day: ' + hint(k).charAt(0).toLowerCase() + hint(k).slice(1) };
            return done(Object.assign(todayParts(clock), timeOnly));
        }

        let time = Object.assign({}, blank);
        if (rest) {
            const sep = /^(?:T|\s+)(.+)$/i.exec(rest);
            const parsed = sep ? parseTime(sep[1].trim()) : null;
            if (!parsed) return { error: hint(k) };
            if (parsed.error) return parsed;
            if (k === 'date' && parsed.tz) return { error: 'A date takes no time zone offset: ' + hint(k).charAt(0).toLowerCase() + hint(k).slice(1) };
            time = parsed;
        }
        if (y < 1) return { error: 'There is no year 0000.' };
        if (m < 1 || m > 12) return { error: 'Months run from 01 to 12.' };
        if (d < 1 || d > daysInMonth(y, m)) {
            return { error: MONTH_NAMES[m - 1] + ' ' + pad4(y) + ' has ' + daysInMonth(y, m) + ' days.' };
        }
        return done(Object.assign({ y, m, d }, time));
    }

    function sameWallClock(a, b) {
        const ss = p => (p.ss == null ? null : p.ss);
        return a.y === b.y && a.m === b.m && a.d === b.d && a.hh === b.hh && (a.mm || 0) === (b.mm || 0) &&
            ss(a) === ss(b) && (a.frac || '') === (b.frac || '');
    }

    /**
     * The text the popover writes for the wall-clock `parts` picked. A new
     * value carries no offset, so PostgreSQL reads it in the session time zone
     * (an offset taken over from the opening value would name the wrong instant
     * across a DST change or in another zone). Only an unchanged value keeps
     * the offset of `original`, the parsed opening value.
     */
    function pickedDateTime(parts, original, kind) {
        const wall = Object.assign({}, parts, { tz: '' });
        if (kind !== 'date' && original && original.tz && sameWallClock(wall, original)) return formatDateTime(original, kind);
        return formatDateTime(wall, kind);
    }

    /** The browser's local wall-clock time `clock` without an offset (the Now / Today button). */
    function nowDateTime(clock, kind, withSeconds) {
        return formatDateTime({
            y: clock.getFullYear(), m: clock.getMonth() + 1, d: clock.getDate(),
            hh: kind === 'date' ? null : clock.getHours(), mm: clock.getMinutes(), ss: withSeconds ? clock.getSeconds() : null
        }, kind);
    }

    // ===== Markup ============================================================

    function icon(name) {
        return '<svg class="ico" aria-hidden="true"><use href="#icon-' + name + '"/></svg>';
    }

    function sameDay(a, b) { return !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d; }

    function daysHtml(sel, today) {
        return monthGrid(sel.y, sel.m).map(week => {
            const monday = week[0];
            let row = '<tr><th scope="row" class="dtp-wk">' + isoWeek(monday.y, monday.m, monday.d) + '</th>';
            week.forEach((day, i) => {
                const selected = sameDay(day, sel);
                const cls = 'dtp-day' + (day.inMonth ? '' : ' dtp-out') + (sameDay(day, today) ? ' dtp-today' : '') +
                    (selected ? ' dtp-selected' : '');
                row += '<td role="gridcell" aria-selected="' + selected + '"><button type="button" class="' + cls + '"' +
                    ' data-dtp="day" data-y="' + day.y + '" data-m="' + day.m + '" data-d="' + day.d + '"' +
                    ' tabindex="' + (selected ? '0' : '-1') + '"' + (sameDay(day, today) ? ' aria-current="date"' : '') +
                    ' aria-label="' + WEEKDAY_LONG[i] + ', ' + day.d + ' ' + MONTH_NAMES[day.m - 1] + ' ' + pad4(day.y) + '">' +
                    day.d + '</button></td>';
            });
            return row + '</tr>';
        }).join('');
    }

    function timeField(role, label) {
        return '<input type="text" class="dtp-tf" data-dtp="' + role + '" maxlength="2" inputmode="numeric" autocomplete="off"' +
            ' aria-label="' + label + '" title="' + label + ' — Up/Down or the mouse wheel step it">';
    }

    function popoverHtml(kind, allowEmpty) {
        const ts = kind !== 'date';
        let html = '<div class="dtp-head">' +
            '<button type="button" class="btn btn-ghost btn-sm btn-icon" data-dtp="prev" title="Previous month (Page Up)">' + icon('chevron-left') + '</button>' +
            '<select class="dtp-month" data-dtp="month" aria-label="Month">' +
            MONTH_NAMES.map((name, i) => '<option value="' + (i + 1) + '">' + name + '</option>').join('') + '</select>' +
            '<input type="text" class="dtp-year" data-dtp="year" maxlength="4" inputmode="numeric" autocomplete="off" aria-label="Year"' +
            ' title="Year — Up/Down or the mouse wheel step it, Shift+Page Up/Down too">' +
            '<button type="button" class="btn btn-ghost btn-sm btn-icon" data-dtp="next" title="Next month (Page Down)">' + icon('chevron-right') + '</button>' +
            '</div>' +
            '<table class="dtp-grid" role="grid"><thead><tr><th scope="col" class="dtp-wk" title="ISO week number">Wk</th>' +
            WEEKDAY_SHORT.map((w, i) => '<th scope="col" abbr="' + WEEKDAY_LONG[i] + '">' + w + '</th>').join('') +
            '</tr></thead><tbody data-dtp="days"></tbody></table>';
        if (ts) {
            html += '<div class="dtp-time" role="group" aria-label="Time, 24-hour">' +
                '<span class="dtp-time-label">Time</span>' + timeField('hh', 'Hour (00–23)') +
                '<span class="dtp-colon">:</span>' + timeField('mm', 'Minute (00–59)') +
                '<span class="dtp-colon dtp-sec">:</span>' + timeField('ss', 'Second (00–59)') +
                '<label class="dtp-sec-toggle" title="Show the seconds"><input type="checkbox" data-dtp="seconds">Seconds</label>' +
                '</div>';
        }
        html += '<div class="dtp-foot">' +
            (ts
                ? '<button type="button" class="btn btn-sm" data-dtp="today" title="Use the current date and time">' + icon('history') + 'Now</button>'
                : '<button type="button" class="btn btn-sm" data-dtp="today" title="Use today">' + icon('calendar') + 'Today</button>') +
            (allowEmpty ? '<button type="button" class="btn btn-sm" data-dtp="clear" title="Empty the field">' + icon('close') + 'Clear</button>' : '') +
            '<span class="dtp-spacer"></span>' +
            '<button type="button" class="btn btn-sm btn-primary" data-dtp="ok" title="Use this ' + (ts ? 'date and time' : 'date') + ' (Enter)">' +
            icon('check') + 'OK</button></div>';
        return html;
    }

    // ===== Component =========================================================

    // ===== Popover ===========================================================

    let openHandle = null;

    /** The first quoted string of SQL text (`'2026-11-25'`, `TIMESTAMP '…'`, `'…'::date`), else the text. */
    function literalText(text) {
        const m = /'((?:[^']|'')*)'/.exec(String(text || ''));
        return m ? m[1].replace(/''/g, "'") : String(text || '');
    }

    /** True when `node` lies inside an open picker popover (for blur handlers that must not end an edit). */
    function isInsidePicker(node) {
        return !!(node && node.closest && node.closest('.dtp-popover'));
    }

    const FIELD_MAX = { hh: 23, mm: 59, ss: 59 };
    const NEXT_FIELD = { hh: 'mm', mm: 'ss' };

    /**
     * Open the calendar popover under (or, without room, above) `config.anchors`.
     * Only one popover is open at a time. The choice goes to `onChoose` after the
     * popover closed and the focus went back to `focusTarget`; Esc and a click
     * elsewhere close it without a choice.
     */
    function openPopover(config) {
        if (openHandle) openHandle.close(false);
        const kind = config.kind === 'date' ? 'date' : 'timestamp';
        const ts = kind === 'timestamp';
        const anchors = config.anchors;
        const ignore = config.ignore || [];
        const doc = anchors[0].ownerDocument || document;
        const win = doc.defaultView || root;
        const now = new Date();
        const p = parseDateTimeInput(config.text, kind, now).parts;
        const state = {
            sel: p ? { y: p.y, m: p.m, d: p.d } : todayParts(now),
            today: todayParts(now),
            hh: p && p.hh != null ? p.hh : 0,
            mm: p && p.mm != null ? p.mm : 0,
            ss: p && p.ss != null ? p.ss : 0,
            frac: p ? p.frac || '' : '',
            seconds: !!(p && p.ss != null)
        };

        const pop = doc.createElement('div');
        pop.className = 'dtp-popover';
        pop.setAttribute('role', 'dialog');
        pop.setAttribute('aria-label', ts ? 'Pick a date and time' : 'Pick a date');
        pop.innerHTML = popoverHtml(kind, config.allowEmpty !== false);

        const q = role => pop.querySelector('[data-dtp="' + role + '"]');
        let closed = false;

        function renderDays(focus) {
            q('days').innerHTML = daysHtml(state.sel, state.today);
            q('month').value = String(state.sel.m);
            const year = q('year');
            if (doc.activeElement !== year) year.value = pad4(state.sel.y);
            pop.querySelector('.dtp-grid').setAttribute('aria-label', MONTH_NAMES[state.sel.m - 1] + ' ' + pad4(state.sel.y));
            if (focus) {
                const day = pop.querySelector('.dtp-selected');
                if (day) day.focus();
            }
        }

        function renderTime() {
            if (!ts) return;
            q('hh').value = pad2(state.hh);
            q('mm').value = pad2(state.mm);
            q('ss').value = pad2(state.ss);
            q('seconds').checked = state.seconds;
            pop.classList.toggle('dtp-with-seconds', state.seconds);
        }

        function select(day, focus) {
            const y = Math.min(9999, Math.max(1, day.y));
            state.sel = { y, m: day.m, d: Math.min(day.d, daysInMonth(y, day.m)) };
            renderDays(focus);
        }

        function moveMonths(delta, focus) {
            const t = addMonths(state.sel.y, state.sel.m, delta);
            select({ y: t.y, m: t.m, d: state.sel.d }, focus);
        }

        function readTimeFields() {
            if (!ts) return;
            ['hh', 'mm', 'ss'].forEach(role => {
                const n = parseInt(q(role).value, 10);
                const v = isNaN(n) ? 0 : Math.min(FIELD_MAX[role], Math.max(0, n));
                if (role === 'ss' && v !== state.ss) state.frac = '';
                state[role] = v;
            });
        }

        function finish(value) {
            close(true);
            if (typeof config.onChoose === 'function') config.onChoose(value);
        }

        function commit() {
            readTimeFields();
            finish(pickedDateTime({
                y: state.sel.y, m: state.sel.m, d: state.sel.d,
                hh: ts ? state.hh : null, mm: state.mm,
                ss: state.seconds ? state.ss : null, frac: state.seconds ? state.frac : ''
            }, p, kind));
        }

        function stepField(el, delta) {
            const role = el.dataset.dtp;
            if (role === 'year') {
                const n = parseInt(el.value, 10);
                select({ y: (isNaN(n) ? state.sel.y : n) + delta, m: state.sel.m, d: state.sel.d }, false);
                el.value = pad4(state.sel.y);
                return;
            }
            const max = FIELD_MAX[role];
            const n = parseInt(el.value, 10);
            const v = ((isNaN(n) ? 0 : n) + delta + max + 1) % (max + 1);
            el.value = pad2(v);
            if (role === 'ss') state.frac = '';
            state[role] = v;
            el.select();
        }

        function onInput(e) {
            const el = e.target;
            const role = el.dataset.dtp;
            if (role === 'year') {
                el.value = el.value.replace(/\D/g, '');
                const n = parseInt(el.value, 10);
                if (el.value.length === 4 && n >= 1) select({ y: n, m: state.sel.m, d: state.sel.d }, false);
            } else if (FIELD_MAX[role] !== undefined) {
                el.value = el.value.replace(/\D/g, '').slice(0, 2);
                if (el.value.length === 2) {
                    el.value = pad2(Math.min(FIELD_MAX[role], Number(el.value)));
                    // Two digits typed: on to the next field, as in a time field of a form.
                    const next = NEXT_FIELD[role] && (role !== 'mm' || state.seconds) ? q(NEXT_FIELD[role]) : null;
                    if (next) { next.focus(); next.select(); }
                }
            }
        }

        function onChange(e) {
            const el = e.target;
            const role = el.dataset.dtp;
            if (role === 'month') {
                select({ y: state.sel.y, m: Number(el.value), d: state.sel.d }, false);
            } else if (role === 'year') {
                const n = parseInt(el.value, 10);
                if (n >= 1) select({ y: n, m: state.sel.m, d: state.sel.d }, false);
                el.value = pad4(state.sel.y);
            } else if (role === 'seconds') {
                readTimeFields();
                state.seconds = el.checked;
                if (!state.seconds) { state.ss = 0; state.frac = ''; }
                renderTime();
            }
        }

        function onFocusOut(e) {
            const el = e.target;
            if (el.dataset && FIELD_MAX[el.dataset.dtp] !== undefined) {
                readTimeFields();
                el.value = pad2(state[el.dataset.dtp]);
            }
        }

        function onClick(e) {
            const el = e.target.closest ? e.target.closest('[data-dtp]') : null;
            if (!el || !pop.contains(el)) return;
            const role = el.dataset.dtp;
            if (role === 'day') {
                select({ y: Number(el.dataset.y), m: Number(el.dataset.m), d: Number(el.dataset.d) }, true);
                if (!ts) commit();
            } else if (role === 'prev') {
                moveMonths(-1, false);
            } else if (role === 'next') {
                moveMonths(1, false);
            } else if (role === 'today') {
                finish(nowDateTime(new Date(), kind, state.seconds));
            } else if (role === 'clear') {
                finish('');
            } else if (role === 'ok') {
                commit();
            }
        }

        function onDblClick(e) {
            const el = e.target.closest ? e.target.closest('[data-dtp="day"]') : null;
            if (el && ts) commit();
        }

        function onWheel(e) {
            const el = e.target;
            const role = el.dataset && el.dataset.dtp;
            if (role !== 'year' && FIELD_MAX[role] === undefined) return;
            e.preventDefault();
            if (e.deltaY) stepField(el, e.deltaY < 0 ? 1 : -1);
        }

        function focusables() {
            return Array.from(pop.querySelectorAll('button, input, select'))
                .filter(el => !el.disabled && el.getClientRects().length > 0 &&
                    (el.dataset.dtp !== 'day' || el.classList.contains('dtp-selected')));
        }

        function onKeyDown(e) {
            // Nothing typed in the popover reaches the page (Enter would run a form, Esc cancel it).
            e.stopPropagation();
            const el = e.target;
            const role = el.dataset ? el.dataset.dtp : '';
            if (e.key === 'Escape') {
                e.preventDefault();
                close(true);
                return;
            }
            if (e.key === 'Tab') {
                const list = focusables();
                const i = list.indexOf(el);
                const next = list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length];
                if (next) { e.preventDefault(); next.focus(); }
                return;
            }
            if (role === 'day') {
                const s = state.sel;
                const wd = weekdayIndex(s.y, s.m, s.d);
                const moves = {
                    ArrowLeft: () => select(addDays(s.y, s.m, s.d, -1), true),
                    ArrowRight: () => select(addDays(s.y, s.m, s.d, 1), true),
                    ArrowUp: () => select(addDays(s.y, s.m, s.d, -7), true),
                    ArrowDown: () => select(addDays(s.y, s.m, s.d, 7), true),
                    Home: () => select(addDays(s.y, s.m, s.d, -wd), true),
                    End: () => select(addDays(s.y, s.m, s.d, 6 - wd), true),
                    PageUp: () => moveMonths(e.shiftKey ? -12 : -1, true),
                    PageDown: () => moveMonths(e.shiftKey ? 12 : 1, true),
                    Enter: () => commit(),
                    ' ': () => { if (!ts) commit(); }
                };
                if (moves[e.key]) { e.preventDefault(); moves[e.key](); }
                return;
            }
            if (role === 'year' || FIELD_MAX[role] !== undefined) {
                if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                    e.preventDefault();
                    stepField(el, e.key === 'ArrowUp' ? 1 : -1);
                    return;
                }
                if (role === 'year' && (e.key === 'PageUp' || e.key === 'PageDown')) {
                    e.preventDefault();
                    stepField(el, e.key === 'PageUp' ? 1 : -1);
                    return;
                }
            }
            if (e.key === 'Enter' && el.tagName !== 'BUTTON') {
                e.preventDefault();
                if (role === 'year') onChange(e);
                commit();
            }
        }

        function onOutsideDown(e) {
            const t = e.target;
            if (pop.contains(t) || ignore.some(el => el && (el === t || el.contains(t)))) return;
            close(false);
        }

        function position() {
            const rects = anchors.filter(Boolean).map(a => a.getBoundingClientRect());
            const top = Math.min.apply(null, rects.map(r => r.top));
            const bottom = Math.max.apply(null, rects.map(r => r.bottom));
            const vw = doc.documentElement.clientWidth;
            const vh = doc.documentElement.clientHeight;
            const w = pop.offsetWidth;
            const h = pop.offsetHeight;
            let y = bottom + 2;
            const above = y + h > vh - 4 && top - h - 2 >= 4;
            if (above) y = top - h - 2;
            else y = Math.max(4, Math.min(y, vh - h - 4));
            const x = Math.max(4, Math.min(rects[0].left, vw - w - 4));
            pop.style.setProperty('--dtp-top', y + 'px');
            pop.style.setProperty('--dtp-left', x + 'px');
            pop.classList.toggle('dtp-above', above);
        }

        const listeners = [
            ['click', onClick], ['dblclick', onDblClick], ['keydown', onKeyDown], ['input', onInput],
            ['change', onChange], ['focusout', onFocusOut]
        ];

        function close(restoreFocus) {
            if (closed) return;
            closed = true;
            const hadFocus = pop.contains(doc.activeElement);
            doc.removeEventListener('mousedown', onOutsideDown, true);
            doc.removeEventListener('scroll', position, true);
            win.removeEventListener('resize', position);
            pop.remove();
            if (openHandle === handle) openHandle = null;
            if ((restoreFocus || hadFocus) && config.focusTarget) config.focusTarget.focus();
            if (typeof config.onClose === 'function') config.onClose();
        }

        listeners.forEach(l => pop.addEventListener(l[0], l[1]));
        pop.addEventListener('wheel', onWheel, { passive: false });
        doc.body.appendChild(pop);
        renderTime();
        renderDays(false);
        position();
        doc.addEventListener('mousedown', onOutsideDown, true);
        doc.addEventListener('scroll', position, true);
        win.addEventListener('resize', position);

        const handle = { element: pop, close, isOpen: () => !closed };
        openHandle = handle;
        const day = pop.querySelector('.dtp-selected');
        if (day) day.focus();
        return handle;
    }

    /**
     * Open the popover for an element that is no text input — a grid cell in
     * edit mode. `value` preselects the day and time; `onPick(text)` gets the
     * chosen ISO text ('' for Clear) after the focus went back to `focusTarget`
     * (default: `anchor`); `onClose` runs however the popover closes.
     *
     * @param {HTMLElement} anchor
     * @param {{ kind?: 'date'|'timestamp', value?: string, allowEmpty?: boolean, focusTarget?: HTMLElement,
     *   ignore?: HTMLElement[], onPick?: (value: string) => void, onClose?: () => void }} [options]
     * @returns {{ close(restoreFocus?: boolean): void, isOpen(): boolean, element: HTMLElement }}
     */
    function openDateTimePopover(anchor, options) {
        const o = options || {};
        return openPopover({
            anchors: [anchor], focusTarget: o.focusTarget || anchor, kind: o.kind, allowEmpty: o.allowEmpty,
            text: o.value, ignore: o.ignore, onChoose: o.onPick, onClose: o.onClose
        });
    }

    // ===== Text input ========================================================

    /**
     * Give a text input a date or timestamp picker.
     *
     * @param {HTMLInputElement} input
     * @param {{ kind?: 'date'|'timestamp', allowEmpty?: boolean, sqlLiteral?: boolean,
     *   onCommit?: (value: string, how: 'typed'|'picker') => void }} [options]
     *   `onCommit` fires with the ISO text (or '') after a valid Enter / blur
     *   and after every choice in the popover; never with text that is no date.
     *   A value the picker writes also fires bubbling `input` and `change` events.
     * @returns {{ open(): void, close(restoreFocus?: boolean): void, isOpen(): boolean, destroy(): void,
     *   setValue(text: string): void, button: HTMLButtonElement }}
     */
    function attachDateTimePicker(input, options) {
        const opts = options || {};
        const kind = opts.kind === 'date' ? 'date' : 'timestamp';
        const ts = kind === 'timestamp';
        const allowEmpty = opts.allowEmpty !== false;
        const sqlLiteral = !!opts.sqlLiteral;
        const doc = input.ownerDocument || document;
        const win = doc.defaultView || root;
        const label = ts ? 'Pick a date and time' : 'Pick a date';
        const typingHint = ts
            ? 'YYYY-MM-DD HH:MM (24-hour), DD.MM.YYYY HH:MM or HH:MM for today — Alt+Down opens the calendar'
            : 'YYYY-MM-DD or DD.MM.YYYY — Alt+Down opens the calendar';
        const baseTitle = input.title || (sqlLiteral ? '' : typingHint);

        input.type = 'text';
        if (!sqlLiteral) {
            input.placeholder = ts ? 'YYYY-MM-DD HH:MM' : 'YYYY-MM-DD';
            input.setAttribute('inputmode', 'numeric');
        }
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.classList.add('dtp-input');
        input.setAttribute('aria-haspopup', 'dialog');
        input.setAttribute('aria-expanded', 'false');
        if (baseTitle) input.title = baseTitle;

        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-ghost btn-sm btn-icon dtp-button';
        button.title = label + ' (Alt+Down)';
        button.setAttribute('aria-label', label);
        button.tabIndex = -1;
        button.innerHTML = icon('calendar');
        input.insertAdjacentElement('afterend', button);

        let handle = null;
        let opening = false;
        const isOpen = () => !!handle && handle.isOpen();

        function setError(message) {
            input.classList.toggle('dtp-invalid', !!message);
            if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
            input.title = message || baseTitle;
        }

        function writeValue(value) {
            if (input.value === value) return;
            input.value = value;
            const EventCtor = (win && win.Event) || Event;
            input.dispatchEvent(new EventCtor('input', { bubbles: true }));
            input.dispatchEvent(new EventCtor('change', { bubbles: true }));
        }

        /** Normalise typed text; false when it is no date. */
        function commitTyped() {
            if (sqlLiteral) return true;
            const r = parseDateTimeInput(input.value, kind);
            if (r.error) { setError(r.error); return false; }
            if (!r.value && !allowEmpty) { setError(ts ? 'Enter a date and time.' : 'Enter a date.'); return false; }
            setError('');
            writeValue(r.value);
            if (typeof opts.onCommit === 'function') opts.onCommit(r.value, 'typed');
            return true;
        }

        function open() {
            if (isOpen()) return;
            opening = true;
            try {
                handle = openPopover({
                    anchors: [input, button], focusTarget: input, ignore: [button], kind, allowEmpty,
                    text: sqlLiteral ? literalText(input.value) : input.value,
                    onChoose: value => {
                        const out = sqlLiteral && value ? "'" + value + "'" : value;
                        setError('');
                        writeValue(out);
                        if (typeof opts.onCommit === 'function') opts.onCommit(out, 'picker');
                    },
                    onClose: () => input.setAttribute('aria-expanded', 'false')
                });
            } finally {
                opening = false;
            }
            input.setAttribute('aria-expanded', 'true');
        }

        function onInputKeyDown(e) {
            if ((e.altKey && e.key === 'ArrowDown') || e.key === 'F4') {
                e.preventDefault();
                e.stopPropagation();
                open();
            } else if (e.key === 'Enter') {
                commitTyped();
            }
        }
        const onInputBlur = () => { if (!opening && !isOpen()) commitTyped(); };
        const onInputEdit = () => { if (input.classList.contains('dtp-invalid')) setError(''); };
        // Keeping the focus in the input keeps a filter field or an edit alive.
        const onButtonMouseDown = e => e.preventDefault();
        const onButtonClick = () => { if (isOpen()) handle.close(true); else open(); };

        input.addEventListener('keydown', onInputKeyDown);
        input.addEventListener('blur', onInputBlur);
        input.addEventListener('input', onInputEdit);
        button.addEventListener('mousedown', onButtonMouseDown);
        button.addEventListener('click', onButtonClick);

        return {
            button,
            open,
            /** Close the popover without changing the value; the focus returns to the input unless `restoreFocus` is false. */
            close(restoreFocus) { if (isOpen()) handle.close(restoreFocus !== false); },
            isOpen,
            /** Show `text` in the input and mark it when it is no date; fires no event. */
            setValue(text) {
                input.value = String(text == null ? '' : text);
                if (sqlLiteral || !input.value.trim()) { setError(''); return; }
                setError(parseDateTimeInput(input.value, kind).error || '');
            },
            destroy() {
                if (isOpen()) handle.close(false);
                input.removeEventListener('keydown', onInputKeyDown);
                input.removeEventListener('blur', onInputBlur);
                input.removeEventListener('input', onInputEdit);
                button.removeEventListener('mousedown', onButtonMouseDown);
                button.removeEventListener('click', onButtonClick);
                button.remove();
                input.classList.remove('dtp-input', 'dtp-invalid');
            }
        };
    }

    const exported = {
        parseDateTimeInput,
        formatDateTime,
        pickedDateTime,
        nowDateTime,
        monthGrid,
        isoWeek,
        addMonths,
        addDays,
        daysInMonth,
        weekdayIndex,
        literalText,
        isInsidePicker,
        openDateTimePopover,
        attachDateTimePicker
    };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = exported;
    }
    if (root) {
        root.DateTimePicker = exported;
    }
})(typeof window !== 'undefined' ? window : null);
