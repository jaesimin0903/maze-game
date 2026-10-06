#!/usr/bin/env bash
# Runs the whole verification of plan §11 and prints one line per acceptance criterion.
#
#   pnpm verify:all
#   pnpm verify:all --only T-web,T-abi     run only these suites; every other suite counts as
#                                           not run, which is a FAIL
#
# Suites, in this order (the names are those of plan §5):
#   T-build    pnpm typecheck, forge build, next build                        (AC-I3)
#   T-shared   T-sim   T-web   T-forge   T-abi   T-own   T-int                unit and integration
#   T-exact    pnpm sim:exact --check     the three candidates, the production table and, when
#              it exists, the house-max table
#   T-cert     pnpm sim:certify --check   the production table and the house-max table
#   T-tune     pnpm tuning:check          and --table <house-max>
#   T-aside    pnpm e2e:aside             exit 3 means BLOCKED
#   T-audit    pnpm audit:exploit
#   T-scan     no placeholder in the sources: TODO, FIXME, test.skip, .only, "not implemented"
#   T-report   pnpm report:check          run last; it reads the result of this run
#
# The simulation is never recomputed here. `--check` only reads the cache: it passes when the
# cache holds every chunk for the current table and simulator code and every gate passes.
#
# T-tune compares the production table with a deployed contract. When no deployment answers
# and the production table is calibrated, this script starts the stack with `pnpm dev:up`
# (production table, no test hooks), checks, and stops it again with `pnpm dev:down`.
#
# What a criterion's result means. Results are derived per suite; this script does not trace
# which test proved which criterion. A criterion is PASS when every suite of its row in plan §5
# exited 0 and, for EACH test suite among them, a test of that suite is named after the
# criterion in its title (plan §4.2): the first argument of it( / test( / describe( or the name
# of a Foundry test or invariant function. A comment or a title in another suite of the row
# does not count. Criteria whose row holds no test suite pass on their command exiting 0 alone;
# the output says how many those are. It is BLOCKED when a suite of its row was blocked and
# none failed.
#
# AC-A7 is advisory and is neither counted nor part of the exit code. Its status is the result
# scenario 09 recorded in the aside run of this call (e2e/aside/out/results.json): PASS, FAIL,
# BLOCKED, or NOT-RUN when the scenario was not executed (it runs only on request).
#
# AC-I2 (T-own) compares the paths changed against HEAD with the owned paths. On a clean tree
# there is nothing to compare; the suite detail and the criterion note then say so.
#
# Output: .data/verify-all/result.json (read by `pnpm report:check`), .data/verify-all/logs/.
# The result records HEAD and the working-tree state it was produced for; `pnpm report:check`
# refuses it for any other tree.
# Exit codes: 0 = every criterion PASS, 1 = at least one FAIL, 3 = no FAIL, at least one
# BLOCKED, 2 = bad arguments.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

OUT="$ROOT_DIR/.data/verify-all"
LOGS="$OUT/logs"
SUITES_FILE="$OUT/suites.tsv"
CRITERIA_FILE="$OUT/criteria.tsv"
TITLES="$OUT/titles"
ASIDE_RESULTS="${MAZE_E2E_OUT_DIR:-$ROOT_DIR/e2e/aside/out}/results.json"
RESULT_FILE="$OUT/result.json"
TABLE="packages/shared/src/tuning.json"
REPORTS="packages/sim/reports"
HOUSE_MAX="$REPORTS/tuning.house-max.json"

ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --only) [ $# -ge 2 ] || { echo "verify:all: --only needs a list of suites" >&2; exit 2; }; ONLY="$2"; shift 2 ;;
    --) shift ;;
    *) echo "usage: pnpm verify:all [--only <suite>[,<suite>...]]" >&2; exit 2 ;;
  esac
done

