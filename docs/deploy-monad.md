# Monad 테스트넷 배포

2026-10-08 기준. 이 게임을 Monad 테스트넷(체인 10143, MON)에 올리는 순서입니다. 서버의 상태는 이벤트 로그(`MAZE_DATA_DIR/events.jsonl`) 하나뿐이고, 이 로그는 한 프로세스만 열 수 있습니다. 그래서 서버는 서버리스가 아니라 **오래 떠 있는 컨테이너 하나 + 영구 볼륨 하나**로 돌립니다. 아래 수치 중 가스 가격(102 gwei = 기본료 최소 100 + 우선료 2)은 같은 날 `testnet-rpc.monad.xyz`의 `eth_gasPrice`에서 읽었고, 가스 사용량은 같은 코드로 체인 id 10143인 로컬 Anvil에서 한 리허설(§10)에서 쟀습니다.

## 1. 한눈에 보는 순서

```sh
pnpm monad:keys                  # .env.monad 생성(이미 있으면 그대로 두고 주소만 출력)
#  → faucet(https://faucet.monad.xyz)에서 배포자와 릴레이어에 MON 받기(§3)
pnpm monad:deploy --fund 5       # 배포, tableHash 확인, 4블록 기다린 뒤 하우스 자금 5 MON 입금
pnpm monad:verify                # MonadVision(Sourcify) 소스 검증, 키가 있으면 Monadscan도
pnpm monad:status                # 잔액, 유동성, 동시에 받을 수 있는 판 수, 릴레이어 가스 여유
pnpm monad:server-env            # 서버용 .env.monad.server 생성(배포자 키 없음)
docker build -t maze-web .       # 또는 fly deploy(§8)
pnpm monad:withdraw-house all    # 하우스 자금 회수(필요할 때)
```

모든 `monad:*` 명령은 `--env <경로>`로 다른 설정 파일을 받습니다(기본 `.env.monad`). `--env-file`이 아닌 이유는 tsx가 그 이름을 Node 자체 옵션으로 가져가기 때문입니다. 어떤 명령도 개인 키를 출력하지 않습니다.

## 2. 계정과 키 (`pnpm monad:keys`)

`scripts/monad-keys.ts`가 저장소 루트에 `.env.monad`를 만듭니다. 파일이 이미 있으면 **절대 덮어쓰지 않고** 그 안의 주소만 다시 보여 줍니다. 권한은 600이고 `.gitignore`의 `.env.*`에 걸려 커밋되지 않습니다. 이 파일이 키의 유일한 사본이라, 스크립트는 이 파일을 반쯤 쓴 채로 남기지 않습니다. 새 내용을 `.env.monad.tmp`에 다 쓰고 디스크에 확정한 뒤 이름을 바꾸며, 바로 전 내용은 `.env.monad.bak`(권한 600)에 남깁니다. `.env.monad.server`도 같습니다.

| 변수 | 역할 | 필요한 MON | 서버에 주는가 |
|---|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | 컨트랙트 소유자이자 하우스 계정. 배포, `fund`, `withdrawHouse` | 배포 가스 + 하우스 자금 | **아니오.** `monad:*` 스크립트만 씁니다 |
| `SERVER_SIGNER_PRIVATE_KEY` | 티켓과 정산 결과에 서명. 컨트랙트가 이 주소를 `serverSigner`로 믿음 | 0 (트랜잭션을 보내지 않음) | 예 |
| `RELAYER_PRIVATE_KEY` | `settle` 트랜잭션을 보내고 가스를 냄 | 가스 (§3.2) | 예 |

같은 파일에 Monad 설정(`RPC_URL`, `CHAIN_ID=10143`, `CHAIN_NAME`, `NATIVE_SYMBOL=MON`, `EXPLORER_URL`, `FAUCET_URL`, `MAZE_LOG_CHUNK_BLOCKS=100`, `MAZE_DATA_DIR=/data`)이 들어가고, `MAZEBET_ADDRESS`는 비어 있다가 `monad:deploy`가 채웁니다. `PRIVY_APP_ID`는 §9에서 직접 넣습니다.

키를 잃거나 새면:

- **배포자 키**를 잃으면 하우스 자금을 꺼낼 수 없습니다(`withdrawHouse`는 소유자만 부를 수 있음). 안전한 곳에 따로 백업하세요.
- **서명 키**가 새면 누구나 정산 결과를 위조할 수 있습니다. 소유자가 `setServerSigner`로 새 주소로 바꾸고, 서버의 `SERVER_SIGNER_PRIVATE_KEY`도 바꿔야 합니다.
- **릴레이어 키**가 새면 그 계정의 가스 잔액만 잃습니다. 정산 내용은 서명 키가 정합니다.

