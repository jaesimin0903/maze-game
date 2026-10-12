# 에이전트 플레이: AI 에이전트가 자기 지갑으로 베팅하고 플레이하기

2026-10-12 기준. 코드는 `packages/agent/`에 있습니다.

## 1. 무엇인가

AI 에이전트(Claude Code 등)가 MCP 도구로 이 게임을 합니다. 브라우저는 쓰지 않습니다.

- **결제:** 판마다 에이전트 지갑이 `createGame` 트랜잭션으로 베팅액을 컨트랙트에 보냅니다. 결과(출구 배당, 캐시아웃 환불, 0)는 서버 릴레이어가 `settle`로 같은 지갑에 보냅니다. 두 트랜잭션 모두 익스플로러 링크로 돌려줍니다.
- **흐름:** 브라우저(`apps/web/src/client/use-game.ts`)와 같습니다. 티켓 요청에 지갑으로 서명하고, `POST /api/games`로 티켓을 받고, `createGame`을 보내고, `/start`, `/move`, `/cashout`으로 플레이합니다.
- **에이전트가 아는 것:** 사람과 같이 밟은 칸의 벽뿐입니다. 도구는 그 정보로 계산한 방향별 출구 확률(시뮬레이터의 정확한 사후확률, `packages/sim/src/posterior.ts`)을 함께 줍니다. 그 합은 "출구에 아직 닿을 수 있을 확률"입니다. 이 정보를 최적으로 써도 환수율은 96%를 넘지 않습니다(`docs/ai-attack-report.md`).

## 2. 준비 (Monad 테스트넷)

```sh
pnpm agent:wallet --server https://maze-monad.fly.dev   # .env.agent 생성, 주소와 잔액 출력
#  → https://faucet.monad.xyz 에서 출력된 주소로 MON 받기
pnpm agent:wallet                                        # 잔액 다시 확인
```

`.env.agent`는 저장소 루트에 생기고 git에서 무시되며 권한은 600입니다. 이미 있으면 덮어쓰지 않습니다. 이 파일이 키의 유일한 사본이니 테스트 자금만 넣으세요.

| 변수 | 뜻 | 기본값 |
|---|---|---|
| `MAZE_AGENT_KEY` | 에이전트 지갑 개인 키 | `agent:wallet`이 생성 |
| `MAZE_AGENT_SERVER` | 게임 서버 주소 | `http://127.0.0.1:3000` |
| `MAZE_AGENT_BUDGET` | 한 세션(MCP 서버나 `agent:play` 한 번 실행)에 걸 수 있는 총액 | 0.5 |
| `MAZE_AGENT_MAX_BET` | 한 판에 걸 수 있는 최대액 | 0.1 |
| `MAZE_AGENT_RPC_URL` | 트랜잭션을 보낼 RPC | 서버가 알려 주는 RPC |
| `MAZE_AGENT_DATA_DIR` | 진행 중인 판과 기록을 두는 곳 | `.data/agent/` |

같은 이름의 환경 변수가 파일 값보다 우선합니다. `MAZE_AGENT_ENV`로 다른 설정 파일을 지정할 수 있습니다.

Monad 서버 기준(2026-10-12 `/api/config`): 베팅은 0.001~0.1 MON, 배율은 5×5 2.6088배, 7×7 6.6112배, 9×9 18.4695배입니다. 120초 동안 움직이지 않으면 서버가 자동으로 캐시아웃하고, 한 판은 최대 900초입니다.

## 3. Claude Code에 연결

저장소 루트의 `.mcp.json`이 `maze-agent` 서버(`pnpm --silent agent:mcp`)를 등록합니다. 이 저장소에서 Claude Code를 열면 서버 사용 승인을 묻습니다.

