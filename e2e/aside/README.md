# Browser end-to-end scenarios, driven by the `aside` CLI

These scripts play the finished game in a real browser, through the page, and check what
happened on the chain, over HTTP and in the DOM (plan §9.1, AC-A1 to AC-A7).

**They drive your real Aside browser.** `aside` is not a throwaway test browser: the suite opens
its own tabs in the Aside window you have open, on `http://127.0.0.1:<port>` only, and closes
them. See "Side effects on your browser" before running it.

## Running

```sh
pnpm e2e:aside                      # probe if needed, build once, every scenario, test table
pnpm e2e:aside 03                   # one scenario (also: --only 03,06)
pnpm e2e:aside --no-build           # reuse the build of the previous run (apps/web/.next-f-0)
pnpm e2e:aside --table production   # production table, only the seed hook on (plan §8.5, 5.3)
pnpm e2e:aside --probe              # run the capability probe again first
pnpm e2e:aside --read-path beacon   # read the DOM through TestBeacon instead of the REPL
pnpm e2e:aside --with-exec          # also run the advisory scenario 09 (`aside exec`)
bash e2e/aside/03-cashout.sh        # a scenario by itself (set MAZE_E2E_DIST_DIR=.next-f-0 to
                                    # reuse the runner's build)
bash e2e/aside/00-capability-probe.sh

# The production-table run kept next to the test-table run instead of replacing it
# (results in e2e/aside/out/production/; the directory has no capability file at first, so the
# probe runs):
MAZE_E2E_OUT_DIR="$PWD/e2e/aside/out/production" pnpm e2e:aside --table production
```

`pnpm verify:all` runs `pnpm e2e:aside`, that is the test table, and writes to `out/`.

Needs: Aside running and signed in, `anvil` and `cast` (Foundry), `node`, `pnpm`, `jq`, `curl`,
`bc`, `perl`. The scripts are written for the bash 3.2 of macOS.

Exit codes of the runner: `0` every scenario PASS, `1` at least one FAIL, `3` no FAIL but at
least one BLOCKED, `2` usage or setup error. A scenario script exits `0`, `1`, `3` the same way
(and `4` for scenario 09 when it was not requested).

A full run takes about five minutes: the build about 45 seconds, each scenario 15 to 40 seconds
(a stack starts in about 4 seconds), plus about 75 seconds when the probe runs.

## Verdicts

| Verdict | When |
|---|---|
| PASS | on-chain, HTTP and DOM assertions all ran and all passed |
| FAIL | an assertion that ran failed, or the scenario could not finish (the reason says where) |
| BLOCKED | the DOM assertions could not be executed, or the page could not be driven at all; the on-chain and HTTP assertions still ran and are counted separately |

BLOCKED is never counted as PASS. On-chain assertions use `cast`, HTTP assertions use `curl`;
both are hard assertions in every scenario.

## What the probe found (`out/capabilities.json`)

`aside --help` documents `openTab` only. `00-capability-probe.sh` serves a small page of its own
and counts a capability as verified only when that page's server saw the effect, or the value
came back to the shell. Result on Aside 1.26:

| Capability | Verified | Call |
|---|---|---|
| introspect | yes | 116 globals; `openTab` returns a Playwright-like `AsidePage` |
| session (state and tabs kept between statements) | yes | `aside repl` fed one statement per line over stdin |
| openTab, closeTab | yes | `openTab(url)`, `closeTab(page)` |
| wait for an element | yes | polling `page.evaluate` (not `locator.waitFor`, which waits for visibility) |
| readDom, evalInPage, localStorage | yes | `page.evaluate(fn, arg)` |
| click (trusted event), refused on a disabled element | yes | `page.locator(sel).click()` |
| fill (native `input` event), select | yes | `locator.fill`, `locator.selectOption` |
| key press | yes | `page.keyboard.press('ArrowRight')` |
| reload, navigate | yes | `page.reload()`, `page.goto(url, { waitUntil: 'load' })` |
| two tabs, clicks in both at once | yes | two `openTab` results, `Promise.all` of two clicks |
| screenshot | yes | `page.screenshot({ path })`, inside the session directory only |
| a tab survives its invocation | **no** | the tab is closed when `aside repl "<code>"` returns |
| tabs closed when the session's input ends, or its process is stopped | **no** | the tab stays open |
| a tab left open can be closed afterwards | only if it never navigated | `window.close()` in the page |
| `aside exec` clicking | not run | model-driven and billed to your model account; not needed |

