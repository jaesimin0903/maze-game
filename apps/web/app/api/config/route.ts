import { json, route } from '../../../src/server/http';
import { toConfigResponse } from '../../../src/server/serializer';

export const dynamic = 'force-dynamic';

/** `GET /api/config`: everything the browser needs to know about the chain and the table. */
export const GET = route(async ({ container }) => {
  const { config, table, tableHash, testHooks, idleTimeoutSec, maxGameSec, clock } = container;
  return json(
    toConfigResponse({
      chainId: config.chainId,
      rpcUrl: config.publicRpcUrl,
      contract: config.contract,
      table,
      tableHash,
      testHooks,
      devWallet: config.devWallet,
      idleTimeoutSec,
      maxGameSec,
      nowSec: await clock.chainNow(),
      network: config.network,
      privyAppId: config.privyAppId,
    }),
  );
});