| 도구 | 하는 일 |
|---|---|
| `maze_wallet` | 주소, 네트워크, 잔액, 한도, 판 크기별 배율, 진행 중인 판 |
| `maze_new_game` | `size`, `bet`(예: `"0.01"`), 선택 `startSide`(`E`/`S`). 베팅을 결제하고 첫 위치를 돌려줌 |
| `maze_look` | 현재 위치, 갈 수 있는 방향과 방향별 출구 확률, 지금 캐시아웃하면 받는 금액 |
| `maze_move` | `dir`(`N`/`E`/`S`/`W`)로 한 칸 이동. 판이 끝나면 정산 트랜잭션까지 기다려 결과를 돌려줌 |
| `maze_cash_out` | 지금 환불액을 받고 끝냄 |
| `maze_history` | 이 지갑이 끝낸 판들의 베팅·지급 트랜잭션과 합계 |

데모용 지시 예:

> maze_wallet으로 지갑을 확인하고 0.01 MON으로 5×5 게임을 해 줘. 칸마다 방향별 출구 확률을 보고 판단하고, 출구에 닿을 확률이 20% 아래로 떨어지면 캐시아웃해. 끝나면 maze_history로 결제 내역을 보여 줘.

## 4. LLM 없이 자동 플레이

```sh
pnpm agent:play --games 3 --size 5 --bet 0.01 --cashout-below 0.2
```

칸마다 출구 확률이 가장 높은 쪽으로 가고, 출구에 닿을 확률이 `--cashout-below` 아래로 떨어지면 캐시아웃합니다. 판마다 베팅과 지급 트랜잭션을 출력하고, 끝에 총 베팅·지급·순손익과 수수료를 포함한 잔액 변화를 출력합니다.

## 5. 한도와 안전장치

- **지출 한도:** 판당 한도와 세션 예산은 트랜잭션을 보내기 전에 확인합니다. 클라이언트에서 확인하는 한도이므로, 넘을 수 없는 한도는 지갑 잔액입니다. 에이전트 지갑에는 맡길 만큼만 넣으세요.
- **한 번에 한 판:** 서버가 지갑당 진행 중인 판을 하나만 허용하고, MCP 서버도 도구 호출을 하나씩 처리합니다.
- **Monad 예비 잔액 규칙:** 잔액이 10 MON 미만이면 직전 3블록 안에 자기 트랜잭션이 있을 때 잔액을 더 줄이는 송금이 되돌려집니다(`docs/deploy-monad.md` §3.1). 그래서 Monad에서는 직전 베팅 블록에서 4블록이 지난 뒤 다음 베팅을 보냅니다.
- **세션 토큰:** 진행 중인 판의 토큰은 베팅에 서명하기 전에, 베팅 트랜잭션의 해시는 보내기 전에 `.data/agent/<주소>.json`(권한 600)에 씁니다. 프로세스가 중간에 죽어도 다시 켜면 그 판을 이어 가거나, 끝난 판이면 기록으로 옮깁니다. 티켓이 만료될 때까지 베팅이 체인에 닿지 않은 판은 지웁니다(컨트랙트가 만료된 티켓을 거부하므로 그 베팅은 더 들어갈 수 없습니다). 이 파일을 지우면 진행 중인 판은 더 움직일 수 없고, 120초 뒤 서버가 캐시아웃합니다.
- **한 지갑에는 한 프로세스만:** MCP 서버와 `agent:play`를 같은 지갑으로 동시에 돌리지 마세요. 두 프로세스가 같은 상태 파일을 덮어씁니다.

## 6. 로컬에서 시험하기

```sh
MAZE_ANVIL_PORT=8595 MAZE_NEXT_PORT=3095 pnpm dev:up
export MAZE_AGENT_ENV=/tmp/agent-local.env MAZE_AGENT_DATA_DIR=/tmp/agent-data
pnpm agent:wallet --server http://127.0.0.1:3095 --fund-local 5   # Anvil에서만 잔액을 직접 채움
pnpm agent:play --games 3
MAZE_ANVIL_PORT=8595 MAZE_NEXT_PORT=3095 pnpm dev:down
```

`MAZE_AGENT_ENV`를 따로 두면 저장소의 `.env.agent`(테스트넷 지갑)를 건드리지 않습니다.

