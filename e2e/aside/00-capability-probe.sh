#!/usr/bin/env bash
# 00 capability probe (plan §9.1 F0, AC-A2).
#
# `aside --help` documents one call, openTab. This script finds out what `aside repl` can really
# do and records it in e2e/aside/out/capabilities.json; the scenarios use only what is recorded
# there as verified.
#
#   bash e2e/aside/00-capability-probe.sh
#
# How it decides. It serves a small page of its own on 127.0.0.1 (lib/probe-server.mjs, on the
# port of "scenario 0") that reports every event it really receives back to that server. A
# capability is `ok: true` only when the effect was seen there or read back from the page: a
# call that returns without doing anything does not count.
#
#   1. aside is installed and answers a trivial `aside repl "<code>"`
#   2. introspection: the REPL's global names and types, and the object openTab returns
#   3. a session: `aside repl` fed statement by statement over stdin keeps its state and its tabs
#   4. open, wait for an element, read text and attributes, evaluate in the page, localStorage,
#      click, fill (native input event), select, key press, reload, navigate, a second tab,
#      clicks in two tabs at once, screenshot, close
#   5. what happens to a tab when its session quits, when its invocation ends, when the session's
#      input ends without "exit", and when the session's process is stopped
#   6. `aside exec` is NOT run unless MAZE_E2E_PROBE_EXEC=1: it is driven by a model, bills the
#      user's model account and is not needed when the REPL can click.
#
# It drives the user's real Aside browser: it opens tabs on its own page only and closes them.
# It never lists, attaches to or touches a tab it did not open.
#
# Exit codes: 0 the probe ran and wrote the capability file (absent capabilities are findings,
# not failures); 1 aside cannot be used at all (the file says why); 2 a tool this script needs
# is missing or its port is taken.

set -uo pipefail

# shellcheck source=e2e/aside/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PROBE_PORT="$(maze_e2e_next_port 0)"
PROBE_URL="http://127.0.0.1:$PROBE_PORT"
# Working files of the probe (logs, the screenshot) stay out of the results directory.
PROBE_DIR="$WORK_ROOT/probe"
ASIDE_WORK_DIR="$PROBE_DIR"
ROWS="$PROBE_DIR/rows.tsv"
INTROSPECTION="$PROBE_DIR/introspection.json"
SERVER_PID=""
SESSION_BANNER=false

say() { echo "probe: $*"; }

# row <name> <true|false|null> <the call used> <evidence>
row() {
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$(printf '%s' "$4" | tr '\t\n' '  ')" >>"$ROWS"
  case "$2" in
    true) say "  verified  $1 ($3)" ;;
    false) say "  ABSENT    $1 ($3): $4" ;;
    *) say "  not run   $1: $4" ;;
  esac
}

