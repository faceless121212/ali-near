import { randomBytes } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Ledger } from "../ledger/types.js";
import {
  caip2,
  decodeHeader,
  encodeHeader,
  fromV2Payload,
  SCHEME,
  PROTOCOL_VERSION,
  toV2,
  X402_V2,
  type PaymentPayload,
  type PaymentPayloadV2,
  type PaymentRequiredBody,
  type PaymentRequiredV2,
  type PaymentRequirements,
  type SettlementResponse,
  type SettlementResponseV2,
} from "./types.js";
import { verifyPayment } from "./verify.js";

export interface PaywallOptions {
  ledger: Ledger;
  price: bigint;
  payTo: string;
  asset: string;
  description: string;
  maxTimeoutSeconds?: number;
}

interface Pending {
  req: PaymentRequirements;
  expiresAt: number;
}

/**
 * Express middleware that charges per request. Each 402 issues a fresh nonce,
 * and each nonce can unlock exactly one response, which blocks replaying a tx hash.
 * It speaks x402 v1 (body + X-PAYMENT) and v2 (PAYMENT-REQUIRED / PAYMENT-SIGNATURE).
 */
export function paywall(opts: PaywallOptions): RequestHandler {
  const pending = new Map<string, Pending>();
  const timeout = opts.maxTimeoutSeconds ?? 120;

  return async (req: Request, res: Response, next: NextFunction) => {
    const v2 = req.header("PAYMENT-SIGNATURE");
    const header = v2 ?? req.header("X-PAYMENT");
    if (!header) return paymentRequired(res, issue(req), "payment required: send X-PAYMENT (x402 v1) or PAYMENT-SIGNATURE (x402 v2)");

    let payment: PaymentPayload;
    try {
      payment = v2 ? fromV2Payload(decodeHeader<PaymentPayloadV2>(v2)) : decodeHeader<PaymentPayload>(header);
      if (v2 && decodeHeader<PaymentPayloadV2>(v2).x402Version !== X402_V2) throw new Error("version");
    } catch {
      return paymentRequired(res, issue(req), "malformed payment header");
    }

    const entry = pending.get(payment.payload?.nonce);
    if (!entry || entry.expiresAt < Date.now() || entry.req.resource !== req.originalUrl) {
      return paymentRequired(res, issue(req), "unknown, used or expired nonce");
    }
    // Consume the nonce before the async check so two parallel retries can't both pass.
    pending.delete(payment.payload.nonce);

    let result;
    try {
      result = await verifyPayment(opts.ledger, payment, entry.req);
    } catch (err) {
      result = { ok: false as const, reason: `verification failed: ${(err as Error).message}` };
    }
    if (!result.ok) return paymentRequired(res, issue(req), result.reason);

    const settlement: SettlementResponse = {
      success: true,
      transaction: payment.payload.txHash,
      network: opts.ledger.network,
      payer: payment.payload.payer,
    };
    const settlementV2: SettlementResponseV2 = { ...settlement, network: caip2(settlement.network), amount: entry.req.maxAmountRequired };
    res.setHeader("X-PAYMENT-RESPONSE", encodeHeader(settlement));
    res.setHeader("PAYMENT-RESPONSE", encodeHeader(settlementV2));
    next();
  };

  function issue(req: Request): PaymentRequirements {
    const nonce = randomBytes(12).toString("hex");
    const requirements: PaymentRequirements = {
      scheme: SCHEME,
      network: opts.ledger.network,
      maxAmountRequired: opts.price.toString(),
      resource: req.originalUrl,
      description: opts.description,
      mimeType: "application/json",
      payTo: opts.payTo,
      asset: opts.asset,
      maxTimeoutSeconds: timeout,
      extra: { nonce },
    };
    pending.set(nonce, { req: requirements, expiresAt: Date.now() + timeout * 1000 });
    return requirements;
  }
}

function paymentRequired(res: Response, requirements: PaymentRequirements, error: string) {
  const body: PaymentRequiredBody = { x402Version: PROTOCOL_VERSION, error, accepts: [requirements] };
  const v2: PaymentRequiredV2 = {
    x402Version: X402_V2,
    error,
    resource: { url: requirements.resource, description: requirements.description, mimeType: requirements.mimeType },
    accepts: [toV2(requirements)],
  };
  res.setHeader("PAYMENT-REQUIRED", encodeHeader(v2));
  res.setHeader("Access-Control-Expose-Headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE");
  res.status(402).json(body);
}
