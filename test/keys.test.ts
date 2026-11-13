import { KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";
import { AgentKeys, deriveKey } from "../src/app/testnet.js";

describe("agent keys derived from AGENT_KEY_SECRET", () => {
  it("are stable per account and differ between accounts and secrets", () => {
    const a = deriveKey("s1", "alice.testnet");
    expect(deriveKey("s1", "alice.testnet")).toBe(a);
    expect(deriveKey("s1", "bob.testnet")).not.toBe(a);
    expect(deriveKey("s2", "alice.testnet")).not.toBe(a);
  });

  it("are valid ed25519 key pairs that sign and verify", () => {
    const kp = KeyPair.fromString(deriveKey("s1", "alice.testnet") as `ed25519:${string}`);
    const msg = new TextEncoder().encode("pay");
    const { signature } = kp.sign(msg);
    expect(kp.verify(msg, signature)).toBe(true);
    expect(kp.getPublicKey().toString()).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it("AgentKeys with a secret writes nothing and gives every instance the same key", () => {
    const path = "/nonexistent-dir/agent-keys.json"; // would throw if it tried to write
    const one = new AgentKeys(path, "secret");
    const two = new AgentKeys(path, "secret");
    expect(one.ensure("carol.testnet")).toBe(two.publicKey("carol.testnet"));
    expect(one.secret("carol.testnet")).toBe(deriveKey("secret", "carol.testnet"));
  });
});
