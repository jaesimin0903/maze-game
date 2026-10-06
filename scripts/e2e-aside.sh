#!/usr/bin/env bash
# Runs the browser end-to-end scenarios of e2e/aside with the `aside` CLI (plan §9.1, AC-A1):
# capability probe, one build, then every scenario on its own Anvil, data directory and app
# port, a result table, and cleanup.
#
#   pnpm e2e:aside                         every scenario, test table
#   pnpm e2e:aside --table production      the production table with only the seed hook on
#                                          (plan §8.5 step 5.3; this runner starts the stack
#                                          itself, `pnpm start:web` refuses hook flags)
#   pnpm e2e:aside 03                      one scenario; also: --only 03,06
#   pnpm e2e:aside --probe                 run the capability probe again first
#   pnpm e2e:aside --no-build              reuse the build of an earlier run
#   pnpm e2e:aside --build-each            one build per scenario (.next-f-<i>) instead of one
#   pnpm e2e:aside --read-path beacon      read the DOM through TestBeacon (path B) even where
#                                          the REPL can read it (path A)
#   pnpm e2e:aside --with-exec             also run the advisory scenario 09 with `aside exec`
#                                          (model-driven, billed to the model account of Aside)
#
# This suite drives the user's real Aside browser. It opens its own tabs on 127.0.0.1 only and
# closes them; see e2e/aside/README.md.
#
# The stacks run with test hooks (scripts/dev-up.sh --allow-test-hooks, built in one place:
# dev_up in e2e/aside/lib.sh). The seed-hook secret is random and new for every run; set
# MAZE_TEST_SEED_SECRET to repeat a run with the secret its log shows.
#
# Scenarios run one at a time, in this order: 01 02 03 04 06 07 08 09 11 12, then the two that
# move the chain clock, 10 and 05 (05 last). By default one build (apps/web/.next-f-0) serves all
# of them: the app reads its chain settings from /api/config at run time.
#
# Verdicts (plan §9.1): PASS = the on-chain, HTTP and DOM assertions all ran and passed;
# FAIL = an assertion that ran failed, or the scenario could not finish; BLOCKED = the DOM
# assertions could not be executed or the page could not be driven. Scenario 09 is advisory:
# it is NOT-RUN unless --with-exec, and never decides the exit code.
#
# Output: e2e/aside/out/results.json, e2e/aside/out/report.md, e2e/aside/out/scenarios/<NN>.json;
# logs under .data/e2e-aside/<run id>/.
# Exit codes: 0 every scenario PASS, 1 at least one FAIL, 3 no FAIL but at least one BLOCKED,
# 2 usage or setup error.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
E2E_DIR="$ROOT_DIR/e2e/aside"
# shellcheck source=scripts/ports.sh
. "$SCRIPT_DIR/ports.sh"

ORDER="01 02 03 04 06 07 08 09 11 12 10 05"
ADVISORY="09"
OUT_DIR="${MAZE_E2E_OUT_DIR:-$E2E_DIR/out}"
CAP_FILE="$OUT_DIR/capabilities.json"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
WORK_DIR="${MAZE_E2E_WORK_DIR:-$ROOT_DIR/.data/e2e-aside}/$RUN_ID"

TABLE="${MAZE_E2E_TABLE:-fixture}"
ONLY=""
PROBE=0
BUILD=once
WITH_EXEC="${MAZE_E2E_EXEC:-0}"
READ_PATH="${MAZE_E2E_READ_PATH:-}"
# One seed-hook secret for the whole run, handed to every scenario (lib.sh gives it to the
# server and to the offline route planner). Random unless the caller repeats an earlier run.
SEED_SECRET="${MAZE_TEST_SEED_SECRET:-$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')}"

