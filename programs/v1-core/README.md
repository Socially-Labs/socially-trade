# v1-core

The socially.trade v1 core program (Anchor 1.2): social-trading funds on Solana.

## Build and test

```bash
scripts/build-programs.sh      # cargo build-sbf for v1-core and mock-venue; fails on a stack-frame overflow
cargo test -p v1-core          # LiteSVM tests; they load target/deploy/*.so, so build first
```

Do not use `anchor build`. The build script uses platform tools v1.57.

## Program ids

| Program    | Id                                             |
|------------|------------------------------------------------|
| v1-core    | `HjRBKzvcuSiztYH97iL6RtbwDU9Mw8AF3Av3Q1nJgQsi` |
| mock-venue | `7wy5kqiVEWLHgmoccpe1DUD5vFA6tm68CM3hWiMcY1ng` |

The keypairs live in `target/deploy/` and are not in git. On a new clone, make new ones:

```bash
solana-keygen new --no-bip39-passphrase -s -o target/deploy/v1_core-keypair.json
solana-keygen new --no-bip39-passphrase -s -o target/deploy/mock_venue-keypair.json
```

Then put the new pubkeys in `declare_id!` (`programs/*/src/lib.rs`) and in
`mock_venue_id()` (`programs/v1-core/tests/common/mod.rs`). The tests do not need
the keypairs: they load the `.so` at the id in `declare_id!`.
