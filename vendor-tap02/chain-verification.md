# Netlist format verification against BNB Smart Chain

**Status: complete**

**Measured** with a read-only JSON-RPC script (no transactions; script not published) on bsc at block 124675668 (re-pinned to 124675796 after the node pruned its state), RPC `https://bsc-dataseed.bnbchain.org`. Candidate signatures: `eval(uint256,bytes)`, `step(uint256,bytes,bytes)`. Transactions sent: 0.

- project contracts: {"factory": {"addresses": 1169, "block": 124675668, "cpuCount": 1169, "factory": "0x68224f668083c29e9800be2a646d42d18cedf7e2", "missing_indices": []}}
- circuits: 24 (with LATCH 4, with REF 4); all checks pass: 24
- round trip: 24/24; gateCount = top-level NAND+LATCH: 20, = including REF sub-totals: 24
- step vectors matching: 384/384; eval (local state = 0) matching: 288

| cpu | id | nIn | nOut | nState | gateCount | kinds | round trip | nState ok | gateCount | eval | step |
|---|---:|---:|---:|---:|---:|---|:--:|:--:|---|---|---|
| `0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c` | 920 | 0 | 1 | 7 | 9 | Latch, Nand | yes | yes | top-level | n/a (reverts: "has latch: use step") | 16/16 |
| `0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c` | 1066 | 0 | 4 | 8 | 20 | Latch, Nand | yes | yes | top-level | n/a (reverts: "has latch: use step") | 16/16 |
| `0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c` | 1189 | 0 | 8 | 9 | 10 | Latch, Nand | yes | yes | top-level | n/a (reverts: "has latch: use step") | 16/16 |
| `0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c` | 1298 | 1 | 1 | 1 | 2 | Latch, Nand | yes | yes | top-level | n/a (reverts: "has latch: use step") | 16/16 |
| `0x50a994e71615474b55559ff4f500928fbc339dd9` | 6534 | 1 | 1 | 0 | 1 | Ref | yes | yes | with REFs | 16/16 | 16/16 |
| `0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c` | 38 | 8 | 16 | 0 | 1204 | Ref | yes | yes | with REFs | 16/16 | 16/16 |
| `0xc1ae0d87cde4f93bcae38c6d62a269c76d5d3215` | 106 | 0 | 1 | 1 | 2 | Ref | yes | yes | with REFs | n/a (reverts: "has latch: use step") | 16/16 |
| `0xc1ae0d87cde4f93bcae38c6d62a269c76d5d3215` | 109 | 0 | 1 | 1 | 2 | Ref | yes | yes | with REFs | n/a (reverts: "has latch: use step") | 16/16 |
| `0x50a994e71615474b55559ff4f500928fbc339dd9` | 1952 | 1 | 1 | 0 | 1 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0x50a994e71615474b55559ff4f500928fbc339dd9` | 4707 | 2 | 1 | 0 | 1 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c` | 819 | 16 | 8 | 0 | 72 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c` | 938 | 8 | 3 | 0 | 22 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c` | 584 | 17 | 9 | 0 | 140 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c` | 1029 | 32 | 17 | 0 | 140 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0x0572fa34303bb26dfe106d5c57c5bec153ec0849` | 1 | 17 | 9 | 0 | 140 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0x54840f62c9d6cf322a3972a6be0be16e76077cc0` | 1 | 16 | 16 | 0 | 1204 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0xd3c3a93ca6cacc50b303cac1e51580cd95632509` | 3 | 16 | 16 | 0 | 1204 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0x50a994e71615474b55559ff4f500928fbc339dd9` | 42 | 2 | 1 | 0 | 3 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0x50a994e71615474b55559ff4f500928fbc339dd9` | 189 | 2 | 1 | 0 | 3 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0x50a994e71615474b55559ff4f500928fbc339dd9` | 406 | 2 | 1 | 0 | 3 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0x50a994e71615474b55559ff4f500928fbc339dd9` | 1251 | 2 | 1 | 0 | 3 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0x50a994e71615474b55559ff4f500928fbc339dd9` | 1323 | 2 | 1 | 0 | 3 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0x50a994e71615474b55559ff4f500928fbc339dd9` | 1470 | 2 | 1 | 0 | 3 | Nand | yes | yes | top-level | 16/16 | 16/16 |
| `0x50a994e71615474b55559ff4f500928fbc339dd9` | 1486 | 2 | 1 | 0 | 3 | Nand | yes | yes | top-level | 16/16 | 16/16 |
