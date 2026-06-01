"""Dependency-free cron scheduling for Strata.

Parses a standard 5-field cron expression (`minute hour day-of-month month
day-of-week`) and computes the next firing time after a given instant, in a
chosen timezone (DST-aware via the stdlib `zoneinfo`, which needs the `tzdata`
package present in the image).

Supported per field: `*`, a single number, comma lists `a,b`, ranges `a-b`,
step on star `*/n`, step on range `a-b/n`, and the open-ended `a/n`. Fields are
numeric only -- month/weekday names (JAN/MON) are not accepted. Day-of-week is
0-6 with Sunday = 0 (7 is accepted as an alias for Sunday).

Standard Vixie day semantics: when BOTH day-of-month and day-of-week are
restricted (neither is `*`), a day matches if EITHER matches; otherwise the
restricted field alone decides.

    python3 schedule.py next "<expr>" [--after EPOCH] [--tz NAME]   # prints epoch
    python3 schedule.py validate "<expr>"                           # exit 0 / 2
"""

import os
import sys
import time
from datetime import datetime, timedelta

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - Python < 3.9
    ZoneInfo = None


# field name, (lo, hi)
_FIELDS = [
    ("minute", 0, 59),
    ("hour", 0, 23),
    ("day-of-month", 1, 31),
    ("month", 1, 12),
    # day-of-week is 0-6 (Sunday = 0); 7 is accepted as a Sunday alias and
    # folded to 0 in parse(), so the parse-time bound allows it.
    ("day-of-week", 0, 7),
]

# A coarse upper bound on the search: 4 years + a day covers the rarest case
# (`0 0 29 2 *`, a Feb-29 that only the leap year satisfies).
_SEARCH_DAYS = 366 * 4 + 1


def _parse_field(token, lo, hi):
    """Expand one cron field into a set of allowed integers in [lo, hi]."""
    allowed = set()
    for part in token.split(","):
        part = part.strip()
        if not part:
            raise ValueError("empty term in field")
        step = 1
        if "/" in part:
            base, _, step_s = part.partition("/")
            try:
                step = int(step_s)
            except ValueError:
                raise ValueError("bad step %r" % step_s)
            if step <= 0:
                raise ValueError("step must be positive: %r" % part)
        else:
            base = part

        if base == "*":
            start, end = lo, hi
        elif "-" in base:
            a_s, _, b_s = base.partition("-")
            try:
                start, end = int(a_s), int(b_s)
            except ValueError:
                raise ValueError("bad range %r" % base)
            if start > end:
                raise ValueError("range start > end: %r" % base)
        else:
            try:
                start = int(base)
            except ValueError:
                raise ValueError("not a number: %r" % base)
            # `a/n` means a, a+step, ... up to hi; a bare `a` is just a.
            end = hi if "/" in part else start

        if start < lo or end > hi:
            raise ValueError("value out of range [%d,%d]: %r" % (lo, hi, part))
        allowed.update(range(start, end + 1, step))
    if not allowed:
        raise ValueError("field expands to nothing")
    return allowed


def parse(expr):
    """Parse a 5-field cron expression.

    Returns (minutes, hours, doms, months, dows, dom_restricted, dow_restricted)
    where the first five are sets of ints and the last two flag whether the
    day-of-month / day-of-week field was something other than a bare `*`.
    Raises ValueError on any malformed input.
    """
    fields = (expr or "").split()
    if len(fields) != 5:
        raise ValueError("expected 5 fields, got %d" % len(fields))

    sets = []
    for raw, (_, lo, hi) in zip(fields, _FIELDS):
        sets.append(_parse_field(raw, lo, hi))
    minutes, hours, doms, months, dows = sets

    # 7 is a common alias for Sunday.
    if 7 in dows:
        dows = set(dows)
        dows.discard(7)
        dows.add(0)

    dom_restricted = fields[2].strip() != "*"
    dow_restricted = fields[4].strip() != "*"
    return minutes, hours, doms, months, dows, dom_restricted, dow_restricted


