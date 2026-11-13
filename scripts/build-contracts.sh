#!/bin/sh
# Builds both contracts for NEAR. `--cfg near` makes near-sdk report panics
# (ERR_* codes) to the chain; wasm-opt (from binaryen) shrinks the code, which
# lowers the storage cost of deploying it.
set -e
cd "$(dirname "$0")/../contracts"
for c in agent-firewall firewall-hub test-usdc; do
  (cd "$c" && RUSTFLAGS='--cfg near' cargo build --target wasm32-unknown-unknown --release)
  f="$c/target/wasm32-unknown-unknown/release/$(echo "$c" | tr - _).wasm"
  wasm-opt -Oz --signext-lowering --strip-debug --strip-producers "$f" -o "$f"
  echo "built $f ($(wc -c < "$f" | tr -d ' ') bytes)"
done