Other things learnt: `aside repl` exits `0` even when the code threw (only the status line
`[ok | 12ms]` / `[error | 12ms]` tells); `page.goto` with its default wait can time out on a
page without interactive elements; the REPL also has globals connected to your accounts (mail,
chat, documents, passwords) and to `chrome.tabs`. The suite calls none of them.

### Driving path and DOM read path

- **Input: `aside repl`.** A scenario is one `aside repl` session that reads statements from a
  FIFO for as long as the scenario runs (`lib.sh`, `aside_start` / `aside_js`), with
  `lib/prelude.js` loaded into it. It has to be one session because a tab does not outlive its
  invocation. `aside exec` is used only by the advisory scenario 09, whose point is the agent.
- **Read A: the REPL reads the DOM** (`page.evaluate`), the default because `readDom` is
  verified.
- **Read B: `TestBeacon`.** The page posts what its DOM shows to `POST /api/test/ui-snapshot`
  and the scenario reads `GET /api/test/ui-snapshot`. Chosen automatically when `readDom` is
  not verified, or with `--read-path beacon`. It cannot serve scenario 05 and the middle of 10
  (the server is down) or 08 (two tabs, one snapshot): those are then BLOCKED, with their
  on-chain and HTTP assertions still run. Scenario 01 checks over HTTP that path B reports the
  same page in every run.
- If the page cannot be driven (`session`, `openTab`, `click`, `fill` or `evalInPage` missing),
  the scenario is BLOCKED and says which capability is missing.

## Scenarios

Each scenario starts its own stack through `scripts/dev-up.sh`: Anvil on `8550 + i`
(`--block-time 1`), a new deployment, a new data directory, the app on `3050 + i`. Hook flags
are passed on the command line only.

| # | Script | Proves | Chain | HTTP | DOM |
|---|---|---|---|---|---|
| 01 | `01-exit.sh` | exit win on the smallest size; schedule and exit payout **before** the bet, for every size of the table | nothing on chain before the bet; contract quotes the same payout and table; Settled, outcome 0, payout = bet x multiplier, relayer sent it, balance + payout, reserve back to 0, accounting | config (devWallet, testHooks, table mode), game read, reveal, TestBeacon snapshot | dev wallet connects #2; every schedule row and exit payout for every size, with two amounts; fog board; result, settlement tx; verify page (hash, cells, solution) |
| 02 | `02-deadend.sh` | dead-end loss on the middle size, moves by arrow keys | outcome 2, payout 0, balance unchanged | status lost, reveal | result loss, payout 0; verify page |
| 03 | `03-cashout.sh` | cash-out after 3 moves on the largest size | payout = bet x refundBps[3] / 10000; contract's refundBps equal the table's | refundableWei at every step; cashed_out, auto false | refundable-amount at every step, exit payout, cash-out button, result; verify page |
| 04 | `04-idle-auto-cashout.sh` | idle auto cash-out (`MAZE_IDLE_TIMEOUT_SEC=6`) learnt by polling | outcome 1, steps 2, mined at or after the idle deadline, relayer sent it | idleTimeoutSec 6; cashed_out, auto true | idle deadline on screen; `auto-cashout` shown without input within 5 (+3) chain seconds |
| 05 | `05-server-down-reclaim.sh` | server killed: the open page reclaims after the settle deadline | `DeadlineNotReached` before; Reclaimed, amount = bet, sent by the player's wallet, balance + bet - fee, never settled | active before the stop, unreachable after | `server-unreachable`, countdown on block time, button disabled then enabled, result `reclaimed` |
| 06 | `06-verify-mismatch.sh` | verify screen flags a tampered record | still Settled, once | game read and reveal unchanged by imports | one flipped wall bit marks exactly that cell and row; a changed seed fails the hash check; the untouched record passes |
| 07 | `07-invalid-move.sh` | wall, off-grid, visited, stale, malformed, unauthenticated moves are refused | still Active, nothing settled; later cash-out settles | error codes; refusals carry only `{ error }`; seed not revealed mid-game; game read unchanged | board, current cell and refundable amount unchanged; wall move not offered |
| 08 | `08-multi-tab.sh` | second tab resumes; two different moves for one step | settled exactly once | one 200 and one `409 STALE_STEP` without game state (recorded in the pages); one more step, not two | tab B resumes; both tabs converge on the server's cell; the refused tab says so; tab B learns the cash-out |
| 09 | `09-exploratory-agent.sh` | advisory, only with `--with-exec`: invariants after a model-driven agent tried to cheat | accounting, owner, signer, table hash | games unreadable without token, no early reveal | none (the plan defines none) |
| 10 | `10-cli-reclaim.sh` | server killed: a third party reclaims with `scripts/reclaim.sh` | exit 1 `DeadlineNotReached` before, exit 0 after; Reclaimed, sent by #9, player + bet exactly; second reclaim refused; restarted server does not settle | unreachable; after restart reveal reason `reclaimed`, move refused | open page learns `reclaimed` from the chain; verify page after restart |
| 11 | `11-dev-wallet-gating.sh` | dev wallet offered only when `/api/config` says so, same build | chain 31337, no game created | devWallet false, then true after a restart | option absent and bet disabled; after restart and reload present and connects #2 |