say() { echo "e2e:aside: $*"; }
usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --table) [ $# -ge 2 ] || usage; TABLE="$2"; shift 2 ;;
    --only) [ $# -ge 2 ] || usage; ONLY="$ONLY,$2"; shift 2 ;;
    --probe) PROBE=1; shift ;;
    --no-build) BUILD=none; shift ;;
    --build-each) BUILD=each; shift ;;
    --read-path) [ $# -ge 2 ] || usage; READ_PATH="$2"; shift 2 ;;
    --with-exec) WITH_EXEC=1; shift ;;
    --) shift ;;
    -h | --help) usage ;;
    [0-9] | [0-9][0-9]) ONLY="$ONLY,$1"; shift ;;
    *) echo "e2e:aside: unknown argument \"$1\"" >&2; usage ;;
  esac
done
case "$TABLE" in fixture | production) ;; *) echo "e2e:aside: --table must be fixture or production" >&2; exit 2 ;; esac
case "$READ_PATH" in "" | repl | beacon) ;; *) echo "e2e:aside: --read-path must be repl or beacon" >&2; exit 2 ;; esac

for tool in jq curl cast anvil node pnpm bc perl; do
  command -v "$tool" >/dev/null 2>&1 || { say "$tool is not installed"; exit 2; }
done
[ "${#SEED_SECRET}" -ge 16 ] || { say "could not draw a seed secret from /dev/urandom (set MAZE_TEST_SEED_SECRET)"; exit 2; }

# ----- which scenarios -----

script_of() { ls "$E2E_DIR/$1"-*.sh 2>/dev/null | head -n 1; }

SELECTED=""
if [ -z "$ONLY" ]; then
  SELECTED="$ORDER"
else
  for wanted in $(printf '%s' "$ONLY" | tr ',' ' '); do
    wanted="$(printf '%02d' "$((10#$wanted))")"
    case " $ORDER " in *" $wanted "*) ;; *) say "there is no scenario $wanted (scenarios: $ORDER)"; exit 2 ;; esac
  done
  for num in $ORDER; do
    for wanted in $(printf '%s' "$ONLY" | tr ',' ' '); do
      [ "$(printf '%02d' "$((10#$wanted))")" = "$num" ] && SELECTED="$SELECTED $num" && break
    done
  done
fi
PARTIAL=false
[ "$(echo $SELECTED)" = "$ORDER" ] || PARTIAL=true
for num in $SELECTED; do
  [ -n "$(script_of "$num")" ] || { say "e2e/aside/$num-*.sh is missing"; exit 2; }
done

mkdir -p "$OUT_DIR/scenarios" "$WORK_DIR"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
say "run $RUN_ID, table $TABLE, scenarios:$(printf ' %s' $SELECTED)"

# ----- 1. capability probe -----

if [ "$PROBE" -eq 1 ] || [ ! -f "$CAP_FILE" ] || [ "$(jq -r '.aside.usable // false' "$CAP_FILE" 2>/dev/null)" != true ]; then
  say "running the capability probe (e2e/aside/00-capability-probe.sh)"
  PROBE_CODE=0
  bash "$E2E_DIR/00-capability-probe.sh" 2>&1 | tee "$WORK_DIR/probe.log"
  PROBE_CODE="${PIPESTATUS[0]}"
  if [ "$PROBE_CODE" -eq 2 ]; then
    say "the capability probe could not run (see above)"
    exit 2
  fi
  [ "$PROBE_CODE" -eq 0 ] || say "aside cannot be used ($(jq -r '.aside.reason // "no reason recorded"' "$CAP_FILE" 2>/dev/null)); the scenarios will be BLOCKED"
else
  say "using the capability file of $(jq -r '.probedAt' "$CAP_FILE") (--probe runs the probe again)"
fi

# ----- 2. build -----

DIST_DIR="$(maze_e2e_dist_dir 0)"
case "$BUILD" in
  once)
    say "building the app once into apps/web/$DIST_DIR"
    if ! (cd "$ROOT_DIR" && env -u MAZE_ALLOW_TEST_HOOKS -u MAZE_TEST_SEED_SECRET -u MAZE_TUNING_FIXTURE \
      NEXT_DIST_DIR="$DIST_DIR" pnpm --filter @maze/web build) >"$WORK_DIR/build.log" 2>&1; then
      tail -n 30 "$WORK_DIR/build.log"
      say "the app did not build (log: ${WORK_DIR#"$ROOT_DIR"/}/build.log)"
      BUILD=failed
    fi
    export MAZE_E2E_DIST_DIR="$DIST_DIR"
    ;;
  none)
    [ -f "$ROOT_DIR/apps/web/$DIST_DIR/BUILD_ID" ] || { say "--no-build: there is no build in apps/web/$DIST_DIR"; exit 2; }
    say "reusing the build in apps/web/$DIST_DIR"
    export MAZE_E2E_DIST_DIR="$DIST_DIR"
    ;;
  each)
    say "building per scenario (.next-f-<i>)"
    unset MAZE_E2E_DIST_DIR
    export MAZE_E2E_REBUILD=1
    ;;
