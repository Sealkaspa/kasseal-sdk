# Contract artifacts

The SDK bundles the compiled Kasseal contracts for exactly two builds. It does not fetch programs from any server:
every program the SDK builds with or checks against is in the package, and every file is checked against its
SHA-256 when it loads.

## The two builds

Both builds are frozen: their programs never change. A change would be a new build with a new name and new hashes,
shipped in a new SDK release.

| | Mainnet | Testnet-10 |
|---|---|---|
| Build | `v1-kasseal-mainnet-2` | `v1-kasseal-mainnet-2-tn10` |
| Network id | `mainnet` | `testnet-10` |
| Pool template hash | `92acd761504e4fa05acf70675ef1aea0c66efa2126ec5c726e4779b8aef054e0` | `28170395ca9350966c0d732ffce8b13c5a94201e74552b7add67143a35dea56a` |
| Pool program size | 15,197 bytes | 15,197 bytes |
| Standard curve template hash (placeholder creator) | `63f032f087bbc2b66e0f2561b1f40a6319c80f9792743c7e77e5761d41f51f5f` | `1154008bee8cb3998f2237f15f056191e98a70dfbca6692ac85c05363dafc3c3` |
| Token template hash (KCC-20 reference) | `9703112ee6e3555107cd168858992b77d3b74f655205b2b463b1f9ec2ec73cf7` | the same |
| Fee recipient (treasury) | `kaspa:qrt0p8sd5g8k383mzxgqtyl7ehkdez8ds8cpxqcuwjdaayke9rjhg9pqnr3zx` | `kaspatest:qp8pqkcf0w8l3mke93eu86ngyc808x54t574a8jha96nu63x8tfn2et7nk35w` |
| Treasury script (`params.treasurySpk`) | `000020d6f09e0da20f689e3b11900593fecdecdc88ed81f013031c749bde92d928e574ac` | `0000204e105b097b8ff8eed92c73c3ea68260ef39a955d3d5e9e57e9753e6a263ad335ac` |
| Compiler | silverc v1.0.0 (`3ed973335b59269293564805cc2c58a14595ec03`) | the same |

The testnet-10 build mirrors the mainnet build: the same contract sources and constructor values, except the
treasury. Every hash that depends on the treasury differs; nothing else does. Testnet-10 accepts only the testnet-10
build, and mainnet only the mainnet build.

The curve's `poolH` constant, which pins the pool program a curve graduates into, is the pool template hash of its
own build.

### Curve programs

Each build carries **66 curve programs**: the Standard curve shape at each launch price band (lots of 1,000 tokens
in the lower bands, 10,000 in the higher ones). Mainnet launches use only these. The creator's payout key is a
constant of the curve program, so a launched token's curve has its own template hash. The SDK recognises a curve by
matching its program against these 66 with the creator key slots masked, and reads the constants from the program
itself.

The template hash of every curve program is listed in the build's manifest in the package.

## Pool artifact files (SHA-256)

| File | Mainnet | Testnet-10 |
|---|---|---|
| `pool.artifact.json` | `7ae79b8a9a36e6b7469dc7fe1d8bd3cc227abe94632e3fe1e36cfcebcb1cccb2` | `11bf7c41d2fb90beb07d92a0d8ce7de32accf676e182fa6882b84c123f3aad3c` |
| `pool.bytecode.hex` | `e7b80312702242718e1500eea070336b55dcf7f77009660c5122a8a7387a84ff` | `b053a9261fa701865db472d42ad13685173cb9100e1adc7ebd07422dee93f9ec` |
| `pool.ctor.json` | `d2e5abb2350d1f5e7657aca91e5af4ab05b4e42004fe26a2acee956e359afbae` | `0e88b336995fcd2c4a84b882239c0a4071dd921e33bd59baf0b0d2a3bf1c3f0b` |
| `constants.json` | `62ab2297f5df695ab32938d53725939377b1cd8f070f0fbd63c12464ed5e9160` | `c5770e41c7cb1d90061e7525de27a0be0bb8c97b42c091b2a991b65117e0fc01` |

The KCC-20 reference token program ships as `argent-kcc20-reference-c8a0871.json`, SHA-256
`462a937240ff3dc6f297a06c2eeb48c5150e4a2a4995eedc71c724f3a34eedee`, compiled from `argent-lang/kcc20-reference` at
revision `c8a0871`.

## How the SDK checks them

- **At load, fail closed.** The package carries a manifest per build with the SHA-256 of every artifact file and the
  template hash of every program. The SDK hashes each file before using it and refuses to start on any difference.
- **Template hashes are recomputed.** When the SDK reads a program, it recomputes its template hash from the bytes and
  compares it with the manifest. A cell the API serves is checked the same way: the SDK recomputes the template hash
  from the cell's own redeem script and never trusts a hash from the wire.
- **The Kaspa WASM SDK** (rusty-kaspa v2.1.0) is checked the same way, against SHA-256 values pinned in the package.

## Checking them yourself

You do not need the SDK to check the bundled files. After `npm install`:

```sh
cd node_modules/@kassealhq/sdk
shasum -a 256 <path to>/pool.artifact.json         # compare with the table above and with the manifest
```

Compare each file's hash with the build's manifest and with the tables on this page. A difference means the package
is not the one Kasseal published: do not use it.

To check that a program is the one running on chain, recompute its template hash and compare it with a live cell:

```ts
import { fromHex, templateHashOfProgram } from '@kassealhq/sdk';

// A pool cell's redeem script, from GET /pools/{P}/cell (`redeemScript`) or from the chain.
const program = fromHex(cell.redeemScript);
// The pool's state is 139 bytes at offset 1; the template hash covers the program without it.
const hash = templateHashOfProgram(program, 1, 139);
// testnet-10: must equal 28170395ca9350966c0d732ffce8b13c5a94201e74552b7add67143a35dea56a
```

## Contract sources

The contract sources are not published. The SDK ships compiled artifacts and their hashes only. Everything an
integrator needs to build, check and decode transactions is in the artifacts: the programs, their entry points and
dispatch tags, their constructor values and their state layouts. The behaviour the contracts enforce is documented in
[concepts.md](concepts.md) and [dex-and-routers.md](dex-and-routers.md).

A manifest may list a SHA-256 for a file the package does not include, such as a contract source. That entry is a
commitment: it lets anyone check a source published later against the build. It cannot be checked from the package
alone.