mkdir -p "$LOGS" "$TITLES"
rm -f "$LOGS"/*.log "$TITLES"/*.txt
: >"$SUITES_FILE"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

wanted() {
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

# record <suite> <PASS|FAIL|BLOCKED> <detail without quotes or tabs>
record() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$SUITES_FILE"
  printf '   %-8s %-8s %s\n' "$1" "$2" "$3"
}

status_of() {
  awk -F'\t' -v suite="$1" '$1 == suite { status = $2 } END { print status }' "$SUITES_FILE"
}

detail_of() {
  awk -F'\t' -v suite="$1" '$1 == suite { detail = $3 } END { print detail }' "$SUITES_FILE"
}

not_run() {
  awk -F'\t' -v suite="$1" '$1 == suite { detail = $3 } END { exit (detail ~ /^not run/ ? 0 : 1) }' "$SUITES_FILE"
}

# step <suite> <command>: runs the command from the repository root, appends to the suite's
# log and returns the command's exit code.
step() {
  local code=0
  echo "\$ $2" >>"$LOGS/$1.log"
  bash -c "$2" >>"$LOGS/$1.log" 2>&1 || code=$?
  echo "[exit $code]" >>"$LOGS/$1.log"
  return "$code"
}

# simple <suite> <command>: PASS on exit 0, FAIL otherwise.
simple() {
  local code=0
  if ! wanted "$1"; then record "$1" FAIL "not run (--only)"; return; fi
  echo "== $1: $2"
  step "$1" "$2" || code=$?
  if [ "$code" -eq 0 ]; then record "$1" PASS "exit 0"; else record "$1" FAIL "exit $code"; fi
}

# cached <suite> <command>...: simulator commands in --check mode. Exit 3 is BLOCKED, any
# other non-zero exit (2 = the cache is incomplete) is FAIL.
cached() {
  local suite="$1" status=PASS detail="" code
  shift
  if ! wanted "$suite"; then record "$suite" FAIL "not run (--only)"; return; fi
  for command in "$@"; do
    echo "== $suite: $command"
    code=0
    step "$suite" "$command" || code=$?
    case "$code" in
      0) ;;
      3) [ "$status" = PASS ] && status=BLOCKED; detail="$detail; exit 3 (BLOCKED): $command" ;;
      2) status=FAIL; detail="$detail; exit 2 (cache incomplete): $command" ;;
      *) status=FAIL; detail="$detail; exit $code: $command" ;;
    esac
  done
  record "$suite" "$status" "${detail#; }"
}

# ----- suites -----

simple T-build "pnpm typecheck && forge build --root contracts && pnpm --filter @maze/web build"
simple T-shared "pnpm --filter @maze/shared test"
simple T-sim "pnpm --filter @maze/sim test"
simple T-web "pnpm --filter @maze/web test"
simple T-forge "forge test --root contracts"
simple T-abi "pnpm abi:check"

# The ownership check passes trivially when nothing differs from HEAD, so the suite records how
# many changed paths it actually compared.
own_suite() {
  local code=0 changed
  if ! wanted T-own; then record T-own FAIL "not run (--only)"; return; fi
  echo "== T-own: pnpm ownership:check"
  step T-own "pnpm ownership:check" || code=$?
  changed="$(sed -n 's/^ownership:check OK: \([0-9][0-9]*\) changed paths.*/\1/p' "$LOGS/T-own.log" | tail -n 1)"
  if [ "$code" -ne 0 ]; then
    record T-own FAIL "exit $code"
  elif [ -z "$changed" ]; then
    record T-own FAIL "exit 0, but the output does not say how many changed paths were compared"
  elif [ "$changed" -eq 0 ]; then
    record T-own PASS "exit 0 on a clean tree: 0 changed paths, so no path was compared with the owned paths"
  else
    record T-own PASS "exit 0: $changed changed path(s) compared, all inside the owned paths"
  fi
}
own_suite
simple T-int "pnpm test:integration"

EXACT_COMMANDS=()
for candidate in i ii iii; do
  EXACT_COMMANDS+=("pnpm sim:exact --table $REPORTS/candidates/$candidate.json --check")
done
EXACT_COMMANDS+=("pnpm sim:exact --check")
CERT_COMMANDS=("pnpm sim:certify --check")
if [ -f "$HOUSE_MAX" ]; then
  EXACT_COMMANDS+=("pnpm sim:exact --table $HOUSE_MAX --check")
  CERT_COMMANDS+=("pnpm sim:certify --table $HOUSE_MAX --check")