esac

# ----- 3. the scenarios -----

RESULTS="$WORK_DIR/results.jsonl"
: >"$RESULTS"

# synthetic <number> <script> <result> <reason>: a result for a scenario that wrote none.
synthetic() {
  jq -cn --arg scenario "$1" --arg name "$(basename "$2" .sh | cut -c4-)" --arg result "$3" --arg reason "$4" --arg run "$RUN_ID" \
    --arg table "$TABLE" '{ scenario: $scenario, name: $name, proves: "", runId: $run, result: $result, reason: $reason, tableMode: $table,
      inputPath: "none", readPath: "none", seconds: 0, evidence: {}, assertions: [], counts: {} }'
}

for num in $SELECTED; do
  script="$(script_of "$num")"
  result_file="$OUT_DIR/scenarios/$num.json"
  echo
  echo "== $num $(basename "$script")"
  if [ "$BUILD" = failed ] && [ "$num" != "$ADVISORY" ]; then
    synthetic "$num" "$script" FAIL "the app did not build" | tee "$result_file" >>"$RESULTS"
    echo "RESULT $num: FAIL (the app did not build)"
    continue
  fi
  mkdir -p "$WORK_DIR/$num"
  CODE=0
  env MAZE_E2E_TABLE="$TABLE" MAZE_E2E_RUN_ID="$RUN_ID" MAZE_E2E_EXEC="$WITH_EXEC" MAZE_E2E_READ_PATH="$READ_PATH" \
    MAZE_E2E_OUT_DIR="$OUT_DIR" MAZE_TEST_SEED_SECRET="$SEED_SECRET" bash "$script" 2>&1 | tee "$WORK_DIR/$num/run.log"
  CODE="${PIPESTATUS[0]}"
  if [ -f "$result_file" ] && [ "$(jq -r '.runId' "$result_file" 2>/dev/null)" = "$RUN_ID" ]; then
    jq -c '.' "$result_file" >>"$RESULTS"
  else
    synthetic "$num" "$script" FAIL "the scenario wrote no result (exit code $CODE)" | tee "$result_file" >>"$RESULTS"
  fi
done

# ----- 4. summary -----