## 7. 검증 기록 (2026-10-12, 로컬 Anvil + 운영 배율 표)

- `pnpm --filter @maze/agent test`: 방향별 출구 확률이 시뮬레이터 값과 소수 12자리까지 같음(세 크기, 크기마다 20판의 모든 위치).
- `agent:play` 3판(5×5, 0.05): 3판 모두 막다른 길. 판마다 베팅과 정산 트랜잭션이 기록됨.
- MCP 서버를 `pnpm --silent agent:mcp`로 띄우고 stdio로 구동: stdout은 모두 JSON-RPC. 5×5 출구 도달(0.02 → 0.052176, 2.6088배), 7×7 한 걸음 뒤 캐시아웃(0.02 → 0.0146, 73%). 진행 중 두 번째 베팅, 판 없이 이동, 범위를 넘는 베팅은 이유와 함께 거부됨.
- 세션 예산 0.03에서 0.02를 쓴 뒤 다음 0.02 베팅은 트랜잭션을 보내기 전에 거부됨.
- 리뷰 지적을 고친 뒤 다시 실행: `agent:play` 2판(출구 도달 0.01 → 0.026088, 출구 도달 확률 24.2%에서 캐시아웃). 요청을 넣고 stdin을 바로 닫아도 응답이 모두 나옴. MCP 서버를 판 도중(7×7, 한 걸음 뒤)에 끄고 다시 켜면 같은 판을 같은 위치에서 이어 가고, 캐시아웃과 정산까지 끝남.

### Monad 테스트넷 (2026-10-12, https://maze-monad.fly.dev)

- 에이전트 지갑 `0x3a0E2237D0dFF3B02cfE562ff8291D57b4578Aff`. faucet은 봇 차단(Vercel 보안 체크포인트) 뒤에 있어서, 하우스 자금 0.5 MON을 `withdrawHouse(0.5 MON, 에이전트 주소)`로 바로 옮겨 채웠습니다([tx](https://testnet.monadvision.com/tx/0xaccfcad6e6dd1472c011a004c523d7e27095847dfe06bc22ef46cd61b71d8263), 수수료 0.0094 MON). 되돌리려면 에이전트 지갑에서 보내거나 `pnpm monad:fund`로 하우스에 다시 넣습니다.
- `agent:play` 3판(5×5, 0.01 MON): 막다른 길 2판, 출구 1판(12걸음, 0.026088 MON 지급, [정산 tx](https://testnet.monadvision.com/tx/0x357c6f18f0540071b57d65cdc4437e7797035d046179b49b06e76f480e77a392)). 잔액 0.5 → 0.442901528 MON. 게임 손익 −0.003912, 베팅 수수료 3판 합계 약 0.0532 MON.
- MCP 서버(`pnpm --silent agent:mcp`)를 stdio로 구동: 5×5 0.02 MON 판은 6걸음째 막다른 길, 7×7 0.02 MON 판은 한 걸음 뒤 캐시아웃해 0.0146 MON 지급([정산 tx](https://testnet.monadvision.com/tx/0x199d52b5a4db3709936ff45f3b4bb58c6fb55a5933f52002ae7f342173face20)). 오류 사례(판 없이 이동, 범위 밖 베팅, 진행 중 두 번째 베팅)는 로컬과 같게 거부됨.
- **수수료:** `createGame`의 가스 추정은 173,812이고, Monad는 한도 전체를 청구하므로 102 gwei에서 판당 약 0.0177 MON입니다. 0.01 MON 베팅보다 큽니다. 정산 가스(0.0306 MON)는 서버 릴레이어가 냅니다.
- **가스 추정 주의:** 같은 `withdrawHouse` 호출에서 viem이 수수료 필드와 함께 추정하면 Monad가 4,948,319를 돌려준 적이 있습니다(수수료 필드 없이 추정하면 41,743). 받는 사람이 보내는 사람 자신일 때 그랬고, `createGame`에서는 두 추정이 같았습니다. 에이전트는 가스 한도가 100만을 넘으면 보내지 않습니다.