fi
cached T-exact "${EXACT_COMMANDS[@]}"
cached T-cert "${CERT_COMMANDS[@]}"

tune_suite() {
  local code=0 detail="exit 0"
  if ! wanted T-tune; then record T-tune FAIL "not run (--only)"; return; fi
  echo "== T-tune: pnpm tuning:check"
  if ! step T-tune "pnpm tuning:check"; then
    code=1
    detail="pnpm tuning:check failed"
    if grep -Eq '"calibrated"[[:space:]]*:[[:space:]]*true' "$TABLE"; then
      # The table is calibrated; what is missing may only be a running deployment of it.
      echo "== T-tune: pnpm dev:up, pnpm tuning:check, pnpm dev:down"
      if step T-tune "env -u MAZE_ALLOW_TEST_HOOKS -u MAZE_TEST_SEED_SECRET -u MAZE_TUNING_FIXTURE pnpm dev:up"; then
        if step T-tune "pnpm tuning:check"; then code=0; detail="exit 0 against a stack started for the check"; fi
        step T-tune "pnpm dev:down" || { code=1; detail="pnpm dev:down failed"; }
      else
        detail="pnpm tuning:check failed and pnpm dev:up could not start the production table"
      fi
    fi
  fi
  if [ -f "$HOUSE_MAX" ]; then
    echo "== T-tune: pnpm tuning:check --table $HOUSE_MAX"
    step T-tune "pnpm tuning:check --table $HOUSE_MAX" || { code=1; detail="$detail; the house-max table failed"; }
  fi
  if [ "$code" -eq 0 ]; then record T-tune PASS "$detail"; else record T-tune FAIL "$detail"; fi
}
tune_suite

aside_suite() {
  local code=0
  if ! wanted T-aside; then record T-aside FAIL "not run (--only)"; return; fi
  echo "== T-aside: pnpm e2e:aside"
  step T-aside "pnpm e2e:aside" || code=$?
  case "$code" in
    0) record T-aside PASS "exit 0" ;;
    3) record T-aside BLOCKED "exit 3: a scenario could not run its DOM assertions" ;;
    *) record T-aside FAIL "exit $code" ;;
  esac
}
aside_suite

simple T-audit "pnpm audit:exploit"

scan_suite() {
  local hits
  if ! wanted T-scan; then record T-scan FAIL "not run (--only)"; return; fi
  echo "== T-scan: placeholders in the sources"
  # Every tracked or new source file except third-party code and this script's own patterns.
  hits="$(git ls-files -z -co --exclude-standard -- apps packages contracts/src contracts/test scripts e2e \
    ':(exclude)scripts/verify-all.sh' |
    xargs -0 grep -nIE \
      -e 'TODO|FIXME' \
      -e '(^|[^A-Za-z0-9_])(it|test|describe)\.(skip|only|todo)\(' \
      -e '(^|[^A-Za-z0-9_])(xit|xdescribe|fit|fdescribe)\(' \
      -e '[Nn]ot[ _-]?[Ii]mplemented|[Uu]nimplemented' 2>/dev/null || true)"
  printf '%s\n' "$hits" >"$LOGS/T-scan.log"
  if [ -z "$hits" ]; then
    record T-scan PASS "no placeholder"
  else
    record T-scan FAIL "$(printf '%s\n' "$hits" | wc -l | tr -d ' ') placeholder line(s), see logs/T-scan.log"
  fi
}
scan_suite

# ----- criteria -----