이번에 만든 `.env.monad`의 주소입니다(키는 파일에만 있습니다).

| 계정 | 주소 |
|---|---|
| 배포자 | `0x3828e947d6Ca8929d5de3F5e12b5E0fBd176Dc75` |
| 서버 서명 | `0xE069bC9654a0cC391174a087E00eCbD38888dF0f` |
| 릴레이어 | `0x6E2e45b9327cAdF933C37Df0A4F98f751529320B` |

## 3. faucet 충전: 누가 얼마나

Monad는 가스를 **쓴 양이 아니라 가스 한도만큼** 받습니다. 기본료는 최소 100 gwei이고, 아래 계산은 102 gwei 기준입니다. faucet 한도는 바뀌므로 faucet 페이지에서 확인하세요.

### 3.1 배포자

- **배포 가스:** 1,869,846 가스(리허설 측정, Ethereum 가스표)라 102 gwei면 약 0.19 MON입니다. Monad의 가스표로는 조금 다를 수 있습니다. 스크립트는 노드의 추정값을 그대로 한도로 보내고, 보내기 전에 최대 수수료(약 122 gwei) 기준으로 잔액을 확인해 모자라면 필요한 양을 알려 주고 멈춥니다. **0.3 MON** 정도면 됩니다.
- **하우스 자금:** §3.3에서 고른 금액. `--fund`로 배포와 함께 넣거나 나중에 `pnpm monad:fund <MON>`으로 더 넣습니다.
- **예비 잔액 규칙:** Monad에서 잔액이 10 MON 미만인 계정은, 직전 3블록 안에 자기 트랜잭션이 없을 때만 잔액을 10 MON 아래로 내리는 송금을 할 수 있습니다. 어기면 트랜잭션이 되돌려지고 가스만 나갑니다. `monad:deploy`는 그래서 배포 블록에서 4블록(약 1.6초) 지난 뒤에 `fund`를 보냅니다. `monad:fund`를 다른 송금 직후에 연달아 부르지 마세요.

### 3.2 릴레이어

- 한 판을 정산하는 `settle`은 가스 한도가 300,000으로 고정입니다(`SETTLE_GAS_LIMIT`). 102 gwei면 **한 판에 0.0306 MON**이고 전액이 청구됩니다. 리허설에서 실제 사용량은 65,216 가스로 한도의 22%였습니다.
- 10초 안에 채굴되지 않은 정산은 다시 보냅니다. 앞의 것이 늦게 채굴되면 뒤의 것은 `GameNotActive`로 되돌려지고 가스만 듭니다. Monad의 블록은 0.4초마다 나오므로 드뭅니다.
- 예비 잔액 규칙 때문에, 3블록 안에 동시에 처리 중일 수 있는 정산의 가스 합계가 min(10 MON, 잔액)을 넘지 못합니다. 1 MON이면 동시에 32건입니다.
- **권장: 3~5 MON**(정산 약 100~160판). `monad:status`가 "몇 판 더 정산할 수 있는지"를 보여 주고, 50판 아래로 떨어지면 경고합니다.

### 3.3 하우스 자금 크기 정하기

판이 만들어지면 컨트랙트가 그 판의 최대 지급액 `max(베팅, 베팅 × 배율)`을 정산될 때까지 묶어 둡니다. 묶을 돈이 모자라면 `createGame`이 `InsufficientLiquidity`로 거부됩니다(지갑이 미리 추정하므로 보통 가스는 나가지 않습니다).

| 베팅 | 5×5 (×2.6088) | 7×7 (×6.6112) | 9×9 (×18.4695) |
|---|---|---|---|
| 0.001 MON | 0.0026 MON | 0.0066 MON | 0.0185 MON |
| 0.01 MON | 0.0261 MON | 0.0661 MON | 0.1847 MON |
| 0.1 MON (컨트랙트 최대) | 0.2609 MON | 0.6611 MON | 1.8470 MON |