Order: 01 02 03 04 06 07 08 09 11, then the two that move the chain clock, 10 and 05 (05 last).

Sizes, multipliers and refund tables are read from `/api/config`, so the scenarios follow the
table that is deployed: 01, 02 and 03 play its smallest, middle and largest size (5×5, 7×7 and
9×9 with the certified production table; 5×5, 7×7 and 10×10 with the test table).

Routes are planned offline by `plan-moves.ts`: the scenario reads the game id from the page,
computes the server seed the test seed hook derives from it, rebuilds the maze with
`@maze/shared` and gets the moves for `exit`, `deadend`, `cashout:<k>`, `junction` or `invalid`.
There is no API that hands out a maze. Every scenario also asserts that the seed revealed after
the game equals the one it planned with. A maze that cannot serve a goal is cashed out at step
0 and another game is started (up to four).

## Output

- `out/capabilities.json`: what the probe verified, and the paths chosen from it.
- `out/results.json`: the run, machine-readable (`scenarios[].result`, `totals`, `exit`,
  `partial` for a run of selected scenarios).
- `out/report.md`: the same for people, with every assertion and the evidence (game id,
  transaction hashes).
- `out/scenarios/<NN>.json`: the latest result of each scenario.
- `.data/e2e-aside/<run id>/<NN>/`: logs (`run.log`, `aside.log`, `dev-up.log`,
  `assertions.tsv`), git-ignored.

## Side effects on your browser

- Tabs open in your Aside window and become the active tab while a scenario runs. They show
  `http://127.0.0.1:3050` to `3061` only. The suite never lists, reads or touches other tabs,
  with one exception below.
- The suite never clicks `wallet-connect`. That button talks to whatever wallet extension the
  browser has; the scenarios use `wallet-dev-option` (Anvil account #2) only. Wallet extensions
  still inject their own keys into the localStorage of these origins; the suite leaves them.
- localStorage: only keys starting with `maze:` on those origins are read and removed (before
  and after each scenario).
- A session that quits normally closes its tabs. If a scenario's shell is killed hard
  (`kill -9`), its tab stays open. The next run of that scenario closes it: it attaches to the
  recorded target id of its own tab and runs `window.close()` there. That works because a
  scenario never navigates a tab (it opens a new tab for a new URL). The tab list is consulted
  only to ask whether that one target id is still open. If the browser refuses, the tab is
  parked on `about:blank` and the log says so; close it by hand.
- Scenario 09 (`--with-exec`) runs a model-driven agent in your browser profile and bills your
  model account. It is off by default.

## Known limitations

- No scenario uses real random seeds. The server seed is derived from the game id by the test
  seed hook (`MAZE_TEST_SEED_SECRET`), the client seed is fixed per scenario. This holds for the
  production-table run too: it is started by this runner with the seed hook on, not by
  `pnpm start:web`. Randomness itself is covered by the unit and simulation suites.
- Test hooks are on in every scenario (`MAZE_ALLOW_TEST_HOOKS=1`), so `TestBeacon` and
  `/api/test/ui-snapshot` exist. That hooks-off behaviour (404, no beacon) is checked by the
  web unit tests, not here.
- One build serves all scenarios by default, although the plan gives each scenario its own
  `NEXT_DIST_DIR`. The scenarios run one at a time and the app reads its chain settings at run
  time, so the build is the same; `--build-each` builds per scenario.
- Scenario 04 allows 5 + 3 chain seconds (the plan's allowance for time-sensitive scenarios)
  between the idle deadline and the result on screen; the measured value is kept as evidence.
- Scenario 08 depends on both tabs sending their move before either polls again. A poll that
  lands exactly between the two clicks (a window of a few milliseconds every three seconds)
  would make the "both for the same step" assertion fail; run it again.
- Whether `aside` works without a running, signed-in browser was not tested: that would mean
  quitting your browser. The probe records what `aside` printed in the states it did meet.
- `aside exec` was never run by the authoring work: not in the probe, not in scenario 09.