# <criterion>|<suites of its row in plan §5>
CRITERIA='AC-R1|T-aside T-shared
AC-R2|T-forge T-int
AC-R3|T-forge T-int
AC-R4|T-int T-aside
AC-R5|T-web
AC-R6|T-cert
AC-R7|T-cert
AC-R8|T-cert
AC-R9|T-shared T-tune T-forge
AC-M1|T-shared T-sim
AC-M2|T-shared
AC-M3|T-int
AC-M4|T-forge T-aside
AC-M5|T-shared T-aside
AC-M6|T-shared T-int
AC-M7|T-shared
AC-S1|T-web
AC-S2|T-web T-int
AC-S3|T-int T-forge
AC-S4|T-int
AC-S5|T-web T-forge
AC-S6|T-int
AC-S7|T-int
AC-S8|T-web T-int
AC-S9|T-int
AC-S10|T-int
AC-S11|T-int
AC-C1|T-forge
AC-C2|T-forge
AC-C3|T-forge
AC-C4|T-forge
AC-C5|T-forge
AC-C6|T-forge
AC-C7|T-forge
AC-C8|T-forge
AC-C9|T-forge
AC-C10|T-forge
AC-W1|T-aside
AC-W2|T-web T-aside
AC-W3|T-aside
AC-W4|T-aside
AC-W5|T-aside
AC-W6|T-web T-aside
AC-W7|T-aside
AC-E1|T-aside T-int
AC-E2|T-aside T-int
AC-A1|T-aside
AC-A2|T-aside
AC-A3|T-aside
AC-A4|T-web
AC-A5|T-web
AC-A6|T-aside
AC-A7|T-aside
AC-X1|T-audit
AC-X2|T-web
AC-X3|T-web
AC-X4|T-int T-forge
AC-X5|T-web
AC-X6|T-forge
AC-X7|T-cert
AC-X8|T-exact T-sim
AC-X9|T-int
AC-X10|T-audit
AC-T1|T-exact T-sim
AC-T2|T-sim
AC-T3|T-cert
AC-T4|T-cert
AC-T5|T-cert T-report
AC-T6|T-report
AC-T7|T-tune
AC-T8|T-int T-web T-aside
AC-T9|T-sim T-cert
AC-T10|T-cert
AC-T11|T-tune T-report
AC-D1|T-report
AC-D2|T-report
AC-I1|T-abi
AC-I2|T-own
AC-I3|T-build
AC-P1|T-shared
AC-P2|T-shared
AC-P3|T-web
AC-P4|T-web
AC-P5|T-web T-int
AC-P6|T-web
AC-P7|T-web T-aside
AC-P8|T-sim
AC-P9|T-shared
AC-P10|T-web T-int
AC-P11|T-web'

# Where the tests of a suite live; empty for suites that are not test suites.
test_dirs() {
  case "$1" in
    T-shared) echo "packages/shared/test" ;;
    T-sim) echo "packages/sim/test" ;;
    T-web) echo "apps/web/test/server apps/web/test/client" ;;
    T-int) echo "apps/web/test/integration" ;;
    T-forge) echo "contracts/test" ;;
  esac
}

# titles <dir>...: one test title per line. In *.test.ts(x): the first string argument of
# it( / test( / describe(, also in the `.each(...)(` form. In *.sol: the names of the test and
# invariant functions. Comments and other text are not titles.
titles() {
  node - "$@" <<'NODE'
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const walk = (dir) =>
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
const STRING = String.raw`(['"\`])((?:\\[\s\S]|(?!\1)[^\\])*)\1`;
// `it(`, `test(` or `describe(` followed by a string, or the `)(` that closes `.each(...)`.
const TS_TITLE = new RegExp(String.raw`(?:(?:^|[^A-Za-z0-9_$.])(?:it|test|describe)|\))\(\s*${STRING}`, 'g');
const SOL_TITLE = /function\s+((?:test|invariant)[A-Za-z0-9_]*)\s*\(/g;
for (const dir of process.argv.slice(2)) {
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf8');
    if (/\.sol$/.test(file)) for (const match of text.matchAll(SOL_TITLE)) console.log(match[1]);
    else if (/\.test\.tsx?$/.test(file)) for (const match of text.matchAll(TS_TITLE)) console.log(match[2].replace(/\s+/g, ' '));
  }
}
NODE
}

for suite in T-shared T-sim T-web T-int T-forge; do
  # shellcheck disable=SC2046
  titles $(test_dirs "$suite") >"$TITLES/$suite.txt"
done

