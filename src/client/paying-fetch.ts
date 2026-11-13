import type { Ledger } from "../ledger/types.js";
import {
  decodeHeader,
  encodeHeader,
  SCHEME,
  PROTOCOL_VERSION,
  type PaymentPayload,
  type PaymentRequiredBody,
  type PaymentRequirements,
  type SettlementResponse,
} from "../near6/types.js";

export interface PayingFetchOptions {
  ledger: Ledger;
  vault: string;
  /** Assets the agent is willing to pay in. The vault enforces the real limits. */
  acceptAssets: string[];
  onPayment?: (info: { requirements: PaymentRequirements; txHash: string }) => void;
}

/**
 * A fetch that pays for Near6 resources on its own: on a 402 response it pays
 * through the agent's firewall vault and retries with the tx hash as proof.
 * If the firewall refuses, the FirewallError propagates to the caller.
 */
export function createPayingFetch(opts: PayingFetchOptions) {
  return async function payingFetch(url: string, init: RequestInit = {}) {
    const first = await fetch(url, init);
    if (first.status !== 402) return first;

    const body = (await first.json()) as PaymentRequiredBody;
    const requirements = body.accepts.find(
      (r) => r.scheme === SCHEME && r.network === opts.ledger.network && opts.acceptAssets.includes(r.asset),
    );
    if (!requirements) throw new Error(`no acceptable payment option for ${url}`);

    const txHash = await opts.ledger.pay({
      vault: opts.vault,
      payee: requirements.payTo,
      amount: BigInt(requirements.maxAmountRequired),
      memo: requirements.extra.nonce,
    });
    opts.onPayment?.({ requirements, txHash });

    const payment: PaymentPayload = {
      x402Version: PROTOCOL_VERSION,
      scheme: SCHEME,
      network: requirements.network,
      payload: { txHash, payer: opts.vault, nonce: requirements.extra.nonce, from: opts.ledger.fundsHolder },
    };
    const headers = new Headers(init.headers);
    headers.set("X-PAYMENT", encodeHeader(payment));
    return fetch(url, { ...init, headers });
  };
}

export function readSettlement(res: Response): SettlementResponse | undefined {
  const header = res.headers.get("X-PAYMENT-RESPONSE");
  return header ? decodeHeader<SettlementResponse>(header) : undefined;
}
