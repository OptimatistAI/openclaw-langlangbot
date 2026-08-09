import type { LanglangbotSidecar } from "@optimatist/langlangbot-connector";

import {
  handleManagementRequest,
  managementErrorPayload,
  type ManagementRequestPayload,
} from "./agent-runtime.js";
import type { LanglangbotAccount } from "./config.js";
import { formatError } from "./config.js";

export function startManagementBridge(params: {
  sidecar: LanglangbotSidecar;
  account: LanglangbotAccount;
  log?: {
    warn?: (message: string) => void;
    error?: (message: string) => void;
    debug?: (message: string) => void;
  };
}): () => void {
  const { sidecar, account, log } = params;
  return sidecar.subscribeManagementEvents(
    { accountId: account.accountId },
    (evt) => {
      void (async () => {
        try {
          log?.debug?.(
            `[langlangbot:${account.accountId}] management ${evt.operation} → ${evt.conversation_id}`,
          );
          const result = await handleManagementRequest(
            evt as ManagementRequestPayload,
            account,
          );
          await sidecar.postManagementResult(evt.request_id, {
            ok: true,
            result,
          });
        } catch (err) {
          const error = managementErrorPayload(err);
          log?.warn?.(
            `[langlangbot:${account.accountId}] management ${evt.operation} failed: ${formatError(err)}`,
          );
          await sidecar.postManagementResult(evt.request_id, {
            ok: false,
            error,
          });
        }
      })();
    },
    (err) => {
      log?.warn?.(
        `[langlangbot:${account.accountId}] management SSE error: ${err.message}`,
      );
    },
  );
}
