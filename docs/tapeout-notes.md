# TapeOut on X Layer: what Overclock relies on

Facts below come from the integration notes the Cerebr team verified on a fork of X Layer mainnet
([NetLayerLabs/Cerebr, TAPEOUT.md](https://github.com/NetLayerLabs/Cerebr/blob/main/TAPEOUT.md)). Our
fork rehearsal (`npm run fork`, then `npm run demo:fork`) re-checks the parts Overclock depends on.

| What | Address (chain 196) |
|---|---|
| Factory (proxy) | `0x1f09daefa827f02cbb40967cc91b259763760761` |
| Opener (circuit accounts) | `0x536add8f30f03b69f6fbf29d425a816a0dc50106` |

- **No testnet deployment.** TapeOut's client only configures chain 196 (X Layer) and 56 (BNB Chain), and
  teams test on a mainnet fork. So does Overclock.
- **Processor:** `factory.createCPU(name, symbol, story, supply, mintPrice)` with `deployFee()` (0.0066 OKB).
  `isCPU(circuits)` is keyed by the circuits address. Overclock refuses jobs on anything else, because a
  dispute re-reads the netlist and relies on TapeOut never changing it.
- **Transistors:** ERC-1155, NAND = 0, LATCH = 1. `mint(id, amount)` costs `amount*mintPrice + protocolFee`.
- **Tapeout:** `circuits.tapeout(nl, nIn, nOut)` with exactly `TAPEOUT_FEE()` (0.0013 OKB). It burns one
  transistor per NAND and LATCH record; REFs are free. Ids start at 1 and `nextId()` is the last id.
- **Reads:** `netlist(id)` returns the bytes as submitted. `circuitInfo(id)` returns gateCount and nState
  flattened through REFs. `eval` is for combinational circuits; `step(id, state, inputs)` for stateful ones.
  Bits are packed LSB-first. `step` costs about 50K + 2.5K gas per flattened gate, and the block gas limit
  is 210M, so one call tops out at roughly 80,000 gates.
- **Netlist rules:** NAND and REF inputs must point backwards; LATCH `d` may point forward; outputs are the
  last nOut signals; a REF target must be a registered processor with matching pin counts.
- **Circuit accounts:** `opener.open(circuits, id)` (0.08 OKB) creates the circuit's ERC-6551 account;
  its owner is the circuit NFT's owner, and `execute(to, value, data, 0)` costs 0.0013 OKB per call.
  The demo uses this so the board circuit's own account pays for the next run.