# named_in <suite> <criterion>: a test title of the suite names the criterion.
named_in() {
  grep -qE "AC[-_ ]?${2#AC-}([^0-9]|\$)" "$TITLES/$1.txt"
}

# The recorded result of scenario 09 in the aside run of this call: PASS, FAIL, BLOCKED or
# NOT-RUN. Anything else (no file, no scenario 09, a result from an earlier call) is NOT-RUN.
scenario_09() {
  [ "$(status_of T-aside)" != "" ] && ! not_run T-aside || { echo "NOT-RUN|T-aside was not run"; return; }
  node - "$ASIDE_RESULTS" "$STARTED_AT" <<'NODE'
const { readFileSync } = require('node:fs');
const [file, startedAt] = process.argv.slice(2);
let out = 'NOT-RUN|scenario 09 has no recorded result';
try {
  const results = JSON.parse(readFileSync(file, 'utf8'));
  const scenario = (results.scenarios ?? []).find((entry) => entry.scenario === '09');
  if (String(results.finishedAt ?? '') < startedAt) out = 'NOT-RUN|the recorded aside results are older than this run';
  else if (scenario !== undefined && ['PASS', 'FAIL', 'BLOCKED', 'NOT-RUN'].includes(scenario.result)) {
    const reason = String(scenario.reason ?? '').replace(/[\t\n"\\|]/g, ' ').slice(0, 160);
    out = `${scenario.result}|scenario 09 ${scenario.result === 'NOT-RUN' ? 'was not executed' : 'recorded ' + scenario.result}${reason === '' ? '' : ': ' + reason}`;
  }
} catch {
  out = 'NOT-RUN|scenario 09 has no recorded result';
}
console.log(out);
NODE
}

# Writes criteria.tsv (<criterion> <status> <suites> <note>) from the suites recorded so far.
evaluate() {
  local criterion suites suite status note
  : >"$CRITERIA_FILE"
  while IFS='|' read -r criterion suites; do
    status=PASS
    note=""
    for suite in $suites; do
      case "$(status_of "$suite")" in
        PASS) ;;
        BLOCKED) [ "$status" = PASS ] && status=BLOCKED; note="$note, $suite blocked" ;;
        FAIL) status=FAIL; if not_run "$suite"; then note="$note, $suite not run"; else note="$note, $suite failed"; fi ;;
        *) status=FAIL; note="$note, $suite not run" ;;
      esac
      # Each test suite of the row needs its own test named after the criterion. AC-C6 is "all
      # of the above pass as Foundry tests": the suite itself is its test.
      if [ -n "$(test_dirs "$suite")" ] && [ "$criterion" != AC-C6 ] && ! named_in "$suite" "$criterion"; then
        status=FAIL
        note="$note, no test title in $suite names it"
      fi
    done
    case "$criterion" in
      AC-A7)
        # Advisory: the status is what scenario 09 itself recorded, not that of the aside suite.
        IFS='|' read -r status note <<EOF2
$(scenario_09)
EOF2
        ;;
      AC-I2) note="$note, T-own: $(detail_of T-own)" ;;
    esac
    printf '%s\t%s\t%s\t%s\n' "$criterion" "$status" "$suites" "${note#, }" >>"$CRITERIA_FILE"
  done <<EOF
$CRITERIA
EOF
}

count() {
  awk -F'\t' -v status="$1" '$1 != "AC-A7" && $2 == status { n += 1 } END { print n + 0 }' "$CRITERIA_FILE"
}

# Criteria (AC-A7 included) whose row holds no test suite: they pass on a command exiting 0.
command_only() {
  local criterion suites suite n=0 tested
  while IFS='|' read -r criterion suites; do
    tested=0
    for suite in $suites; do [ -n "$(test_dirs "$suite")" ] && tested=1; done
    [ "$tested" -eq 0 ] && n=$((n + 1))
  done <<EOF
$CRITERIA
EOF
  echo "$n"
}

exit_code() {
  if [ "$(count FAIL)" -gt 0 ] || [ "$(status_of T-scan)" != PASS ]; then echo 1
  elif [ "$(count BLOCKED)" -gt 0 ]; then echo 3
  else echo 0
  fi
}