# write_file <usable: true|false> <reason or empty> <raw output or empty>
write_file() {
  local introspection='{}'
  [ -s "$INTROSPECTION" ] && introspection="$(cat "$INTROSPECTION")"
  jq -n \
    --arg probedAt "$(now_utc)" --arg path "${ASIDE_BIN:-}" --arg version "${ASIDE_VERSION:-}" \
    --argjson usable "$1" --arg reason "$2" --arg output "$3" \
    --argjson browserSeen "${BROWSER_SEEN:-false}" --argjson banner "$SESSION_BANNER" \
    --arg unknownAccount "${UNKNOWN_ACCOUNT_OUTPUT:-}" --arg errorExit "${ERROR_EXIT:-}" \
    --arg probeUrl "$PROBE_URL" \
    --argjson repl "$introspection" \
    --rawfile rows "$ROWS" \
    '($rows | split("\n") | map(select(length > 0) | split("\t"))
      | map({ key: .[0], value: { ok: (if .[1] == "true" then true elif .[1] == "false" then false else null end), call: .[2], evidence: .[3] } })
      | from_entries) as $caps
    | ($caps | map_values(.ok == true)) as $ok
    | {
      schema: 1,
      probedAt: $probedAt,
      aside: {
        path: $path,
        version: $version,
        usable: $usable,
        reason: (if $reason == "" then null else $reason end),
        output: (if $output == "" then null else $output end),
        browserProcessSeen: $browserSeen,
        signedInAccountShown: $banner,
        needsRunningBrowser: "not tested: testing it would mean quitting the real browser of the user. The browser was running and an account was signed in when every check below was made.",
        whenAccountUnknown: (if $unknownAccount == "" then null else $unknownAccount end),
        exitCodeWhenCodeThrows: (if $errorExit == "" then null else $errorExit end)
      },
      probePage: $probeUrl,
      repl: $repl,
      capabilities: $caps,
      paths: {
        input: (if ($ok.session and $ok.openTab and $ok.click and $ok.fill and $ok.evalInPage) then "repl" else "none" end),
        read: (if $ok.readDom then "repl" else "beacon" end),
        inputRule: "repl when session, openTab, click, fill and evalInPage are verified; otherwise the scenario is BLOCKED (aside exec is not automated)",
        readRule: "A = repl reads the DOM when readDom is verified; otherwise B = TestBeacon and GET /api/test/ui-snapshot"
      },
      notes: [
        "A scenario is one aside repl session fed over stdin: a tab does not outlive the invocation that opened it.",
        "aside repl exits 0 even when the code threw; only the status line [ok | Nms] or [error | Nms] tells.",
        "page.goto with its default wait can time out on a page without interactive elements; { waitUntil: \"load\" } does not.",
        "locator.waitFor waits for visibility by default, so an empty element never satisfies it; the suite polls page.evaluate instead.",
        "page.screenshot may only write inside the session directory the REPL reports as pwd.",
        "Only a session that quits with exit closes its tabs. A tab left by a dead session can be closed from outside only with window.close() in the page, which works only while the tab has never navigated; closeTab and page.close on an attached tab only detach it, and chrome.tabs.remove is refused in the REPL.",
        "The REPL also exposes globals connected to the accounts of the user (mail, chat, documents, passwords). The suite calls none of them."
      ]
    }' >"$CAP_FILE.tmp" && mv "$CAP_FILE.tmp" "$CAP_FILE"
}