- 0.001~0.01 MON 베팅만 받는다면 가장 나쁜 경우는 9×9에 0.01 MON(판당 0.1847 MON)입니다. **5 MON**이면 그런 판 27개를 동시에 받고, 5×5 0.01 MON이면 191판입니다.
- 동시 판 수만이 아니라 연속 손실도 버텨야 합니다. 9×9를 0.01 MON으로 이기면 하우스는 판당 0.1747 MON을 잃으니, 5 MON은 그런 승리 28번입니다. 하우스 몫은 판당 4~5%라 잔액은 평균적으로 천천히 늘지만, 테스트넷에서도 1 MON 아래로 내려가지 않게 `monad:status`로 지켜보세요.
- 컨트랙트 최대 베팅은 0.1 MON입니다. 그 베팅의 9×9 한 판이 1.847 MON을 묶으므로, 5 MON이면 동시에 두 판까지입니다. 그 이상은 거부되고, `monad:status`가 경고합니다.

정리하면 첫 충전은 **배포자 약 5.3 MON(가스 0.3 + 하우스 5), 릴레이어 3~5 MON, 서버 서명 0**입니다. faucet이 그만큼 주지 않으면 `--fund 1`처럼 작게 시작하고 `pnpm monad:fund <MON>`으로 더하세요.

## 4. 배포 (`pnpm monad:deploy`)

```sh
pnpm monad:deploy --fund 5      # --fund 없이 배포만 해도 됩니다
```

`forge build --root contracts`를 먼저 돌리고 `scripts/deploy-chain.ts`가 다음을 순서대로 합니다.

1. **거부 조건 확인:** 표(`packages/shared/src/tuning.json`)가 fixture이거나 보정되지 않았으면, 노드의 체인 id가 `CHAIN_ID`와 다르면, `.env.monad`에 이미 `MAZEBET_ADDRESS`가 있으면(`--redeploy`로만 넘어감), 배포자 잔액이 배포 가스 + 입금액에 모자라면 아무것도 보내지 않고 멈춥니다.
2. **배포:** 생성자 인자는 서버가 부팅 때 확인하는 `tableHash`와 같은 인코더(`constructorArgs`)로 만듭니다. 배포 뒤 체인에서 `tableHash`, `owner`, `serverSigner`를 읽어 맞는지 확인합니다.
3. **기록:** `deployments/monad-testnet-10143.json`(주소, 배포 블록, 트랜잭션 해시, 소유자, 서명 주소, tableHash, 생성자 인자, 입금 내역)을 쓰고, `.env.monad`의 `MAZEBET_ADDRESS`를 채웁니다. `MAZE_START_BLOCK`이 남아 있으면 비웁니다. 새 볼륨의 서버는 그 순간의 최신 블록부터 읽으면 되기 때문입니다(§7). 다른 줄은 건드리지 않습니다.
4. **입금(`--fund`):** 배포 블록 + 4에 도달할 때까지 기다린 뒤 `fund()`를 보냅니다(§3.1의 예비 잔액 규칙).

`--redeploy`로 새 컨트랙트를 만들면 옛 컨트랙트의 하우스 자금은 소유자가 꺼낼 때까지 그대로 남습니다. 그래서 스크립트는 옛 기록을 `deployments/monad-testnet-10143-<옛 주소>.json`으로 남기고 옛 주소를 출력합니다. 자금은 `pnpm monad:withdraw-house all --contract <옛 주소>`로 배포자에게 돌려받습니다. 진행 중인 판에 묶인 돈과 플레이어에게 보내지 못한 돈은 꺼낼 수 없고, 그만큼은 거부합니다. 서버도 **새 볼륨**에서 띄워야 합니다. 이벤트 로그는 다른 배포의 것이면 부팅을 거부합니다.

지금 컨트랙트의 하우스 자금을 꺼낼 때는 `pnpm monad:withdraw-house <MON>` 또는 `all`을 씁니다.

## 5. 소스 검증 (`pnpm monad:verify`)

```sh
pnpm monad:verify                    # MonadVision(Sourcify) + Monadscan(키가 있을 때)
pnpm monad:verify --only sourcify    # 하나만
```

- **MonadVision:** Sourcify(`https://sourcify-api-monad.blockvision.org/`)로 올립니다. 키가 필요 없습니다.
- **Monadscan:** Etherscan 방식이라 API 키가 필요합니다. `.env.monad`에 `ETHERSCAN_API_KEY=<키>`를 넣으세요(Etherscan API V2 키). 키는 forge에 명령줄이 아니라 환경 변수로 넘깁니다.
- 컴파일 설정은 `contracts/foundry.toml`을 그대로 씁니다: solc 0.8.28, optimizer 200회, `via_ir`, EVM `cancun`, 메타데이터 해시 ipfs. 배포한 바이트코드도 같은 설정으로 만든 것입니다. 생성자 인자는 배포 기록에서 읽습니다.

