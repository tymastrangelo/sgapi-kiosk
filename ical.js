// ical.js — just enough RFC 5545 to read a public Google Calendar .ics feed.
'use strict';

// ponytail: expands DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL and
// BYDAY, plus EXDATE and RECURRENCE-ID overrides — everything this calendar
// uses. Positional rules ("3rd Thursday of the month", BYSETPOS) expand as if
// the ordinal weren't there. If the calendar ever needs those, replace this
// file with the `node-ical` package rather than growing it.

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MAX_STEPS = 5000; // ~13 years of day-by-day walking; guards against loops

// ---------- text ----------

const unfold = (text) => text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
const unescapeText = (v) =>
  v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1').trim();

// NAME;PARAM=x;P2="a:b":VALUE — the name ends at the first colon outside quotes
function parseLine(line) {
  let i = 0, quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ':' && !quoted) break;
  }
  if (i >= line.length) return null;
  const segments = line.slice(0, i).split(';');
  const params = {};
  for (const seg of segments.slice(1)) {
    const eq = seg.indexOf('=');
    if (eq > 0) params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: segments[0].toUpperCase(), params, value: line.slice(i + 1) };
}

// ---------- time zones ----------

const formatters = new Map();
function zoneFormatter(tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

// How far the named zone was from UTC at that instant.
function tzOffset(utcMs, tz) {
  const p = {};
  for (const part of zoneFormatter(tz).formatToParts(new Date(utcMs))) p[part.type] = part.value;
  // Some ICU builds render midnight as hour 24.
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - utcMs;
}

// Wall-clock fields in a zone -> epoch ms. Two passes settle DST boundaries.
function wallToEpoch(w, tz) {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  if (tz === 'UTC') return guess;
  try {
    const once = guess - tzOffset(guess, tz);
    return guess - tzOffset(once, tz);
  } catch (e) {
    return guess; // unknown zone: treat as UTC rather than dropping the event
  }
}

// Calendar arithmetic on wall-clock fields, so a 7:30pm meeting stays 7:30pm
// across a daylight-saving change instead of drifting an hour.
function addWall(w, { days = 0, months = 0 }) {
  const d = new Date(Date.UTC(w.y, w.mo - 1 + months, w.d + days, w.h, w.mi, w.s));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: w.h, mi: w.mi, s: w.s };
}

const weekdayOf = (w) => new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();

function parseWhen(value, params, calTz) {
  const v = value.trim();
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly) {
    return {
      wall: { y: +dateOnly[1], mo: +dateOnly[2], d: +dateOnly[3], h: 0, mi: 0, s: 0 },
      tz: params.TZID || calTz, allDay: true,
    };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!m) return null;
  return {
    wall: { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6] },
    tz: m[7] ? 'UTC' : (params.TZID || calTz), allDay: false,
  };
}

const epochOf = (when) => (when ? wallToEpoch(when.wall, when.tz) : null);

// ---------- parsing ----------

function parse(text) {
  const lines = unfold(String(text)).split('\n');
  let calName = 'Calendar', calTz = 'UTC';
  const events = [];
  let current = null, depth = null;

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const line = parseLine(raw);
    if (!line) continue;

    if (line.name === 'BEGIN') {
      // VALARM and VTIMEZONE carry DTSTARTs of their own — ignore their innards.
      if (line.value === 'VEVENT') { current = { props: [] }; depth = 'VEVENT'; }
      else if (current && depth === 'VEVENT') depth = 'NESTED';
      continue;
    }
    if (line.name === 'END') {
      if (line.value === 'VEVENT' && current) { events.push(current); current = null; depth = null; }
      else if (depth === 'NESTED') depth = 'VEVENT';
      continue;
    }
    if (!current) {
      if (line.name === 'X-WR-CALNAME') calName = unescapeText(line.value);
      if (line.name === 'X-WR-TIMEZONE') calTz = line.value.trim();
      continue;
    }
    if (depth === 'VEVENT') current.props.push(line);
  }

  return { calName, calTz, events };
}

function propsOf(ev) {
  const map = {};
  for (const p of ev.props) {
    if (map[p.name] && (p.name === 'EXDATE' || p.name === 'RDATE')) {
      map[p.name] = { ...map[p.name], value: `${map[p.name].value},${p.value}` };
    } else if (!map[p.name]) {
      map[p.name] = p;
    }
  }
  return map;
}

