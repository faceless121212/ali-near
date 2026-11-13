// Near6 wire format: Ali's pay-per-call protocol for NEAR, built on HTTP 402.
//
// The messages follow the x402 format (a 402 body with `accepts`, plus the
// X-PAYMENT / X-PAYMENT-RESPONSE headers), so x402 tooling recognizes them.
// Settlement is NEAR-specific: the agent pays first through its firewall vault,
// then sends the tx hash, and the server verifies the NEP-141 transfer on-chain.

export const PROTOCOL_VERSION = 1;
export const SCHEME = "near6";

export interface PaymentRequirements {
  scheme: typeof SCHEME;
  network: string; // "near-testnet" | "near-mainnet" | "near-mock"
  maxAmountRequired: string; // smallest token units
  resource: string;
  description: string;
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
  payload: { txHash: string; payer: string; nonce: string };
}

export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
}

export const encodeHeader = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

export function decodeHeader<T>(header: string): T {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as T;
}