## 6. 상태 확인 (`pnpm monad:status`)

리허설(§10)에서 나온 출력입니다. 체인 이름만 실제와 다릅니다.

```
Monad Rehearsal (chain 10143), block 92
MazeBet 0xEeE166b568ebD6EA60aa3606756d60862495955F

accounts
  deployer       0xDD72…54d5  2.498083 MON
  relayer        0x92B5…E404  2 MON: 6666 settles at 0.0003 MON each (300000 gas at 1.000004709 gwei, the full limit is charged)
  server signer  0x1c82…5f60  0 MON (sends nothing, needs none)

house
  contract balance      2.5 MON
  reserved for games    0 MON (games that are Active now)
  pending withdrawals   0 MON
  available liquidity   2.5 MON

games the available liquidity covers at once, per bet and tier
  bet               5x5 (x2.6088)       7x7 (x6.6112)       9x9 (x18.4695)
  0.001 MON         958                 378                 135
  0.01 MON          95                  37                  13
  0.1 MON           9                   3                   1

ok: signer, owner and table match; the relayer and the house are funded
```

Anvil의 가스 가격은 1 gwei라 정산 한 건이 0.0003 MON으로 나왔습니다. 테스트넷에서는 0.0306 MON입니다. 서명 주소, 소유자, tableHash가 어긋나거나, 릴레이어가 50판도 정산하지 못하거나, 유동성이 9×9 최대 베팅 한 판도 받지 못하면 `warning:` 줄이 붙습니다.

## 7. 서버 환경 변수

서버는 프로세스 환경 변수만 읽습니다(`apps/web/src/server/config.ts`). `.env` 파일은 읽지 않습니다. `pnpm monad:server-env`가 `.env.monad`에서 아래 변수만 골라 `.env.monad.server`(권한 600)를 만들고, 서버 자신의 파서(`loadConfig`)로 한 번 검사합니다. 배포자 키와 테스트 훅 변수는 이 파일에 들어가지 않고, 주석 줄도 넣지 않습니다(읽는 쪽이 `#` 줄을 받는지 따질 필요가 없게). `PRIVY_APP_ID`가 25자가 아니면 파일을 만들지 않고, 비어 있으면 경고합니다.

| 변수 | 필수 | 뜻 |
|---|---|---|
| `RPC_URL` | 예 | 서버가 쓰는 RPC. `https://testnet-rpc.monad.xyz` |
| `PUBLIC_RPC_URL` | 조건부 | 브라우저에 알려 줄 RPC. 없으면 `RPC_URL`. 31337 밖에서 `RPC_URL`에 `/` 아닌 경로, 쿼리, 사용자 정보가 있으면(API 키가 들어 있을 수 있으므로) 이것이 없을 때 부팅을 거부합니다 |
| `CHAIN_ID` | 예 | `10143`. 부팅 때 노드의 체인 id와 비교합니다 |
| `CHAIN_NAME` | 아니오 | 화면에 보일 체인 이름. `Monad Testnet` |
| `NATIVE_SYMBOL` | 아니오 | 화폐 기호. `MON`(없으면 ETH) |
| `EXPLORER_URL` | 아니오 | 탐색기 주소. `https://testnet.monadvision.com` |
| `FAUCET_URL` | 아니오 | faucet 주소. `https://faucet.monad.xyz` |
| `MAZEBET_ADDRESS` | 예 | 컨트랙트 주소(`monad:deploy`가 채움) |
| `MAZE_SCAN_TAG` | 아니오 | 서버가 체인을 읽는 블록 태그: `latest`, `safe`, `finalized`. 기본은 31337에서 `latest`, 그 밖에서 `finalized`. Monad의 `latest`는 아직 바뀔 수 있는 제안 블록이라 바꾸지 않는 것이 좋습니다 |
| `MAZE_START_BLOCK` | 아니오 | 이벤트 로그에 스캔 표시가 없을 때(처음 부팅) 스캔을 시작할 블록. 없으면 그때의 최신 블록(스캔 태그 기준)부터 읽습니다. 빈 로그에는 티켓이 없으니 그 앞의 판은 이 서버와 상관이 없습니다. 값이 있는데 최신 블록보다 크면 부팅을 거부합니다. 로그에 표시가 생긴 뒤에는 쓰이지 않습니다 |
| `MAZE_LOG_CHUNK_BLOCKS` | 아니오 | `eth_getLogs` 한 번에 읽을 블록 수. 기본은 31337에서 2000, 그 밖에서 100(Monad 공개 RPC의 한도) |
| `SERVER_SIGNER_PRIVATE_KEY` | 예 | 서명 키 |
| `RELAYER_PRIVATE_KEY` | 예 | 릴레이어 키 |
| `MAZE_DATA_DIR` | 예 | 이벤트 로그 디렉터리, 절대 경로. 컨테이너에서는 `/data`(볼륨) |
| `MAZE_IDLE_TIMEOUT_SEC`, `MAZE_MAX_GAME_SEC` | 아니오 | 표의 시간 제한(120초, 900초)을 줄일 때만. 늘릴 수는 없습니다 |
| `PRIVY_APP_ID` | 아니오 | Privy 앱 id. 없으면 브라우저가 Privy 로그인을 띄우지 않습니다 |
| `PORT` | 아니오 | 컨테이너가 들을 포트. 기본 3000 |

