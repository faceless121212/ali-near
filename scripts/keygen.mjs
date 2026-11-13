import { KeyPair } from "near-api-js";
const kp = KeyPair.fromRandom("ed25519");
console.log(JSON.stringify({ secret: kp.toString(), public: kp.getPublicKey().toString() }));
