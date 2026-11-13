import type { FtTransferEvent, Ledger } from "../ledger/types.js";
import type { PaymentPayload, PaymentRequirements } from "./types.js";
import { SCHEME, PROTOCOL_VERSION } from "./types.js";

export type Verification = { ok: true } | { ok: false; reason: string };

/**
 * A payment is valid when the token contract itself (not the payer's vault,
 * which could be any code) logged a transfer to `payTo` of at least the price,
 * tagged with the nonce we issued. Trusting only the token's event means a fake
 * vault that emits fake logs can't pass.
 */
export function matchTransfer(events: FtTransferEvent[], req: PaymentRequirements, payer: string): Verification {
  const hit = events.find(
    (e) =>
      e.executor === req.asset &&
      e.oldOwner === payer &&
      e.newOwner === req.payTo &&
      e.memo === req.extra.nonce &&
      e.amount >= BigInt(req.maxAmountRequired),
  );
  return hit ? { ok: true } : { ok: false, reason: "no matching token transfer in transaction" };
}

export async function verifyPayment(
  ledger: Ledger,
  payment: PaymentPayload,
  req: PaymentRequirements,
): Promise<Verification> {
  if (payment.x402Version !== PROTOCOL_VERSION) return { ok: false, reason: "unsupported x402Version" };
  if (payment.scheme !== SCHEME) return { ok: false, reason: "unsupported scheme" };
  if (payment.network !== req.network) return { ok: false, reason: "wrong network" };
  if (payment.payload.nonce !== req.extra.nonce) return { ok: false, reason: "nonce mismatch" };
  const events = await ledger.transfersIn(payment.payload.txHash, payment.payload.payer);
  return matchTransfer(events, req, payment.payload.from ?? payment.payload.payer);
}