쓰면 안 되는 변수: `MAZE_ALLOW_TEST_HOOKS`, `MAZE_TEST_SEED_SECRET`, `MAZE_TUNING_FIXTURE`는 서버가 31337 밖에서 거부하고, 컨테이너 진입점(`scripts/container-start.sh`)은 아예 시작하지 않습니다. `NEXT_PUBLIC_ENABLE_DEV_WALLET`은 31337 밖에서는 효과가 없습니다. 스크립트만 쓰는 변수는 `DEPLOYER_PRIVATE_KEY`와 `ETHERSCAN_API_KEY`입니다.

브라우저 쪽 설정(체인, RPC, 컨트랙트, 이름, Privy 앱 id)은 모두 실행 중에 `GET /api/config`로 받습니다. 그래서 값을 바꿔도 이미지를 다시 빌드할 필요가 없고 서버만 다시 띄우면 됩니다.

## 8. 컨테이너 실행

### 8.1 지켜야 할 것

- **컨테이너 하나, 볼륨 하나.** 이벤트 로그가 서버의 상태 전부입니다. 같은 볼륨을 두 컨테이너에 붙이거나 기계를 두 대로 늘리면, 서로 모르는 티켓과 결과가 생깁니다.
- **볼륨을 지우지 마세요.** 진행 중인 판이 있는데 빈 로그로 띄우면 서버가 부팅을 거부합니다(그 판들을 정산할 수 없으므로). 새 컨트랙트에는 새 볼륨을 씁니다.
- **서버가 멈추면 정산도 멈춥니다.** 정산 기한(30분) 안에 다시 뜨지 않은 판은 플레이어가 `reclaim`으로 베팅 전액을 돌려받습니다. 호스트의 재시작 정책을 켜 두세요.
- **부팅의 따라잡기:** 빈 로그로 처음 뜨면 그때의 최신 블록부터 읽으므로 따라잡을 것이 없습니다. 다시 뜰 때는 마지막 스캔 표시의 5블록 앞부터 100블록씩 읽습니다. 서버가 하루 꺼져 있었다면 약 2,160번 요청하고 몇 분 걸리며, 그 사이 `/api/health`는 답하지 않습니다. 긴 따라잡기는 10구간(1,000블록)마다 표시를 남기므로, 도중에 다시 시작해도 처음부터 읽지 않습니다. 한 구간이 실패하면(예: RPC 요청 한도) 1, 2, 4, 8, 16, 30초를 기다리며 다시 시도하고, 그래도 안 되면 부팅을 거부합니다.
- **바뀐 블록 위의 표시:** 부팅할 때 로그의 가장 최근 스캔 표시가 체인에 없는 블록(바뀌었거나 다른 체인)을 가리키면, 체인에 남아 있는 더 오래된 표시를 찾아 거기서 다시 읽고 `scan-marker-rewound` 경보를 남깁니다. 체인이 로그의 첫 표시 블록을 **다른 해시로** 갖고 있을 때만 다른 체인 인스턴스로 보고 부팅을 거부하며, 새 데이터 디렉터리를 쓰라고 안내합니다. 노드에 그 블록이 아예 없으면(뒤처졌거나, 동기화가 어긋났거나, 오래된 블록을 지운 노드) 읽기 실패로 부팅을 거부하고 "이벤트 로그는 멀쩡하니 나중에 또는 다른 RPC로 다시 띄우라"고 안내합니다. 이때 데이터 디렉터리를 바꾸면 안 됩니다.
- **볼륨 잠금:** 진입점(`scripts/container-start.sh`)은 볼륨의 `container.lock`에 배타 `flock`을 걸고, 서버가 사는 동안 그 잠금을 쥐고 있습니다. 같은 볼륨에 두 번째 컨테이너가 뜨면 여기서 멈춥니다. 잠금을 쥔 뒤에만 지난번 서버가 남긴 `events.lock`을 지웁니다. 컨테이너마다 pid가 새로 시작해서, 남은 잠금이 엉뚱한 살아 있는 프로세스를 가리킬 수 있기 때문입니다. 서버는 root로 돕니다.