SUMMARY="$(jq -s --arg run "$RUN_ID" --arg started "$STARTED_AT" --arg finished "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg table "$TABLE" --argjson partial "$PARTIAL" --arg advisory "$ADVISORY" \
  --arg selected "$(echo $SELECTED)" --slurpfile caps "$CAP_FILE" '
  map(. + { advisory: (.scenario == $advisory) }) as $all
  | ($all | map(select(.advisory | not))) as $counted
  | { PASS: 0, FAIL: 0, BLOCKED: 0, "NOT-RUN": 0 } as $zero
  | ($counted | reduce .[] as $s ($zero; .[$s.result] += 1)) as $totals
  | (if ($counted | length) == 0 then
       ({ PASS: 0, FAIL: 1, BLOCKED: 3, "NOT-RUN": 4 }[($all[0].result // "FAIL")] // 1)
     elif $totals.FAIL > 0 then 1 elif $totals.BLOCKED > 0 then 3 else 0 end) as $exit
  | {
      schema: 1, runId: $run, startedAt: $started, finishedAt: $finished, tableMode: $table,
      partial: $partial, selected: ($selected | split(" ")),
      paths: { input: ($caps[0].paths.input // "none"), read: ($caps[0].paths.read // "none") },
      capabilitiesProbedAt: ($caps[0].probedAt // null),
      scenarios: $all, totals: $totals, exit: $exit
    }' "$RESULTS")"
printf '%s\n' "$SUMMARY" >"$OUT_DIR/results.json"

jq -r '
  def cell: tostring | gsub("\\|"; "/");
  "# aside scenarios: run \(.runId)",
  "",
  "- started \(.startedAt), finished \(.finishedAt)",
  "- table: \(.tableMode)\(if .partial then " (PARTIAL RUN: only \(.selected | join(", ")))" else "" end)",
  "- input path: \(.paths.input); DOM read path: \(.paths.read) (capabilities probed \(.capabilitiesProbedAt))",
  "- totals (scenario 09 is advisory and not counted): \(.totals.PASS) PASS, \(.totals.FAIL) FAIL, \(.totals.BLOCKED) BLOCKED; exit code \(.exit)",
  "- no scenario uses real random seeds: the server seed comes from the game id through the test seed hook, the client seed is fixed per scenario",
  "",
  "| # | scenario | result | input | read | chain | HTTP | DOM | seconds | reason |",
  "|---|---|---|---|---|---|---|---|---|---|",
  (.scenarios[] | "| \(.scenario) | \(.name)\(if .advisory then " (advisory)" else "" end) | \(.result) | \(.inputPath) | \(.readPath) | \(.counts["chain.PASS"] // 0) | \(.counts["http.PASS"] // 0) | \(.counts["dom.PASS"] // 0) | \(.seconds) | \(.reason | cell) |"),
  "",
  (.scenarios[] |
    "## \(.scenario) \(.name): \(.result)",
    "",
    (if .proves != "" then "What it proves: \(.proves)" else empty end),
    "",
    "Reason: \(.reason)",
    "",
    (if (.evidence | length) > 0 then "Evidence: " + (.evidence | to_entries | map("\(.key) `\(.value)`") | join(", ")) else empty end),
    (if (.logs // "") != "" then "Logs: `\(.logs)`" else empty end),
    "",
    (.assertions[] | "- \(.status) [\(.kind)] \(.label)\(if .status != "PASS" then " (expected `\(.expected)`, got `\(.actual)`)" else "" end)"),
    "")
' "$OUT_DIR/results.json" >"$OUT_DIR/report.md"

echo
echo "aside scenarios ($TABLE table)"
jq -r '.scenarios[] | [.scenario, .name + (if .advisory then " (advisory)" else "" end), .result,
  "\(.counts["chain.PASS"] // 0)/\(.counts["http.PASS"] // 0)/\(.counts["dom.PASS"] // 0)", "\(.seconds)s", .reason] | @tsv' "$OUT_DIR/results.json" |
  awk -F'\t' 'BEGIN { printf "  %-3s %-28s %-8s %-12s %-6s %s\n", "#", "scenario", "result", "chain/http/dom", "time", "reason" }
    { printf "  %-3s %-28s %-8s %-12s %-6s %s\n", $1, $2, $3, $4, $5, $6 }'
echo
EXIT_CODE="$(jq -r '.exit' "$OUT_DIR/results.json")"
say "$(jq -r '"\(.totals.PASS) PASS, \(.totals.FAIL) FAIL, \(.totals.BLOCKED) BLOCKED"' "$OUT_DIR/results.json")$([ "$PARTIAL" = true ] && echo " (partial run)")"
say "results in ${OUT_DIR#"$ROOT_DIR"/}/results.json and report.md, logs in ${WORK_DIR#"$ROOT_DIR"/}/"
case "$EXIT_CODE" in
  0) say "PASS" ;;
  3) say "BLOCKED: nothing failed, but not every DOM assertion could be executed (exit 3)" ;;
  4) say "NOT-RUN: only the advisory scenario was selected and it was not requested (exit 4)" ;;
  *) say "FAIL (exit $EXIT_CODE)" ;;
esac
exit "$EXIT_CODE"
