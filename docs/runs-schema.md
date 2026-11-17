# `web/runs.json`: the runner's index

The site reads one file to know what has been run and what has been certified. The B3 runner
writes it; the site only reads it. [`web/runs.json`](../web/runs.json) in this repository is the seed:
the three mainnet jobs we ran by hand (`web/live-run.json`, `web/digits-live-run.json`,
`web/cpu-live-run.json`) plus the certificates and local runs issued by `scripts/certify.js`.

How the site uses it:

- `scripts/build-web.js` inlines the file into `web/overclock.html`, so the page works from disk and from
  any static host with no extra request.
- When the page is served over HTTP it also fetches `runs.json` (relative to the page, or the URL in
  `<meta name="runs-url">`) and uses that copy if it parses and has `schema: 1`. Publish a fresh file next
  to the page and the counters, the Floor and every circuit page update on the next load, with no rebuild.
- A circuit with no entry here is **queued**: nothing has run it yet. The site never invents a run.

## Shape

```jsonc
{
  "schema": 1,                    // required; the site ignores a file with any other value
  "updatedAt": "2026-11-17",      // ISO date or timestamp the runner last wrote the file
  "note": "free text, optional",
  "networks": {                   // optional; chain id → explorer used for transaction links
    "196": { "name": "X Layer", "explorer": "https://www.oklink.com/x-layer", "overclock": "0xe29F…E710" }
  },
  "runs": [ /* Run */ ],
  "certificates": [ /* Certificate */ ]
}
```

### Run

One finalized or in-flight Overclock job.

| Field | Type | Notes |
|---|---|---|
| `id` | string | `"<chainId>:<jobId>"`, unique |
| `chainId` | number | `196` mainnet, `1952` testnet |
| `overclock` | address | The Overclock contract that holds the job |
| `jobId` | number | |
| `circuit` | object | `{ processor, id, name?, gates?, nIn?, nOut?, nState?, owner? }`. `processor` and `id` are required and key the run to its circuit page. The rest is used only when the circuit is not in `docs/census.json` (the census wins otherwise) |
| `what` | string | One line: what ran |
| `beats` | number | Beats the job asks for |
| `steps` | number | Leaves in the trace the operator committed to: the steps the contract could re-check. Summed for the "steps settled" counter, final runs only |
| `status` | string | `posted`, `claimed`, `challenged` or `final`. The site shows the first three as **running** |
| `fee`, `bond` | string | OKB, as decimal strings |
| `directGas` | number | Gas to run the same job straight through TapeOut (`gates × beats × 2,400`, or a measured figure). Optional |
| `gas` | object | `{ post, claim, finalize, honestPath, dispute? }`. `honestPath` is post + claim + finalize |
| `disputes`, `disputeTxs` | number | How many claims on this job were challenged, and the transactions the dispute took. Optional |
| `outcome` | string | One sentence for the circuit page. Optional |
| `txs` | array | `{ what, tx, gas? }`: transactions worth showing, linked to the explorer of `chainId` |
| `postedAt`, `finalizedAt` | string | ISO timestamps. Optional |
| `source` | string | Where the record came from. Optional |

### Certificate

A finalized job whose result says a design matches its reference on its entire input space.

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique |
| `circuit` | object | The design that was checked, as in a Run |
| `reference` | object or null | `{ processor, id, name? }` the design was checked against, or `null` for a spec the bench encodes |
| `runId` | string | The `Run.id` of the job that settled the check |
| `inputs` | number | Inputs checked (`2^n`) |
| `mismatches` | number | `0` means certified |
| `firstFailingInput` | string | Hex, only when `mismatches > 0` |
| `status` | string | `certified` (a final run with `mismatches === 0`) or `failed` |
| `issuedAt` | string | ISO timestamp. Optional |
| `txs` | array | As in a Run |

A circuit counts as **certified** when it has a certificate with `status: "certified"`. A shape-level
certificate (the same bytecode on hundreds of circuits) lists the circuits it covers in
`covers: [{ processor, id }]`; each of them is certified too.

### Certificates from `scripts/certify.js`

[`scripts/certify.js`](../scripts/certify.js) issues certificates for FabX miners by replaying a
Gate Challenge's published vectors and settling a bench against the challenge's official reference.
It writes the same `Certificate` record above to [`web/runs.json`](../web/runs.json) and a full
document to `docs/certificates/<processor>-<id>.json`. The index entry keeps the site fields and
adds:

| Field | Type | Notes |
|---|---|---|
| `certificate` | string | File name under `docs/certificates/`, e.g. `0x87bf…f9a6-2346.json` |
| `coverage` | string | What the settled job covered, e.g. `all 256 inputs (0..255)` or `1 official vector (5 frames from reset)` |
| `covers` | array | Every circuit with the same challenge and byte-identical netlist, as in a shape certificate |
| `caveat` | string | Optional. Set when the published reference is degenerate, e.g. constant zero |

The full certificate document also records `chain: { source, settlement }` (the challenge is read
from mainnet `196`; the job settles on the local certifier chain `31337`), the design and reference
netlist fingerprints, `officialVectors` counts and the exact `firstFailure` (`index`, `cycle`,
`input`, `expected`, `got`), and the mirror ids and gas of the settling job. A `failed` certificate
keeps `firstFailingInput` as the exact published vector input, so the same miner always reports the
same first failure. Certifier Runs use `source: "scripts/certify.js"` and `status: "final"`; their
`chainId` is the settlement chain, so treat `31337` as a local run.

## What the site derives

| Shown | Rule |
|---|---|
| Machines run | Distinct circuits with a `final` run |
| Certificates issued | Certificates with `status: "certified"` |
| Steps settled | Sum of `steps` over `final` runs |
| Circuit status | `certified` > `final` > `running` (`posted`, `claimed`, `challenged`) > `queued` (no run) |

Circuits are keyed by `lowercase(processor) + ":" + id`.