### 8.2 Docker

```sh
pnpm monad:server-env
docker build -t maze-web .
docker volume create maze-data
docker run -d --name maze-web --restart unless-stopped \
  -p 3000:3000 -v maze-data:/data --env-file .env.monad.server maze-web
docker logs -f maze-web        # {"event":"boot",...} 줄이 나오면 준비 완료
```

이미지는 `node:26-slim` 기반입니다(루트 `engines`는 Node 25 이상). 빌드는 두 단계입니다. 빌드 단계는 의존성 전부를 설치하고 `NEXT_OUTPUT=standalone`으로 `next build`를 하고, 실행 단계는 Next의 standalone 출력(서버와 그 서버가 실제로 읽는 파일만), 정적 파일, `public`만 가져갑니다. 실행 단계에서는 패키지를 하나도 설치하지 않으므로 지갑 SDK 같은 브라우저 전용 의존성이 이미지에 들어가지 않습니다. 로컬 standalone 빌드는 55 MB였습니다. 서버는 `next start` 대신 standalone의 `server.js`로 뜹니다. pnpm은 `packageManager`와 같은 10.28.1을 npm으로 설치합니다. 최근 Node 이미지에는 corepack이 없고 npm의 corepack은 모든 Node 버전을 지원하지 않습니다. 테스트, 컨트랙트, 문서, 키 파일은 빌드 맥락에 들어가지 않습니다(`.dockerignore`). HTTPS는 앞단의 프록시나 호스트가 맡습니다.

### 8.3 Fly.io (`fly.toml`)

```sh
fly apps create <앱 이름>            # fly.toml의 app 값을 그 이름으로 바꿉니다
fly volumes create maze_data --size 1 --region nrt
pnpm monad:server-env
fly secrets import < .env.monad.server
fly deploy
fly logs                             # boot 줄 확인
```

`fly.toml`은 볼륨을 `/data`에 붙이고, 요청이 없어도 기계를 멈추지 않으며(`auto_stop_machines = "off"`, `min_machines_running = 1`), `/api/health`로 상태를 봅니다(부팅 따라잡기를 위해 유예 120초). **`fly scale count`로 두 대 이상 늘리지 마세요.** 주소는 `https://<앱 이름>.fly.dev`입니다. 다른 호스트도 "컨테이너 하나 + `/data` 영구 볼륨 + 환경 변수"만 맞추면 같습니다.

## 9. Privy 대시보드 설정