const parseRrule = (v) => Object.fromEntries(
  v.split(';').map((kv) => {
    const i = kv.indexOf('=');
    return [kv.slice(0, i).toUpperCase(), kv.slice(i + 1)];
  }).filter(([k]) => k));

// Every start time this event has inside [windowStart, windowEnd].
function occurrences(rrule, start, calTz, windowStart, windowEnd) {
  const freq = (rrule.FREQ || '').toUpperCase();
  const interval = Math.max(1, parseInt(rrule.INTERVAL) || 1);
  const count = rrule.COUNT ? parseInt(rrule.COUNT) : Infinity;
  const until = rrule.UNTIL ? epochOf(parseWhen(rrule.UNTIL, {}, calTz)) : Infinity;
  // "2TH" means the 2nd Thursday; the ordinal is dropped (see the note above).
  const byday = rrule.BYDAY
    ? new Set(rrule.BYDAY.split(',').map((s) => s.trim().slice(-2).toUpperCase()))
    : null;

  const wkst = DAYS.indexOf((rrule.WKST || 'MO').toUpperCase());
  const startWd = weekdayOf(start.wall);
  const offsetInWeek = (startWd - (wkst < 0 ? 1 : wkst) + 7) % 7;

  const out = [];
  let emitted = 0;

  for (let step = 0; step < MAX_STEPS && emitted < count; step++) {
    const wall = freq === 'MONTHLY' || freq === 'YEARLY'
      ? addWall(start.wall, { months: step * (freq === 'YEARLY' ? 12 : 1) * interval })
      : addWall(start.wall, { days: step });
    const at = wallToEpoch(wall, start.tz);

    if (at > until || at > windowEnd) break;

    let hit;
    if (freq === 'DAILY') hit = step % interval === 0;
    else if (freq === 'WEEKLY') {
      const week = Math.floor((step + offsetInWeek) / 7);
      hit = week % interval === 0 && (byday ? byday.has(DAYS[weekdayOf(wall)]) : weekdayOf(wall) === startWd);
    } else if (freq === 'MONTHLY' || freq === 'YEARLY') {
      hit = wall.d === start.wall.d; // skips months with no such day, per RFC
    } else {
      break; // unknown FREQ: fall back to the single start time
    }

    if (!hit) continue;
    emitted++;
    if (at >= windowStart) out.push(at);
  }
  return out;
}

/**
 * Upcoming events, soonest first.
 * @returns {{calName, calTz, events: Array<{summary, location, description, start, end, allDay}>}}
 */
function upcoming(text, { from = Date.now(), limit = 8, horizonDays = 240 } = {}) {
  const { calName, calTz, events } = parse(text);
  const windowEnd = from + horizonDays * 86400000;

  // An edited single instance of a series carries the series UID plus the
  // original start time in RECURRENCE-ID.
  const overrides = new Map();
  const masters = [];
  for (const ev of events) {
    const p = propsOf(ev);
    if (!p.DTSTART) continue;
    if (p['RECURRENCE-ID']) {
      const orig = epochOf(parseWhen(p['RECURRENCE-ID'].value, p['RECURRENCE-ID'].params, calTz));
      overrides.set(`${p.UID ? p.UID.value : ''}|${orig}`, p);
    } else {
      masters.push(p);
    }
  }

  const out = [];
  for (const p of masters) {
    const start = parseWhen(p.DTSTART.value, p.DTSTART.params, calTz);
    if (!start) continue;
    const startMs = epochOf(start);
    const endWhen = p.DTEND ? parseWhen(p.DTEND.value, p.DTEND.params, calTz) : null;
    const span = endWhen ? Math.max(0, epochOf(endWhen) - startMs)
                         : (start.allDay ? 86400000 : 3600000);

    const skip = new Set();
    if (p.EXDATE) {
      for (const v of p.EXDATE.value.split(',')) {
        const when = parseWhen(v, p.EXDATE.params, calTz);
        if (when) skip.add(epochOf(when));
      }
    }

    const starts = p.RRULE
      ? occurrences(parseRrule(p.RRULE.value), start, calTz, from - span, windowEnd)
      : [startMs];

    const uid = p.UID ? p.UID.value : '';
    for (const at of starts) {
      if (skip.has(at)) continue;
      const override = overrides.get(`${uid}|${at}`);
      const src = override || p;
      const realStart = override
        ? epochOf(parseWhen(src.DTSTART.value, src.DTSTART.params, calTz))
        : at;

      out.push({
        summary: src.SUMMARY ? unescapeText(src.SUMMARY.value) : '(no title)',
        location: src.LOCATION ? unescapeText(src.LOCATION.value) : '',
        description: src.DESCRIPTION ? unescapeText(src.DESCRIPTION.value) : '',
        start: realStart,
        end: realStart + span,
        allDay: start.allDay,
      });
    }
  }

  // Keep an event up while it is happening, not just before it starts.
  return {
    calName,
    calTz,
    events: out.filter((e) => e.end > from).sort((a, b) => a.start - b.start).slice(0, limit),
  };
}