cleanup() {
  trap - EXIT INT TERM
  aside_stop
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then kill -TERM "$SERVER_PID" 2>/dev/null; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$OUT_DIR" "$PROBE_DIR"
: >"$ROWS"
rm -f "$INTROSPECTION"
for tool in jq curl node perl base64; do
  command -v "$tool" >/dev/null 2>&1 || { say "$tool is not installed"; exit 2; }
done

# ----- 1. is aside usable at all -----

if [ -z "$ASIDE_BIN" ] || [ ! -x "$ASIDE_BIN" ]; then
  write_file false "the aside command is not installed (looked in PATH and ~/.local/bin)" ""
  say "aside is not installed; wrote $CAP_FILE"
  exit 1
fi
ASIDE_VERSION="$(with_timeout 20 "$ASIDE_BIN" --version 2>&1 | redact | head -n 1)"
BROWSER_SEEN=false
if pgrep -f 'Aside.app/Contents/MacOS/Aside' >/dev/null 2>&1; then BROWSER_SEEN=true; fi
say "aside $ASIDE_VERSION at $ASIDE_BIN (browser process seen: $BROWSER_SEEN)"

TRIVIAL="$(with_timeout 60 "$ASIDE_BIN" repl "console.log('@@R ' + JSON.stringify({ sum: 1 + 1 }))" </dev/null 2>&1 | redact)"
if ! printf '%s\n' "$TRIVIAL" | grep -q '^@@R {"sum":2}$' || ! printf '%s\n' "$TRIVIAL" | grep -q '^\[ok |'; then
  write_file false "aside repl did not run a trivial statement within 60 seconds" "$(printf '%s\n' "$TRIVIAL" | head -n 20)"
  say "aside repl is not usable; this is what it printed:"
  printf '%s\n' "$TRIVIAL" | head -n 20
  say "wrote $CAP_FILE"
  exit 1
fi

# What it prints when it cannot serve: an account that does not exist, and code that throws.
UNKNOWN_ACCOUNT_OUTPUT="$(with_timeout 30 "$ASIDE_BIN" repl --account u999 "console.log(1)" </dev/null 2>&1 | redact | head -n 3 | paste -sd ' ' -)"
THROW_OUTPUT="$(with_timeout 30 "$ASIDE_BIN" repl "throw new Error('probe')" </dev/null 2>&1; echo "exit=$?")"
ERROR_EXIT="$(printf '%s\n' "$THROW_OUTPUT" | redact | sed -n 's/^exit=//p') (status line: $(printf '%s\n' "$THROW_OUTPUT" | redact | grep -m 1 -E '^\[(ok|error) \|' | sed 's/ |.*/]/'))"

# ----- the probe page -----

if port_in_use "$PROBE_PORT"; then
  say "port $PROBE_PORT is in use; the probe page cannot be served"
  exit 2
fi
nohup node "$E2E_DIR/lib/probe-server.mjs" "$PROBE_PORT" >"$PROBE_DIR/probe-server.log" 2>&1 </dev/null &
SERVER_PID=$!
for _ in $(seq 1 50); do
  curl -sf -m 2 "$PROBE_URL/hits" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -sf -m 2 "$PROBE_URL/hits" >/dev/null 2>&1 || { say "the probe page did not start"; exit 2; }
say "probe page on $PROBE_URL (pid $SERVER_PID)"

hits() { curl -s -m 5 "$PROBE_URL/hits"; }
# hit_count <what> [value] [tab]
hit_count() {
  hits | jq --arg w "$1" --arg v "${2:-}" --arg t "${3:-}" \
    '[.hits[] | select(.what == $w and ($v == "" or .value == $v) and ($t == "" or .tab == $t))] | length'
}
load_count() { hits | jq --arg p "$1" '[.requests[] | select(.path == $p)] | length'; }

# tab_open <tab id>: the page of that load is still reporting. A background tab's timers are
# slowed to one per second, so two samples 2.5 seconds apart decide.
tab_open() {
  local before after
  before="$(hit_count alive "" "$1")"
  sleep 2.5
  after="$(hit_count alive "" "$1")"
  [ "$after" -gt "$before" ]
}

# ----- 2. introspection -----

say "introspecting the REPL"
INTROSPECT_JS="$(cat <<'EOF'
const typeOf = (value) => { const t = typeof value; return t === 'function' ? 'function/' + value.length : t; };
const result = { globals: {}, page: null, locator: null, keyboard: null, mouse: null, tabsIsArray: Array.isArray(tabs), pageGlobalBefore: page === null ? 'null' : typeof page };
for (const name of Object.getOwnPropertyNames(globalThis).sort()) {
  try { result.globals[name] = typeOf(globalThis[name]); } catch (error) { result.globals[name] = 'throws'; }
}
const has = (object, names) => names.filter((name) => typeof object[name] === 'function');
const p = await openTab('__URL__/');
try {
  result.page = {
    tag: Object.prototype.toString.call(p),
    ownKeys: Reflect.ownKeys(p).map(String),
    targetIdType: typeof p.targetId,
    isTheGlobalPage: page === p,
    trackedInTabs: tabs.length,
    methods: has(p, ['goto', 'reload', 'goBack', 'goForward', 'url', 'title', 'content', 'close', 'evaluate', '$', '$$', '$eval', '$$eval', 'locator', 'getByTestId', 'getByText', 'getByRole', 'waitForSelector', 'waitForFunction', 'waitForLoadState', 'waitForTimeout', 'click', 'fill', 'type', 'press', 'screenshot', 'pdf', 'bringToFront', 'mainFrame', 'frames', 'snapshot', 'on', 'off']),
  };
  result.locator = { methods: has(p.locator('[data-testid="probe-click"]'), ['click', 'dblclick', 'fill', 'type', 'press', 'pressSequentially', 'textContent', 'innerText', 'innerHTML', 'getAttribute', 'inputValue', 'isVisible', 'isEnabled', 'isDisabled', 'count', 'first', 'nth', 'all', 'waitFor', 'evaluate', 'hover', 'focus', 'selectOption', 'check', 'dispatchEvent', 'boundingBox', 'scrollIntoViewIfNeeded', 'screenshot']) };
  result.keyboard = { methods: has(p.keyboard, ['press', 'type', 'down', 'up', 'insertText']) };
  result.mouse = { methods: has(p.mouse, ['click', 'dblclick', 'move', 'down', 'up', 'wheel']) };
} finally {
  await closeTab(p);
}
console.log('@@R ' + JSON.stringify(result));
EOF
)"
LOADS_BEFORE="$(load_count /)"
INTROSPECT_OUT="$(with_timeout 90 "$ASIDE_BIN" repl "${INTROSPECT_JS//__URL__/$PROBE_URL}" </dev/null 2>&1 | redact)"
printf '%s\n' "$INTROSPECT_OUT" | sed -n 's/^@@R //p' | tail -n 1 >"$INTROSPECTION"
if jq -e '.page.tag' "$INTROSPECTION" >/dev/null 2>&1; then
  row introspect true "Object.getOwnPropertyNames(globalThis); typeof page[name] over a list of candidate names" \
    "$(jq -r '"\(.globals | length) globals; openTab returns \(.page.tag) with \(.page.methods | length) of the candidate methods"' "$INTROSPECTION")"
else
  rm -f "$INTROSPECTION"
  row introspect false "aside repl \"<multi-line code>\"" "$(printf '%s\n' "$INTROSPECT_OUT" | tail -n 3 | paste -sd ' ' -)"
fi

# ----- 3. a session over stdin -----

say "opening a session (aside repl reading statements from a FIFO)"
if aside_start; then
  SESSION_BANNER="$(grep -q '^account: ' "$ASIDE_LOG" && echo true || echo false)"
  aside_js 20 'globalThis.__probe = 41'
  if aside_js 20 'M.out(__probe + 1)' && [ "$ASIDE_RESULT" = 42 ]; then
    row session true "aside repl < fifo, one statement per line" "a global set by one statement was read by the next; lib/prelude.js loaded"
  else
    row session false "aside repl < fifo" "state did not carry over: $ASIDE_ERROR"
  fi
else
  row session false "aside repl < fifo" "$(tail -n 5 "$ASIDE_LOG" 2>/dev/null | paste -sd ' ' -)"
fi

if ! aside_alive; then
  write_file true "" ""
  say "no session could be kept open, so nothing else can be probed; wrote $CAP_FILE"
  exit 0
fi

# ----- 4. real actions against the probe page -----

LOADS_BEFORE="$(load_count /)"
if ui 60 "M.open(\"P\", \"$PROBE_URL/\")" && [ "$(load_count /)" -gt "$LOADS_BEFORE" ]; then
  TARGET_P="$(ui_field '.targetId')"
  row openTab true "openTab(url)" "the page server received GET / after the call"
else
  row openTab false "openTab(url)" "${ASIDE_ERROR:-the page server saw no request}"
  write_file true "" ""
  say "no tab could be opened, so nothing else can be probed; wrote $CAP_FILE"
  exit 0
fi

if ui 20 'M.waitFor("P", { id: "probe-late" }, 5000)' && [ "$(ui_field '.ok')" = true ]; then
  row waitForSelector true "poll page.evaluate(querySelector) until present" "an element added 700 ms after load was found after $(ui_field '.waitedMs') ms"
else
  row waitForSelector false "poll page.evaluate" "${ASIDE_ERROR:-the late element was not found}"
fi

if ui 20 'M.read("P", ["probe-known", "probe-tab"])' &&
  [ "$(ui_field '.["probe-known"].text')" = "known text 0.95" ] &&
  [ "$(ui_field '.["probe-known"].attrs["data-wei"]')" = "950000000000000000" ]; then
  TAB_P="$(ui_field '.["probe-tab"].attrs["data-tab"]')"
  row readDom true "page.evaluate(fn, arg) returning text and attributes" "text \"known text 0.95\" and data-wei 950000000000000000 came back to the shell"
else
  TAB_P=""
  row readDom false "page.evaluate(fn, arg)" "${ASIDE_ERROR:-wrong value: $ASIDE_RESULT}"
fi

if aside_js 20 'M.out(await tabs[0].evaluate((input) => ({ sum: input.a + 1, title: document.title }), { a: 41 }))' &&
  [ "$(ui_field '.sum')" = 42 ] && [ "$(ui_field '.title')" = "maze aside probe" ]; then
  row evalInPage true "page.evaluate(fn, arg)" "an argument went in and an object with document.title came back"
else
  row evalInPage false "page.evaluate(fn, arg)" "${ASIDE_ERROR:-wrong value: $ASIDE_RESULT}"
fi

aside_js 20 'M.out(await tabs[0].evaluate(() => { localStorage.setItem("maze:probe", "1"); return localStorage.getItem("maze:probe"); }))'
SET_RESULT="$ASIDE_RESULT"
if ui 20 'M.storage("P", "keys")' && printf '%s' "$ASIDE_RESULT" | jq -e 'index("maze:probe") != null' >/dev/null 2>&1 &&
  ui 20 'M.storage("P", "clear")' && [ "$ASIDE_RESULT" = 1 ] && ui 20 'M.storage("P", "keys")' && [ "$ASIDE_RESULT" = "[]" ]; then
  row localStorage true "page.evaluate reading and removing localStorage keys that start with maze:" "a key was written, listed, removed and gone"
else
  row localStorage false "page.evaluate on localStorage" "${ASIDE_ERROR:-set $SET_RESULT, then $ASIDE_RESULT}"
fi

CLICKS_BEFORE="$(hit_count click trusted)"
if ui_click P probe-click 5 && sleep 0.4 && [ "$(hit_count click trusted)" -eq $((CLICKS_BEFORE + 1)) ]; then
  row click true "page.locator('[data-testid=\"...\"]').click()" "the page server received one trusted click"
else
  row click false "page.locator(sel).click()" "${ASIDE_ERROR:-the page server saw $(hit_count click) click(s)}"
fi

ui 20 'M.click("P", "probe-disabled", 600)'
if [ "$(ui_field '.ok')" = false ] && [ "$(hit_count disabled-click)" -eq 0 ]; then
  row clickRefusedWhenDisabled true "M.click waits for an enabled element" "a disabled button was reported as $(ui_field '.reason') and received no click"
else
  row clickRefusedWhenDisabled false "M.click on a disabled element" "result $ASIDE_RESULT, disabled-click hits $(hit_count disabled-click)"
fi

if ui_fill P probe-input 0.05 && sleep 0.4 && [ "$(hit_count input 0.05)" -ge 1 ]; then
  ui 20 'M.read("P", ["probe-echo"])'
  row fill true "page.locator(sel).fill(value)" "a native input listener saw \"0.05\" (events: $(ui_field '.["probe-echo"].attrs["data-events"]'))"
else
  row fill false "page.locator(sel).fill(value)" "${ASIDE_ERROR:-the input listener of the page did not see the value}"
fi

if ui 20 'M.select("P", "probe-select", "3")' && sleep 0.4 && [ "$(hit_count select 3)" -ge 1 ]; then
  row select true "page.locator(sel).selectOption(value)" "the page's change listener saw \"3\""
else
  row select false "page.locator(sel).selectOption(value)" "${ASIDE_ERROR:-no change event}"
fi

if ui_press P ArrowRight && sleep 0.4 && [ "$(hit_count key ArrowRight)" -ge 1 ]; then
  row pressKey true "page.keyboard.press('ArrowRight')" "a window keydown listener saw code ArrowRight"
else
  row pressKey false "page.keyboard.press(key)" "${ASIDE_ERROR:-no keydown reached the page}"
fi

# The page draws a new random id on every load, so a reload shows as a changed id.
LOADS_BEFORE="$(load_count /)"
ui 30 'M.reload("P")'
if ui 20 "M.waitFor(\"P\", { id: \"probe-tab\", attr: \"data-tab\", notEquals: \"$TAB_P\" }, 8000)" && [ "$(ui_field '.ok')" = true ] &&
  [ "$(load_count /)" -eq $((LOADS_BEFORE + 1)) ]; then
  TAB_P="$(ui_field '.item.attrs["data-tab"]')"
  row reload true "page.reload(), then wait for an element" "the page server received one more GET / and the page came back as a new load"
else
  row reload false "page.reload()" "${ASIDE_ERROR:-the page was not loaded again}"
fi

# In a tab of its own, closed right away: a tab that has navigated cannot be closed from outside
# its session any more (see lib.sh aside_stop), so the scenarios never navigate a tab.
if ui 60 "M.open(\"N\", \"$PROBE_URL/\")" && ui 40 "M.go(\"N\", \"$PROBE_URL/second\")" &&
  ui 20 'M.waitFor("N", { id: "second-title", text: "second tab" }, 5000)' && [ "$(ui_field '.ok')" = true ]; then
  row navigate true "page.goto(url, { waitUntil: 'load' })" "the tab went from / to /second and the second page was read"
else
  row navigate false "page.goto(url, { waitUntil: 'load' })" "${ASIDE_ERROR:-the target page was not read}"
fi
ui 30 'M.close("N")'

TAB_Q=""
if ui 60 "M.open(\"Q\", \"$PROBE_URL/\")" && ui 20 'M.read("Q", ["probe-tab"])'; then
  TAB_Q="$(ui_field '.["probe-tab"].attrs["data-tab"]')"
fi
ui 20 'M.read("P", ["probe-tab"])'
if [ -n "$TAB_Q" ] && [ -n "$TAB_P" ] && [ "$TAB_Q" != "$TAB_P" ] && [ "$(ui_field '.["probe-tab"].attrs["data-tab"]')" = "$TAB_P" ]; then
  row multiTab true "openTab twice; each returned object addresses its own tab" "two tabs with different page ids were read one after the other"
else
  row multiTab false "openTab twice" "${ASIDE_ERROR:-tab ids P=\"$TAB_P\" Q=\"$TAB_Q\"}"
fi

if [ -n "$TAB_Q" ]; then
  P_BEFORE="$(hit_count click trusted "$TAB_P")"
  Q_BEFORE="$(hit_count click trusted "$TAB_Q")"
  if ui 30 'M.race("P", "probe-click", "Q", "probe-click")' && sleep 0.5 &&
    [ "$(hit_count click trusted "$TAB_P")" -eq $((P_BEFORE + 1)) ] && [ "$(hit_count click trusted "$TAB_Q")" -eq $((Q_BEFORE + 1)) ]; then
    row parallelClicks true "Promise.all of locator.click() in two tabs" "each tab's page reported one click, the background tab included"
  else
    row parallelClicks false "Promise.all of two clicks" "${ASIDE_ERROR:-clicks P $(hit_count click trusted "$TAB_P"), Q $(hit_count click trusted "$TAB_Q")}"
  fi
else
  row parallelClicks null "Promise.all of two clicks" "no second tab"
fi

if ui 30 'M.shot("P", "probe-shot.png")' && [ -s "$(ui_field '.path')" ]; then
  cp "$(ui_field '.path')" "$PROBE_DIR/probe-shot.png"
  row screenshot true "page.screenshot({ path }) inside the session directory" "a PNG of $(ui_field '.size') bytes was written and copied to ${PROBE_DIR#"$ROOT_DIR"/}/probe-shot.png"
else
  row screenshot false "page.screenshot({ path })" "${ASIDE_ERROR:-no file}"
fi

if [ -n "$TAB_Q" ]; then
  if tab_open "$TAB_Q" && ui 30 'M.close("Q")' && ! tab_open "$TAB_Q"; then
    row closeTab true "closeTab(page)" "the closed tab's page stopped reporting to the page server; the other tab kept reporting"
  else
    row closeTab false "closeTab(page)" "${ASIDE_ERROR:-the tab kept reporting after closeTab}"
  fi
else
  row closeTab null "closeTab(page)" "no second tab"
fi

# ----- 5. what happens to tabs when the session goes away -----

# close_own <target id>: closes a tab of this probe that Aside left open (lib.sh
# close_leftover_tab) and remembers whether that worked.
LEFTOVER_STATES=""
close_own() {
  local state
  state="$(close_leftover_tab "$1")"
  LEFTOVER_STATES="$LEFTOVER_STATES $state"
  if [ "$state" = left-open ]; then say "WARNING: a probe tab could not be closed (target $1); it now shows about:blank"; fi
}

say "quitting the session with a tab still open"
if [ -n "$TAB_P" ] && tab_open "$TAB_P"; then
  printf 'exit\n' >&9
  for _ in $(seq 1 50); do
    kill -0 "$ASIDE_PID" 2>/dev/null || break
    sleep 0.1
  done
  if tab_open "$TAB_P"; then
    row tabsClosedWhenSessionEnds false "exit with a tab open" "the tab kept reporting after the session quit"
    close_own "$TARGET_P"
  else
    row tabsClosedWhenSessionEnds true "exit with a tab open" "the tab stopped reporting once the session had quit"
  fi
else
  row tabsClosedWhenSessionEnds null "exit with a tab open" "the first tab was not reporting"
fi
aside_stop

say "ending an invocation with a tab still open"
ONE_SHOT="$(with_timeout 60 "$ASIDE_BIN" repl "const p = await openTab('$PROBE_URL/'); console.log('@@R ' + JSON.stringify({ targetId: p.targetId, tab: await p.evaluate(() => document.querySelector('[data-testid=\"probe-tab\"]').dataset.tab) }));" </dev/null 2>&1 | redact | sed -n 's/^@@R //p' | tail -n 1)"
TAB_O="$(printf '%s' "$ONE_SHOT" | jq -r '.tab // empty' 2>/dev/null)"
TARGET_O="$(printf '%s' "$ONE_SHOT" | jq -r '.targetId // empty' 2>/dev/null)"
if [ -z "$TAB_O" ]; then
  row tabSurvivesInvocation null "aside repl \"await openTab(url)\" then a second invocation" "the tab's page id could not be read"
elif tab_open "$TAB_O"; then
  row tabSurvivesInvocation true "aside repl \"await openTab(url)\"" "the tab kept reporting after the command returned"
  close_own "$TARGET_O"
else
  row tabSurvivesInvocation false "aside repl \"await openTab(url)\"" "the tab stopped reporting when the command returned: a scenario must stay inside one session"
fi

say "closing a session's stdin with a tab still open"
if aside_start && ui 60 "M.open(\"E\", \"$PROBE_URL/\")"; then
  TARGET_E="$(ui_field '.targetId')"
  ui 20 'M.read("E", ["probe-tab"])'
  TAB_E="$(ui_field '.["probe-tab"].attrs["data-tab"]')"
  if [ -n "$TAB_E" ] && tab_open "$TAB_E"; then
    # What the REPL sees when the shell driving it goes away without saying "exit".
    exec 9>&-
    for _ in $(seq 1 50); do
      kill -0 "$ASIDE_PID" 2>/dev/null || break
      sleep 0.1
    done
    if tab_open "$TAB_E"; then
      row tabsClosedWhenStdinCloses false "end of input without exit" "the tab kept reporting after the input of its session had ended"
      kill -0 "$ASIDE_PID" 2>/dev/null && kill -TERM "$ASIDE_PID" 2>/dev/null
      close_own "$TARGET_E"
    else
      row tabsClosedWhenStdinCloses true "end of input without exit" "the tab stopped reporting once the input had ended"
    fi
  else
    row tabsClosedWhenStdinCloses null "end of input without exit" "the tab was not reporting"
  fi
else
  row tabsClosedWhenStdinCloses null "end of input without exit" "a session could not be opened: $ASIDE_ERROR"
fi
aside_stop

say "stopping a session's process with a tab still open"
if aside_start && ui 60 "M.open(\"K\", \"$PROBE_URL/\")"; then
  TARGET_K="$(ui_field '.targetId')"
  ui 20 'M.read("K", ["probe-tab"])'
  TAB_K="$(ui_field '.["probe-tab"].attrs["data-tab"]')"
  if [ -n "$TAB_K" ] && tab_open "$TAB_K"; then
    kill -TERM "$ASIDE_PID" 2>/dev/null
    for _ in $(seq 1 50); do
      kill -0 "$ASIDE_PID" 2>/dev/null || break
      sleep 0.1
    done
    if tab_open "$TAB_K"; then
      row tabsClosedWhenSessionKilled false "SIGTERM to the aside repl process" "the tab kept reporting after the process of its session was stopped"
      close_own "$TARGET_K"
    else
      row tabsClosedWhenSessionKilled true "SIGTERM to the aside repl process" "the tab stopped reporting after the process was stopped"
    fi
  else
    row tabsClosedWhenSessionKilled null "SIGTERM to the aside repl process" "the tab was not reporting"
  fi
else
  row tabsClosedWhenSessionKilled null "SIGTERM to the aside repl process" "a second session could not be opened: $ASIDE_ERROR"
fi
aside_stop

case "$LEFTOVER_STATES" in
  "") row leftoverTabClosable null "attachBrowserTab(targetId), then window.close() in the page" "no tab was left open" ;;
  *left-open* | *not-ours*) row leftoverTabClosable false "attachBrowserTab(targetId), then window.close() in the page" "states:$LEFTOVER_STATES" ;;
  *) row leftoverTabClosable true "attachBrowserTab(targetId), then window.close() in the page" "every tab a dead session had left open was closed this way (states:$LEFTOVER_STATES); it works only for a tab that never navigated" ;;