1. [dashboard.privy.io](https://dashboard.privy.io)에서 앱을 만들고 **App ID**를 복사해 `.env.monad`의 `PRIVY_APP_ID=`에 넣습니다. `pnpm monad:server-env`를 다시 돌리고 서버에 반영합니다(Fly: `fly secrets import < .env.monad.server`, 그러면 다시 시작됩니다). 지금 서버는 Privy API를 부르지 않으므로 App secret은 필요 없습니다. App ID는 정확히 25자입니다. 쓰고 있는 `@privy-io/react-auth` 3.48.0은 길이가 다르면 브라우저에서 로그인을 띄우지 못합니다(게임 화면은 뜨고 로그인만 빠집니다). 서버는 오타 하나로 멈추지 않도록 8~64자의 영숫자, `_`, `-`만 확인하고, 길이는 `pnpm monad:server-env`가 확인합니다. 25자가 아니면 서버용 파일을 만들지 않습니다.
2. **허용 도메인(Allowed origins):** 호스팅 주소(예: `https://<앱 이름>.fly.dev`)와 `http://localhost:3000`. 끝에 `/`를 붙이지 않습니다. 직접 도메인을 붙이면 그것도 더합니다.
3. **로그인 방법:** 이메일, Google, 패스키, 지갑(외부 지갑). Google은 처음에는 Privy 기본 자격 증명으로 되고, 공개 전에는 직접 만든 Google OAuth 클라이언트를 넣는 것이 좋습니다.
4. **임베디드 지갑:** 로그인할 때 만들기(Create on login), 지갑이 없는 사용자에게. 체인은 브라우저가 `/api/config`의 `chainId`(10143)로 정합니다.

5. **HTTPS:** 임베디드 지갑은 HTTPS에서만 동작합니다. 예외는 `localhost`와 `127.0.0.1`의 http뿐입니다. 호스팅 주소는 반드시 https로 여세요(Fly는 `force_https = true`).

메뉴 이름은 대시보드 개편에 따라 조금 다를 수 있습니다.

## 10. 스모크 테스트

배포한 서버에서:

```sh
curl -s https://<호스트>/api/health        # {"ok":true,"mazeVersion":1}
curl -s https://<호스트>/api/config | jq '{chainId, contract, network, privyAppId, testHooks, devWallet}'
#  chainId 10143, contract = MAZEBET_ADDRESS, network.symbol "MON", testHooks false, devWallet false
pnpm monad:status                          # 경고 없음
```

브라우저에서: Privy로 로그인 → 임베디드 지갑 주소에 faucet으로 MON 받기 → 5×5에 0.001 MON 베팅 → 한두 칸 이동 → 캐시아웃 → 몇 초 안에 정산 트랜잭션이 생기고, 탐색기에서 보낸 주소가 릴레이어인지 확인 → 검증 화면(`/verify`)이 결과를 맞다고 판정하는지 확인. 끝나고 `pnpm monad:status`에서 묶인 금액이 0으로 돌아오고 릴레이어 잔액이 약 0.03 MON 줄었는지 봅니다.

**리허설 2(2026-10-08, 지금 코드):** 체인 id 10143, 1초 블록, `--slots-in-an-epoch 1`(`finalized`가 `latest`보다 2블록 뒤처짐)인 Anvil(포트 8593)에 버리는 키로 했습니다. `monad:deploy --fund 2`는 `MAZEBET_ADDRESS`만 채웠고(`MAZE_START_BLOCK` 없음), `monad:server-env`는 24자 `PRIVY_APP_ID`를 거부했으며 빈 값에는 경고만 했고, 주석 없는 파일을 썼습니다. standalone 빌드의 `server.js`가 테스트 훅 없이 부팅해 첫 스캔 표시를 그때의 finalized 블록(39)에 남겼고, 부팅 때 `eth_getLogs`는 한 번이었습니다. 한 판(티켓 → `createGame` → 시작 → 한 칸 → 캐시아웃)에서 `/start`는 `NOT_ON_CHAIN`을 4번(2.0초) 답한 뒤 시작했고, 릴레이어의 `settle`은 블록이 finalized된 뒤 `settle-mined`로 기록됐습니다. 브라우저는 `NOT_ON_CHAIN`을 0.5초마다 20번까지 조용히 다시 묻고 그 뒤에도 3초마다 묻습니다(`use-game.ts`). SIGTERM 뒤 다시 띄우자 로그 10줄을 재생하고 부팅했습니다. 스냅숏(78블록) 뒤에 스캔 표시 두 개(79, 84)를 쌓고 서버를 내린 다음 체인을 스냅숏으로 되돌렸습니다. 다시 띄우자 `scan-marker-rewound`(84 → 75)를 남기고 75블록부터 다시 읽어 부팅했고, 그다음 재시작에서는 되감지 않았습니다. 조용할 때 RPC 요청은 초당 5회였습니다(500ms마다 finalized 머리와 시계용 최신 블록, 새 블록마다 `eth_getLogs` 한 번). 0.4초 블록이면 초당 약 6회입니다.

**리허설 1(2026-10-08, 앞의 코드):** 체인 id 10143인 Anvil(포트 8593)에 버리는 키로 같은 순서를 밟았습니다. `monad:keys --env` → 잔액 부족 배포 거부 확인 → `monad:deploy --fund 2`(배포 블록 68, 72블록까지 기다려 73블록에서 입금) → 같은 설정 파일로 다시 배포 시도 거부 확인 → `monad:fund 0.5` → `monad:status` → `monad:server-env` → 운영 빌드의 `next start`(테스트 훅 없음)가 부팅. `/api/health`는 `{"ok":true}`, `/api/config`는 `chainId 10143`, `network.symbol "MON"`, `testHooks false`였습니다. 실제 한 판(티켓 → `createGame` 0.001 MON → 시작 → 한 칸 → 캐시아웃)은 릴레이어가 `settle`해서 체인에 `GameSettled`(지급 0.00073 MON)가 남았고, 서버를 SIGTERM으로 내렸다 다시 띄우자 로그 11줄을 재생하고 정상 부팅했습니다. (그때는 `MAZE_START_BLOCK`이 필수였습니다.) 그때의 Dockerfile(`node:25-slim`, 실행 단계에서 운영 의존성 설치)은 `docker build`의 모든 단계를 통과했지만, 마지막 이미지 내보내기는 로컬 디스크가 가득 차 Docker 데몬이 멈추는 바람에 확인하지 못했습니다. 지금의 Dockerfile(`node:26-slim`, standalone)은 Docker 데몬이 멈춘 상태라 빌드하지 못했고, standalone 빌드와 그 `server.js`는 리허설 2에서 로컬로 확인했습니다. 컨테이너 자체를 띄우는 확인은 원격 빌드(`fly deploy`)나 Docker를 다시 시작한 뒤에 할 일로 남아 있습니다.

## 11. 알아 둘 것

- **정산 가스가 작은 베팅보다 큽니다.** 정산 한 건이 0.0306 MON이고 하우스(릴레이어)가 냅니다. 0.01 MON 베팅에서 하우스 몫은 판당 약 0.0004~0.0005 MON이라, 테스트넷에서는 판마다 하우스가 가스로 손해를 봅니다. 실제 사용량(65,216, Ethereum 가스표 기준. Monad는 콜드 계정 접근 10,100, ecrecover 6,000으로 더 비쌈)을 보면 한도를 줄일 여지가 있지만, 30,000 가스를 넘겨받는 지급 수신자까지 고려한 설계 값(계획 §3.6)이라 이번에는 바꾸지 않았습니다.
- **플레이어의 `createGame` 가스**는 176,475(리허설)라 102 gwei면 약 0.018 MON입니다. 0.001 MON 베팅보다 18배 큽니다. 플레이어 지갑에는 베팅액보다 가스용 MON이 더 필요합니다.
- **플레이어도 예비 잔액 규칙을 받습니다.** 잔액이 10 MON 미만인 지갑이 1.2초(3블록) 안에 두 번째 송금을 하면 되돌려지고 가스만 나갑니다. 판을 연달아 빠르게 시작할 때 생길 수 있습니다.
- **서버는 finalized 블록만 읽습니다.** Monad RPC의 `latest`는 아직 바뀔 수 있는 제안 블록이라, 31337 밖에서 서버는 판의 이벤트와 스캔 표시를 `finalized` 블록에서만 읽습니다. 그만큼(Monad에서 약 1초) 늦게 봅니다. 베팅 직후 `/start`가 잠깐 `NOT_ON_CHAIN`을 답하고 브라우저가 다시 묻습니다. 티켓 만료 직전에 만든 판도 스캔이 만료 시각을 넘을 때까지는 `TICKET_EXPIRED`가 아니라 `NOT_ON_CHAIN`으로 답합니다. 그동안 그 주소에는 새 티켓을 주지 않습니다. 정산을 보낸 직후 같은 주소로 새 판을 청하면, 서버가 스캔을 0.25초마다 다시 돌리며 2초까지 기다린 뒤 답합니다. 그래서 바로 `ALREADY_ACTIVE`가 나지 않습니다. 이렇게 요청이 부르는 스캔은 동시에 여럿이 와도 공유됩니다. 하나가 돌고 있으면 그 뒤에 한 번만 더 돌며, 그동안 온 요청이 모두 그 결과를 함께 씁니다. 그래서 대기 중인 주소가 많아도 RPC 요청이 그만큼 늘지 않습니다. 시계(시간 제한, 정산 기한)는 계속 최신 블록의 시각을 씁니다. 31337(Anvil)에서는 스캔이 시계를 따라가므로 이 대기가 없고 예전과 같습니다.
- **로그가 꾸준히 자랍니다.** 게임이 없어도 체인 시간 60초마다 스캔 표시를 한 줄 남겨 하루 약 1,440줄, 200 KB입니다. 부팅 때 로그 전체를 재생하므로 아주 오래 돌리면 부팅이 느려집니다.
- **RPC 한도:** 공개 RPC는 초당 25회, `eth_getLogs` 100블록입니다. 서버 한 대는 조용할 때 초당 약 6회를 쓰므로 충분하지만, 브라우저도 같은 공개 RPC를 씁니다(`PUBLIC_RPC_URL`). 사용자가 많아지면 키가 있는 RPC를 `RPC_URL`에 넣고 공개 RPC를 `PUBLIC_RPC_URL`에 두세요.