write_result() {
  local head tree fingerprint
  # HEAD and the working-tree state at the time of writing, as `pnpm report:check` recomputes them.
  read -r head tree fingerprint <<EOF
$(pnpm -s report:check --tree-state 2>/dev/null || echo "unknown unknown unknown")
EOF
  {
    printf '{\n  "schema": 2,\n  "startedAt": "%s",\n  "finishedAt": "%s",\n  "head": "%s",\n  "tree": { "state": "%s", "fingerprint": "%s" },\n' \
      "$STARTED_AT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$head" "$tree" "$fingerprint"
    printf '  "criteriaBasis": "per suite: a criterion is PASS when every suite of its row exited 0 and each test suite among them has a test titled after it; not an execution trace per criterion",\n'
    printf '  "commandOnlyCriteria": %s,\n' "$(command_only)"
    printf '  "suites": {\n'
    awk -F'\t' '{ printf "%s    \"%s\": { \"status\": \"%s\", \"detail\": \"%s\" }", (NR > 1 ? ",\n" : ""), $1, $2, $3 } END { print "" }' "$SUITES_FILE"
    printf '  },\n  "acs": {\n'
    awk -F'\t' '{
      n = split($3, list, " ")
      suites = ""
      for (i = 1; i <= n; i++) suites = suites (i > 1 ? ", " : "") "\"" list[i] "\""
      printf "%s    \"%s\": { \"status\": \"%s\", \"suites\": [%s], \"advisory\": %s, \"note\": \"%s\" }", (NR > 1 ? ",\n" : ""), $1, $2, suites, ($1 == "AC-A7" ? "true" : "false"), $4
    } END { print "" }' "$CRITERIA_FILE"
    printf '  },\n  "exit": %s\n}\n' "$(exit_code)"
  } >"$RESULT_FILE.tmp"
  mv "$RESULT_FILE.tmp" "$RESULT_FILE"
}

# report:check compares the report's BLOCKED list with this run, so the result is written
# once before it runs and once more with its own outcome.
evaluate
write_result
simple T-report "pnpm report:check"
evaluate
write_result

# ----- the table -----

echo
echo "Acceptance criteria"
awk -F'\t' '{ printf "  %-7s %-8s %-28s %s%s\n", $1, $2, $3, $4, ($1 == "AC-A7" ? ($4 == "" ? "" : "; ") "advisory" : "") }' "$CRITERIA_FILE"
echo
echo "Suites"
awk -F'\t' '{ printf "  %-9s %-8s %s\n", $1, $2, $3 }' "$SUITES_FILE"
if [ "$(status_of T-scan)" != PASS ]; then
  echo
  echo "Placeholders found in the sources (a FAIL of the whole run):"
  head -n 20 "$LOGS/T-scan.log" | sed 's/^/  /'
fi

CODE="$(exit_code)"
echo
echo "verify:all: $(count PASS) PASS, $(count FAIL) FAIL, $(count BLOCKED) BLOCKED of $(awk 'END { print NR - 1 }' "$CRITERIA_FILE") criteria."
echo "verify:all: the advisory AC-A7 is not counted; its status is that of scenario 09: $(awk -F'\t' '$1 == "AC-A7" { print $2 " (" $4 ")" }' "$CRITERIA_FILE")."
echo "verify:all: results are per suite, not an execution trace per criterion. PASS means every suite of the"
echo "  criterion's row exited 0 and each test suite among them has a test titled after the criterion."
echo "  $(command_only) of the $(awk 'END { print NR }' "$CRITERIA_FILE") criteria have no test suite in their row and pass on a command exiting 0 alone."
echo "verify:all: logs in .data/verify-all/logs/, result in .data/verify-all/result.json"
case "$CODE" in
  0) echo "verify:all PASS" ;;
  3) echo "verify:all BLOCKED: nothing failed, but not everything could be verified (exit 3)" ;;
  *) echo "verify:all FAIL (exit 1)" ;;
esac
exit "$CODE"
