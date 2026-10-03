#!/usr/bin/env bash
# Build all programs, and fail on a BPF stack-frame overflow (cargo build-sbf exits 0 on it).
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
# Platform tools v1.57 (rustc 1.95): the default of build-sbf 3.0.13 (v1.51, cargo 1.84)
# cannot parse the edition2024 crates that anchor 1.2 pulls in.
sbf=(cargo build-sbf --tools-version v1.57)
# `&&` + `|| status=$?`: a failed build must fail the script, not leave a stale .so for `ls` to find.
status=0
out=$("${sbf[@]}" --manifest-path programs/v1-core/Cargo.toml 2>&1 && "${sbf[@]}" --manifest-path programs/mock-venue/Cargo.toml 2>&1) || status=$?
echo "$out"
if grep -q "overflows the maximum allowed frame space" <<<"$out"; then
  echo "BUILD REJECTED: a function exceeds the 4096-byte BPF stack frame. Box large accounts."; exit 1
fi
if [ "$status" -ne 0 ]; then echo "BUILD FAILED (exit $status)"; exit "$status"; fi
ls target/deploy/v1_core.so target/deploy/mock_venue.so
