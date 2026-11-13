// Node globals some wallet libraries expect in the browser.
import { Buffer } from "buffer";

globalThis.Buffer ??= Buffer;
globalThis.process ??= { env: {}, browser: true, version: "", versions: {} };