module.exports = { parse, upcoming, wallToEpoch, tzOffset };

// ---------- self-check:  node ical.js  ----------
if (require.main === module) {
  const assert = require('assert');
  const ics = [
    'BEGIN:VCALENDAR',
    'X-WR-CALNAME:Test Cal',
    'X-WR-TIMEZONE:America/New_York',
    'BEGIN:VEVENT',                       // all-day
    'UID:a', 'SUMMARY:Retreat', 'DTSTART;VALUE=DATE:20260302', 'DTEND;VALUE=DATE:20260303',
    'END:VEVENT',
    'BEGIN:VEVENT',                       // UTC stamp
    'UID:b', 'SUMMARY:Fireside Chat', 'DTSTART:20260304T230000Z',
    'END:VEVENT',
    'BEGIN:VEVENT',                       // weekly, one cancelled, spans a DST change
    'UID:c', 'SUMMARY:Business Meeting', 'LOCATION:Moseley 215',
    'DTSTART;TZID=America/New_York:20260305T193000',
    'RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20260430T035959Z;BYDAY=TH',
    'EXDATE;TZID=America/New_York:20260312T193000',
    'BEGIN:VALARM', 'TRIGGER:-PT5M', 'DTSTART:19760401T005545Z', 'END:VALARM',
    'END:VEVENT',
    'BEGIN:VEVENT',                       // one instance renamed
    'UID:c', 'SUMMARY:Internal Priorities Meeting',
    'RECURRENCE-ID;TZID=America/New_York:20260319T193000',
    'DTSTART;TZID=America/New_York:20260319T193000',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const from = Date.parse('2026-03-01T00:00:00Z');
  const { calName, calTz, events } = upcoming(ics, { from, limit: 20 });
  const at = (e) => new Date(e.start).toISOString();

  assert.strictEqual(calName, 'Test Cal');
  assert.strictEqual(calTz, 'America/New_York');

  // A VALARM's own DTSTART must not leak out as an event.
  assert.ok(!events.some((e) => e.summary === '(no title)'), 'nested block leaked');

  const meetings = events.filter((e) => e.summary === 'Business Meeting');
  assert.ok(meetings.length >= 6, `expected weekly series, got ${meetings.length}`);

  // Series runs Mar 5, [12 excluded], [19 renamed], 26, ...
  // 7:30pm ET is 00:30Z before DST starts (Mar 8) and 23:30Z after: the wall
  // clock must hold across the change rather than drifting an hour.
  assert.strictEqual(at(meetings[0]), '2026-03-06T00:30:00.000Z');
  assert.strictEqual(at(meetings[1]), '2026-03-26T23:30:00.000Z');

  // EXDATE removed Mar 12; RECURRENCE-ID renamed Mar 19.
  assert.ok(!meetings.some((e) => at(e) === '2026-03-13T00:30:00.000Z'), 'EXDATE ignored');
  assert.ok(events.some((e) => e.summary === 'Internal Priorities Meeting'), 'override missing');
  assert.ok(!events.some((e) => e.summary === 'Business Meeting' && at(e) === '2026-03-19T23:30:00.000Z'),
    'overridden instance still present under its old name');

  // UNTIL is honoured.
  assert.ok(meetings.every((e) => e.start <= Date.parse('2026-04-30T03:59:59Z')), 'UNTIL ignored');

  // All-day events stay up for the whole day.
  const retreat = events.find((e) => e.summary === 'Retreat');
  assert.ok(retreat && retreat.allDay, 'all-day event missing');
  assert.strictEqual(upcoming(ics, { from: Date.parse('2026-03-02T18:00:00Z'), limit: 20 })
    .events.some((e) => e.summary === 'Retreat'), true, 'all-day dropped mid-day');

  assert.deepStrictEqual(events.map((e) => e.summary).slice(0, 3),
    ['Retreat', 'Fireside Chat', 'Business Meeting']);

  console.log(`ical.js self-check passed — ${events.length} events expanded`);
}