esac

# ----- 6. aside exec (model-driven), only on request -----

if [ "${MAZE_E2E_PROBE_EXEC:-0}" = 1 ]; then
  say "running aside exec (model-driven; uses the model account configured in Aside)"
  CLICKS_BEFORE="$(hit_count click)"
  with_timeout 240 "$ASIDE_BIN" exec "Open $PROBE_URL/ in a new tab. Click the button whose data-testid attribute is probe-click exactly once. Then close that tab. Do not open, read or change any other tab or site." </dev/null 2>&1 | redact >"$PROBE_DIR/probe-exec.log"
  sleep 1
  if [ "$(hit_count click)" -gt "$CLICKS_BEFORE" ]; then
    row execClick true "aside exec \"<explicit step>\"" "the page server received a click after the agent ran"
  else
    row execClick false "aside exec \"<explicit step>\"" "no click reached the page server (see ${PROBE_DIR#"$ROOT_DIR"/}/probe-exec.log)"
  fi
else
  row execClick null "aside exec \"<explicit step>\"" "not run: model-driven, non-deterministic and billed to the user's model account; the REPL covers every step. MAZE_E2E_PROBE_EXEC=1 runs it"
fi

write_file true "" ""
say "wrote $CAP_FILE"
jq -r '"probe: input path \(.paths.input), DOM read path \(.paths.read)", (.capabilities | to_entries[] | "probe:   \(.key): \(if .value.ok == null then "not run" else (.value.ok | tostring) end)")' "$CAP_FILE"
exit 0