def _resolve_tz(tzname):
    """ZoneInfo for `tzname` (or $TZ); fall back to system local on failure."""
    name = tzname or os.environ.get("TZ")
    if name and ZoneInfo is not None:
        try:
            return ZoneInfo(name)
        except Exception:
            sys.stderr.write("schedule: unknown timezone %r; using system local\n" % name)
    # No name, or zoneinfo/tzdata unavailable: a fixed offset for "now". Not
    # DST-aware for future dates, but the recommended setup always sets TZ.
    return datetime.now().astimezone().tzinfo


def _first_of_next_month(dt):
    if dt.month == 12:
        return dt.replace(year=dt.year + 1, month=1, day=1, hour=0, minute=0)
    return dt.replace(month=dt.month + 1, day=1, hour=0, minute=0)


def _day_matches(dt, doms, dows, dom_r, dow_r):
    dom_ok = dt.day in doms
    # datetime.weekday(): Monday=0..Sunday=6; cron wants Sunday=0..Saturday=6.
    cron_dow = (dt.weekday() + 1) % 7
    dow_ok = cron_dow in dows
    if dom_r and dow_r:
        return dom_ok or dow_ok  # Vixie OR-rule
    if dom_r:
        return dom_ok
    if dow_r:
        return dow_ok
    return True


def next_run(expr, after_epoch, tzname=None):
    """Epoch (int) of the first cron match strictly after `after_epoch`.

    Iterates on a naive (timezone-less) wall-clock datetime so DST does not
    distort the arithmetic; the tz is attached only at the match, where
    .timestamp() resolves the wall time to epoch (spring-forward gaps resolve
    with fold=0; fall-back ambiguous times fire on their first occurrence).
    """
    minutes, hours, doms, months, dows, dom_r, dow_r = parse(expr)
    tz = _resolve_tz(tzname)

    # Wall-clock "now" in the target zone, advanced to the next whole minute.
    aware_now = datetime.fromtimestamp(after_epoch, tz)
    cur = aware_now.replace(tzinfo=None, second=0, microsecond=0) + timedelta(minutes=1)
    limit = cur + timedelta(days=_SEARCH_DAYS)

    while cur < limit:
        if cur.month not in months:
            cur = _first_of_next_month(cur)
            continue
        if not _day_matches(cur, doms, dows, dom_r, dow_r):
            cur = (cur + timedelta(days=1)).replace(hour=0, minute=0)
            continue
        if cur.hour not in hours:
            cur = (cur + timedelta(hours=1)).replace(minute=0)
            continue
        if cur.minute not in minutes:
            cur = cur + timedelta(minutes=1)
            continue
        return int(cur.replace(tzinfo=tz).timestamp())

    raise ValueError("no cron match within %d days for %r" % (_SEARCH_DAYS, expr))


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def _cmd_next(args):
    expr = None
    after = None
    tz = None
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--after":
            i += 1
            after = float(args[i])
        elif a == "--tz":
            i += 1
            tz = args[i]
        elif expr is None:
            expr = a
        else:
            raise ValueError("unexpected argument %r" % a)
        i += 1
    if expr is None:
        raise ValueError("missing cron expression")
    ts = next_run(expr, after if after is not None else time.time(), tz)
    sys.stdout.write("%d\n" % ts)


def main(argv):
    if len(argv) < 2:
        sys.stderr.write("usage: schedule.py next|validate <expr> ...\n")
        return 2
    cmd = argv[1]
    try:
        if cmd == "validate":
            expr = argv[2] if len(argv) > 2 else ""
            parse(expr)  # syntax
            # Semantic check: a syntactically valid expression can still name a
            # date that never occurs (e.g. "0 0 30 2 *" -> Feb 30). Resolve the
            # next run so such expressions are rejected here rather than passing
            # validation and then failing on every `next` call -- which would
            # silently degrade the scan loop from schedule to interval cadence.
            next_run(expr, time.time())
            return 0
        if cmd == "next":
            _cmd_next(argv[2:])
            return 0
    except (ValueError, IndexError) as e:
        sys.stderr.write("schedule: %s\n" % e)
        return 2
    sys.stderr.write("schedule: unknown command %r\n" % cmd)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
