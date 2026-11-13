import { randomBytes } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
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
 */
export function paywall(opts: PaywallOptions): RequestHandler {
  const pending = new Map<string, Pending>();
  const timeout = opts.maxTimeoutSeconds ?? 120;

  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.header("X-PAYMENT");
    if (!header) return paymentRequired(res, issue(req), "X-PAYMENT header is required");

    let payment: PaymentPayload;
    try {
      payment = decodeHeader<PaymentPayload>(header);
    } catch {
      return paymentRequired(res, issue(req), "malformed X-PAYMENT header");
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
    res.setHeader("X-PAYMENT-RESPONSE", encodeHeader(settlement));
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
  res.status(402).json(body);
}
