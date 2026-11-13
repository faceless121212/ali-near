// Near6 wire format: Ali's pay-per-call protocol for NEAR, built on HTTP 402.
//
// Near6 is an x402-compatible payment scheme for NEAR. A paywall speaks both
// x402 versions at once:
//   v1  402 JSON body with `accepts`; X-PAYMENT / X-PAYMENT-RESPONSE headers
//   v2  PAYMENT-REQUIRED / PAYMENT-SIGNATURE / PAYMENT-RESPONSE headers (base64
//       JSON), CAIP-2 network ids ("near:testnet"), `amount` instead of
//       `maxAmountRequired`
// Settlement is NEAR-specific: the agent pays first through its firewall vault,
// then sends the tx hash, and the server verifies the NEP-141 transfer on-chain.

export const PROTOCOL_VERSION = 1;
export const X402_V2 = 2;
export const SCHEME = "near6";

export interface PaymentRequirements {
  scheme: typeof SCHEME;
  network: string; // "near-testnet" | "near-mainnet" | "near-mock"
  maxAmountRequired: string; // smallest token units
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  asset: string; // NEP-141 contract id
  maxTimeoutSeconds: number;
  extra: { nonce: string };
}

export interface PaymentRequiredBody {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
}

export interface PaymentPayload {
  x402Version: number;
  scheme: typeof SCHEME;
  network: string;
  /**
   * `payer` signed the transaction. `from` is the account the tokens left, when
   * that differs from the payer (a shared firewall contract holding the funds).
   */
  payload: { txHash: string; payer: string; nonce: string; from?: string };
}

export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
}

// ---------- x402 v2 ----------

/** "near-testnet" → "near:testnet" (CAIP-2). */
export const caip2 = (network: string) => (network.startsWith("near-") ? `near:${network.slice(5)}` : network);
/** "near:testnet" → "near-testnet". */
export const fromCaip2 = (network: string) => (network.startsWith("near:") ? `near-${network.slice(5)}` : network);

export interface PaymentRequirementsV2 {
  scheme: typeof SCHEME;
  network: string; // CAIP-2: "near:testnet"
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { nonce: string };
}

export interface Resource {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface PaymentRequiredV2 {
  x402Version: 2;
  error?: string;
  resource: Resource;
  accepts: PaymentRequirementsV2[];
}

export interface PaymentPayloadV2 {
  x402Version: 2;
  resource?: Resource;
  accepted: PaymentRequirementsV2;
  payload: PaymentPayload["payload"];
}

export interface SettlementResponseV2 {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
  amount?: string;
}

export function toV2(req: PaymentRequirements): PaymentRequirementsV2 {
  return {
    scheme: req.scheme,
    network: caip2(req.network),
    amount: req.maxAmountRequired,
    asset: req.asset,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    extra: req.extra,
  };
}

/** A v2 payment, in the v1 shape the verifier checks. */
export function fromV2Payload(p: PaymentPayloadV2): PaymentPayload {
  return { x402Version: PROTOCOL_VERSION, scheme: p.accepted?.scheme, network: fromCaip2(p.accepted?.network ?? ""), payload: p.payload };
}

export const encodeHeader = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

export function decodeHeader<T>(header: string): T {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as T;
}
