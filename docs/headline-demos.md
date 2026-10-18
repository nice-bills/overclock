# The two headline demos, live on X Layer mainnet

The pitch promised two machines that cannot run on-chain directly: a 4-bit CPU running a program
for 10,000 beats, and the ~161K-gate digit-recognition net. Both now run as Overclock jobs on
X Layer mainnet through the Overclock contract already deployed there
([`0xe29FD6E3…`](https://www.oklink.com/x-layer/address/0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710),
bond 0.001 OKB, 10-minute window). In each run a cheat claimed a wrong result with one corrupted
NAND, the watcher bisected the trace to that gate and proved it wrong in one transaction (taking the
cheat's bond), and an honest operator's claim then finalized with the correct answer.

Every run was rehearsed first on a local fork of mainnet with the real TapeOut contracts
(`npm run fork`, then `npm run cpu -- --fork http://127.0.0.1:8545` or `npm run digits -- --fork …`),
then broadcast with `--live https://rpc.xlayer.tech`. Raw runs: [`web/cpu-live-run.json`](../web/cpu-live-run.json),
[`web/digits-live-run.json`](../web/digits-live-run.json), and the fork rehearsals `web/*-fork-run.json`.

## At a glance

| | 4-bit CPU, 10,000 beats | Digit net, one image |
|---|---:|---:|
| Circuit | ours, circuit #6 on OKspace, 1,437 gates, 205 state bits | AlephTape's, circuit #11 on ℵ₀, 161,080 gates |
| Direct execution through TapeOut | 3,427,781 gas per `step()` × 10,000 = **34.3B gas, 163 blocks** | `eval()` **388,354,847 gas, 1.85 blocks** (does not fit) |
| Overclock, honest path (post + claim + finalize) | **816,083 gas** (42,003× less) | **2,244,073 gas** (173× less) |
| Overclock, a whole dispute | 3,615,122 gas over 50 txs, largest 887,491 | 4,157,974 gas over 38 txs, largest 2,065,659 |
| Trace committed by the operator | 16,440,000 leaves, depth 24 | 180,640 leaves, depth 18 |
| The lie | adder's low sum bit in instruction 6,002 (leaf 9,866,498) | one NAND in the output layer: the 7 claimed as a 9 (leaf 180,562) |
| Final result, `Overclock.result()` | a = F(625) mod 256 = 161, b = F(626) mod 256 = 225 | reads the drawing as **7** |
| Matches an independent reference | yes (plain-JS emulator) | yes (our TAP-02 evaluator, which also reproduces AlephTape's ZK-proven output for their test image) |
| OKB spent from the wallet | 0.00424 (0.0041 of it TapeOut's transistor and tapeout fees) | 0.00013 (gas only; bonds and fee came back) |

The largest single transaction in either run is 4.1M gas (the CPU tapeout), 2% of a 210M block.

## 1. A 4-bit CPU running 10,000 beats

[`src/cpu4.js`](../src/cpu4.js) is a general-purpose 4-bit CPU taped out as one flat circuit:
accumulator, carry flag, 4-bit PC, an output register, 16 nibbles of RAM and a 16-byte program
memory, all in LATCHes. Because the program lives in the circuit's state, a job's starting state *is*
the program: nobody tapes out anything to run new code, they post a job. 16 instructions (`LDI`,
`LD`, `ST`, `ADD`, `ADC`, `SUB`, `ADDI`, `AND`, `XOR`, `JMP`, `JC`, `JZ`, `JNZ`, `OUT`, `HLT`, `NOP`),
one per beat.

The program is 8-bit Fibonacci on the 4-bit machine, carrying from the low nibble into the high one:

```
LD 0   ADD 2  ST 4      t.lo = a.lo + b.lo
LD 1   ADC 3  ST 5      t.hi = a.hi + b.hi + carry
LD 2   ST 0   LD 3  ST 1    a = b
LD 4   ST 2   LD 5  ST 3    b = t
OUT    JMP 0
```

10,000 beats are 625 passes, ending with a = F(625) mod 256 = 161 and b = F(626) mod 256 = 225.

Checks: the circuit matches the reference emulator on 150 random machines × 30 beats
(`test/cpu4.test.js`); TapeOut's own `step()` on mainnet agrees with our evaluator on the first 32
instructions; `circuitInfo` agrees on gates and state; a 400-beat cheat is caught end to end in the
test suite.

## 2. AlephTape's 161K-gate digit net

AlephTape (a past TapeOut hackathon winner) taped out a binarized neural net that reads an 8×8
drawing: circuit #11 on their processor ℵ₀, 161,080 gates through three layers of REFs to two neuron
circuits. A direct `eval()` does not fit in a block, which is why AlephTape built a Groth16 route for it.
Overclock runs it as is: no new tapeout, no ceremony, no recompiling. Any circuit anyone has taped
out can be posted as a job.

The drawing (`src/digits.js`, all ten hand-drawn digits are read correctly by the net):

```
·██████·
·····██·
····██··
····██··
···██···
···██···
··██····
··██····
```

Scores 46, 57, 66, 69, 51, 57, 42, **84**, 53, 58: a 7. The cheat flipped one gate so the claim read
a 9 (score 122); the watcher proved that gate wrong on-chain.

The direct `eval()` gas, 388,354,847, was measured by [`scripts/measure-eval.js`](../scripts/measure-eval.js)
on a ganache fork of mainnet with the gas limit raised to 2B (Hardhat's node runs out of memory on a
call this size); its output matched ours bit for bit. AlephTape's own figure is 396,410,201.

**Against ZK, honestly:** AlephTape's `verifyEval` settles a digit-net result for 296,826 gas, less
than Overclock's honest path (2.24M, most of it the one-time netlist walk in `postJob`). The ZK route
is the better tool for a stateless circuit someone has already run a setup ceremony for. Overclock's
case is everything else: any circuit the moment it is taped out, and stateful machines like the CPU,
which AlephTape's compiler rejects (it has no LATCH support).

## Mainnet transactions

### Digit net (job 1)

The cheat's wallet was funded by an earlier attempt of the same run that stopped on a nonce clash
before posting anything; its funding transaction is not in this table.

| Step | Gas | Transaction |
|---|---:|---|
| fund watcher wallet | 21,000 | [`0xd72c8c81…`](https://www.oklink.com/x-layer/tx/0xd72c8c813be8932af297bc4f38507b95102293a5a29f7cb6435f07df3e55700d) |
| poster: posts job 1: 1 beat of circuit #11, fee 0.0001 | 2,082,094 | [`0xe09c5980…`](https://www.oklink.com/x-layer/tx/0xe09c5980c522de487f0feefa2d770264ab79d405ac01bcbd832e80218bbf90a6) |
| cheat: claims a wrong result | 122,464 | [`0x4c74d868…`](https://www.oklink.com/x-layer/tx/0x4c74d868d71c94de7596f5d0cc91ca19c0c561a647193ee1010b737c5dd596c1) |
| watcher: challenges | 136,711 | [`0x981df02a…`](https://www.oklink.com/x-layer/tx/0x981df02aa86d5f22e6864b6da28dc34e212b7607cfa984598d2e580cf108532e) |
| cheat: reveals level 18 | 90,345 | [`0x0219c7e9…`](https://www.oklink.com/x-layer/tx/0x0219c7e9ea86ce97d65958a6eef8f225517e58592e51228f2f82bc23ab831dee) |
| watcher: picks right at level 18 | 66,745 | [`0xeea30a5d…`](https://www.oklink.com/x-layer/tx/0xeea30a5dcce9eceb6ccdb80e5704602c272939fbd4a02f983aa865e10c04c36f) |
| cheat: reveals level 17 | 56,145 | [`0x191648cf…`](https://www.oklink.com/x-layer/tx/0x191648cf9b44e07d4687f02aeaac3482ccd30596b69c1efdba2c42c5d0681906) |
| watcher: picks left at level 17 | 49,657 | [`0x1db4ff0a…`](https://www.oklink.com/x-layer/tx/0x1db4ff0ab648b9d39226b3396f01374ae7891699c8ef065f247f55a2815fe81a) |
| cheat: reveals level 16 | 56,133 | [`0x2a57a341…`](https://www.oklink.com/x-layer/tx/0x2a57a341dce7b2c28e47a5c696aca218d659ae908dff4d94c13c7b8479c2c84b) |
| watcher: picks right at level 16 | 49,645 | [`0xbd0f4ff0…`](https://www.oklink.com/x-layer/tx/0xbd0f4ff07a3ca05646063cd9d2b7633dd7c28e515b0e352cda4e029d91482456) |
| cheat: reveals level 15 | 56,145 | [`0x8c13cf7f…`](https://www.oklink.com/x-layer/tx/0x8c13cf7f615054a502a1eb02493dd0565e41b658a4cbbdaee7f065a09f0c32f3) |
| watcher: picks right at level 15 | 49,645 | [`0x5b74943e…`](https://www.oklink.com/x-layer/tx/0x5b74943ea211c1a595b0e39b91d547fc66692b7a260e65618978b98cb73fd224) |
| cheat: reveals level 14 | 56,145 | [`0x0c83a019…`](https://www.oklink.com/x-layer/tx/0x0c83a01948927fc2b0f2f140802493f4733a506811dfd992c77f498bcea7ea00) |
| watcher: picks left at level 14 | 49,657 | [`0xbc6bdbf3…`](https://www.oklink.com/x-layer/tx/0xbc6bdbf38d5329bdd09dfe6349d94f73bb3a148269cc0b3ebc38e2ed7f6f4449) |
| cheat: reveals level 13 | 56,145 | [`0x7eba852b…`](https://www.oklink.com/x-layer/tx/0x7eba852b5f19cd7e3f6a5ef80c7e05bd900a36fc35a85f8095e67f65be4dc76c) |
| watcher: picks left at level 13 | 49,657 | [`0x7e19f028…`](https://www.oklink.com/x-layer/tx/0x7e19f02892fa8e73ed2bcabd4af2dabff4ceaf065b88aa321d07740bf0295e14) |
| cheat: reveals level 12 | 56,133 | [`0xb802d406…`](https://www.oklink.com/x-layer/tx/0xb802d40658421ce81cf99a89c1a0aa7d142f40102fb49ed985e08271a96f97a8) |
| watcher: picks left at level 12 | 49,657 | [`0x0cfee570…`](https://www.oklink.com/x-layer/tx/0x0cfee570dd702b0c3a7eeac92d2172b997b4b6dfe56177f6d69289ce9926a16d) |
| cheat: reveals level 11 | 56,145 | [`0x0be5c183…`](https://www.oklink.com/x-layer/tx/0x0be5c18325273a94cf99f358de4b5c7ed7d9fae1b0adee4f276e472769749ece) |
| watcher: picks left at level 11 | 49,657 | [`0x3cd608a0…`](https://www.oklink.com/x-layer/tx/0x3cd608a0ccc987249ad3d95601f4880ad203a728d4c9a715b1bdbbe66a079400) |
| cheat: reveals level 10 | 56,145 | [`0x1af5c674…`](https://www.oklink.com/x-layer/tx/0x1af5c674f0f9866c56c520ea90d87db1b42aa18957cde549c93a600ed5ce100c) |
| watcher: picks left at level 10 | 49,657 | [`0x70ca868c…`](https://www.oklink.com/x-layer/tx/0x70ca868cf1bdfff7b3e1c04005217f21ae5b31c4fd42a4f161b87d00dcec0cf9) |
| cheat: reveals level 9 | 56,145 | [`0x740b724e…`](https://www.oklink.com/x-layer/tx/0x740b724ebc1e55e6b6700e88ee756b3bf7a5a211cfaa0b88f2b3cb6f8db6ceba) |
| watcher: picks right at level 9 | 49,645 | [`0xe8cf1553…`](https://www.oklink.com/x-layer/tx/0xe8cf155318741f82d6c5a0cc286925a601375f148deaf6fbcac4869d88a825d4) |
| cheat: reveals level 8 | 56,145 | [`0x4825936d…`](https://www.oklink.com/x-layer/tx/0x4825936da6e5dace6babd554e1f2092eba58e91f264e818a2f2f53c0da7cada4) |
| watcher: picks left at level 8 | 49,657 | [`0x9f614fdb…`](https://www.oklink.com/x-layer/tx/0x9f614fdba6239454432fe80e2f481b113500a5703f9e55ff1e1db421a6f6ea88) |
| cheat: reveals level 7 | 56,145 | [`0xcaaa1843…`](https://www.oklink.com/x-layer/tx/0xcaaa18432328908b88f4fd1d8fb55e8ea59eda767011895e26ef4a670978e6e6) |
| watcher: picks right at level 7 | 49,645 | [`0x82e4246b…`](https://www.oklink.com/x-layer/tx/0x82e4246b204afd2caba6503d5a1922056f870c6b7b17e5ba03b6866dfe431e05) |
| cheat: reveals level 6 | 56,145 | [`0x7eddf9bf…`](https://www.oklink.com/x-layer/tx/0x7eddf9bf1573ed928c14a6502b361a1136b60de59833bb7b8d1cc91259202eb1) |
| watcher: picks left at level 6 | 49,657 | [`0x1b8439da…`](https://www.oklink.com/x-layer/tx/0x1b8439da91bf676a1533cf14f67a04d1e0dfa91e355b5efc347ffb219da19285) |
| cheat: reveals level 5 | 56,145 | [`0x728e77fd…`](https://www.oklink.com/x-layer/tx/0x728e77fd69bea905fe1c147eb5b1091bfd3e05940f3ce351fed9005983cc4336) |
| watcher: picks right at level 5 | 49,645 | [`0x1fc0b82e…`](https://www.oklink.com/x-layer/tx/0x1fc0b82e4b04c0ac05b2ee780fbbaf32ae9da712348c829be80b8bda6bb6483b) |
| cheat: reveals level 4 | 56,133 | [`0xe96444e4…`](https://www.oklink.com/x-layer/tx/0xe96444e461003a774e4c1be802d6a81c56610f65d98fc382172629db4b5c9ca2) |
| watcher: picks left at level 4 | 49,657 | [`0x61873875…`](https://www.oklink.com/x-layer/tx/0x6187387599d6982ba1a780c22b8a85027b666e0b8b3b8826e768c5d907e3d1d9) |
| cheat: reveals level 3 | 56,145 | [`0x337aae8f…`](https://www.oklink.com/x-layer/tx/0x337aae8f1d389dd3f01db31e6baf2e4fd334f69fcc076c7152943ff8d34c6f42) |
| watcher: picks left at level 3 | 49,657 | [`0x2227a004…`](https://www.oklink.com/x-layer/tx/0x2227a00498383d78724b280b427c7d1fc9fa9eed650e9c6259c963d8bea069e7) |
| cheat: reveals level 2 | 56,145 | [`0x20022244…`](https://www.oklink.com/x-layer/tx/0x20022244e0b614400f6e1aee374c0535f0b79f652035d89f9d88ab9372497328) |
| watcher: picks right at level 2 | 49,645 | [`0xf1643d4c…`](https://www.oklink.com/x-layer/tx/0xf1643d4c928ae50796b2f6728ff7645d4757607c180d4912d297e777ec187359) |
| cheat: reveals level 1 | 56,145 | [`0xfd50bf0a…`](https://www.oklink.com/x-layer/tx/0xfd50bf0ad89ad0ae0fa5077f7e9ce2c9e2cc082219808b02f9b41872caace137) |
| watcher: picks left at level 1 | 49,645 | [`0x9ff15e31…`](https://www.oklink.com/x-layer/tx/0x9ff15e3188f3f9921a22b37c02069020e1c65218d40d7f031d684695204fa7d3) |
| watcher: proves the wrong step | 2,065,659 | [`0x010a2a35…`](https://www.oklink.com/x-layer/tx/0x010a2a356747492df112b843c766111a806e454680a6f542eb529d0a963c9a3b) |
| operator: claims the result | 105,340 | [`0x32b5deb5…`](https://www.oklink.com/x-layer/tx/0x32b5deb5500ebd8f8e27eac622196f6364c9e5c2cebc1bd098640dd2d1e65515) |
| operator: finalizes | 56,639 | [`0xcf992d6a…`](https://www.oklink.com/x-layer/tx/0xcf992d6a5af2c575b2efa5c205bcae232413121a6e1ecc02230025a2d4021848) |

### 4-bit CPU (job 2)

| Step | Gas | Transaction |
|---|---:|---|
| fund cheat wallet | 21,000 | [`0xe57115eb…`](https://www.oklink.com/x-layer/tx/0xe57115eb186ee5cef4ea2107383a1e28fef81e961dd43fc002db7e459ffffb75) |
| fund watcher wallet | 21,000 | [`0x02ea6460…`](https://www.oklink.com/x-layer/tx/0x02ea64600fa5396f2b6c95246d431a755e2f2d529c828debb8a0ebc42eb8d45e) |
| mint 1232 NAND | 86,411 | [`0x73374107…`](https://www.oklink.com/x-layer/tx/0x73374107ce939df6d27758b493270674f249659764c360a300779953da97d5ca) |
| mint 205 LATCH | 86,434 | [`0xac32d522…`](https://www.oklink.com/x-layer/tx/0xac32d52237217dd2e7921d870f7ab387ee74057ffc176a30a4abf85d0eb38e88) |
| tapeout the 4-bit CPU as circuit #6 | 4,078,400 | [`0xa3197a73…`](https://www.oklink.com/x-layer/tx/0xa3197a7345a7b3755ebacceda306032494500a59e2356b6bd32600c159882a0b) |
| poster: posts job 2: 10,000 beats of circuit #6, fee 0.00001 | 633,856 | [`0xe430e823…`](https://www.oklink.com/x-layer/tx/0xe430e82304ce56a89dedb7331713a7385f6dc2ee3b6485cfd1456368977c694d) |
| cheat: claims a wrong result | 142,688 | [`0x954ffb97…`](https://www.oklink.com/x-layer/tx/0x954ffb9796c91b131b4f091a2d82e07975e585aab3829b7544279c218fe8dab7) |
| watcher: challenges | 137,287 | [`0x6a0965c7…`](https://www.oklink.com/x-layer/tx/0x6a0965c7f5bb63301eb4daff09936fa99f1c014a20add9507b8f4f6dbec15669) |
| cheat: reveals level 24 | 90,333 | [`0xaf6dbba3…`](https://www.oklink.com/x-layer/tx/0xaf6dbba3fd44c083e4b8dc987cc03380fde1aeac2c1b318d5af5fb66dd390715) |
| watcher: picks right at level 24 | 66,745 | [`0xc721b7f8…`](https://www.oklink.com/x-layer/tx/0xc721b7f83cc198446c17a59e8cb98e41fbc2746b2cb98379de3154eb9ccf950e) |
| cheat: reveals level 23 | 56,145 | [`0xfcac3677…`](https://www.oklink.com/x-layer/tx/0xfcac367711aa913feb9c4619063b94b6a79def8cf374c562739d7560f643ae18) |
| watcher: picks left at level 23 | 49,657 | [`0x4cc34ca6…`](https://www.oklink.com/x-layer/tx/0x4cc34ca6defafcf087a77662d606d3e7afd61b32308f538146b8eab8949ceb9a) |
| cheat: reveals level 22 | 56,121 | [`0x71433abe…`](https://www.oklink.com/x-layer/tx/0x71433abe0ea3fc47d5d9506cea2ef604c326c1e12c0da277adc81cda33329d1b) |
| watcher: picks left at level 22 | 49,657 | [`0x391a2bb1…`](https://www.oklink.com/x-layer/tx/0x391a2bb178d67f54f19b5b66e8d660112c8575007ae4b48341ec6ea476465f01) |
| cheat: reveals level 21 | 56,145 | [`0xdc08adaf…`](https://www.oklink.com/x-layer/tx/0xdc08adaf50e2e03d8d3416cc7f27a6f8eabf6324f51047031e18134e84f1454a) |
| watcher: picks right at level 21 | 49,645 | [`0x50c92a99…`](https://www.oklink.com/x-layer/tx/0x50c92a99709892592668d82d617d982fae87811c5e2573f807e9bf93f0cd020d) |
| cheat: reveals level 20 | 56,133 | [`0x98aaa9cd…`](https://www.oklink.com/x-layer/tx/0x98aaa9cd7fbfe6372af96f877f793dfd86ae3e2902ba8168e3fccfde39249358) |
| watcher: picks left at level 20 | 49,657 | [`0xc9ff4998…`](https://www.oklink.com/x-layer/tx/0xc9ff499816dd05ccc5c915482d66c2eab243ca2afd07bbc549ef23a070129a99) |
| cheat: reveals level 19 | 56,145 | [`0xda89eb3a…`](https://www.oklink.com/x-layer/tx/0xda89eb3a5d9e0380e378c1bf3c1d9b5e0e41475ce2a47c9fc9c851db84570202) |
| watcher: picks right at level 19 | 49,645 | [`0xc934ab77…`](https://www.oklink.com/x-layer/tx/0xc934ab7755010536f0555e9b6908cc97d30f00cc36fb8ef829a97fa456fe6291) |
| cheat: reveals level 18 | 56,145 | [`0x4159c118…`](https://www.oklink.com/x-layer/tx/0x4159c118b2bb9829721a59732e707d98b679260d927b047096d60688ae0e3f00) |
| watcher: picks right at level 18 | 49,645 | [`0xb35de260…`](https://www.oklink.com/x-layer/tx/0xb35de260752fea38a06ac18718a4e3b6a7a9979eb03fc2ee8056989fff915236) |
| cheat: reveals level 17 | 56,145 | [`0xb6006b2f…`](https://www.oklink.com/x-layer/tx/0xb6006b2f01af88d9c78b05b2fa759131a76d7f1bb6be99c5ab381d9405e6791b) |
| watcher: picks left at level 17 | 49,657 | [`0xb6e9a9e3…`](https://www.oklink.com/x-layer/tx/0xb6e9a9e30cdd24a64c3f2eea235e6a743012c2e7152884ecda2a8c159c520463) |
| cheat: reveals level 16 | 56,145 | [`0xeec41702…`](https://www.oklink.com/x-layer/tx/0xeec417021499555269b2a73059de251e5ffb0db3ecc5153e381b6643c5eab522) |
| watcher: picks right at level 16 | 49,645 | [`0x89d89650…`](https://www.oklink.com/x-layer/tx/0x89d89650877a12fea804a680239a562543407e87f8f2670ed5d90a9fab47a15d) |
| cheat: reveals level 15 | 56,145 | [`0xb386aa47…`](https://www.oklink.com/x-layer/tx/0xb386aa47042dcd6d296e1c53df113f0ccb8e50f0723a00f21bf6e39b8202f854) |
| watcher: picks left at level 15 | 49,657 | [`0xb303be9b…`](https://www.oklink.com/x-layer/tx/0xb303be9b7c1916f33962cf59b9aaf5f5fc4a18c8999c1b24b518ca09ca835734) |
| cheat: reveals level 14 | 56,145 | [`0x7fedf76c…`](https://www.oklink.com/x-layer/tx/0x7fedf76c1a700625a03c99b782bb9f0506f716a28b86c96de2f31eb603d05dd7) |
| watcher: picks left at level 14 | 49,657 | [`0x66734a6b…`](https://www.oklink.com/x-layer/tx/0x66734a6b6806c690bd2f201e7555aeee69f1849932cf7e2cfa03d457063f1270) |
| cheat: reveals level 13 | 56,133 | [`0x1b50f5d1…`](https://www.oklink.com/x-layer/tx/0x1b50f5d1e4ae09a641874ee51548db99601db1340296232172dae48019e95f5f) |
| watcher: picks left at level 13 | 49,657 | [`0x3bdce5a4…`](https://www.oklink.com/x-layer/tx/0x3bdce5a4b2d5f6fb90de0f629778bd5471bb9c021f047df068121d104b55a1dd) |
| cheat: reveals level 12 | 56,145 | [`0xa33cc069…`](https://www.oklink.com/x-layer/tx/0xa33cc0691d1e960c5f343ea37ef102794a954c9eb84305aecfc7a636a5805628) |
| watcher: picks right at level 12 | 49,645 | [`0x33e24a8c…`](https://www.oklink.com/x-layer/tx/0x33e24a8c8bfbf50ec83146a675f9f87561221705a0dcad2caa441b81a5840866) |
| cheat: reveals level 11 | 56,145 | [`0x51f050bc…`](https://www.oklink.com/x-layer/tx/0x51f050bcaf49a20b6ed81a3211981c9d13dfbcbff3ddaf4ff2bc1327712a04ad) |
| watcher: picks right at level 11 | 49,645 | [`0x871535f6…`](https://www.oklink.com/x-layer/tx/0x871535f67f593c5026cd17994f8baebb75da0be4b07cb45752dcbfd1d0855bc9) |
| cheat: reveals level 10 | 56,145 | [`0xa9a2c95a…`](https://www.oklink.com/x-layer/tx/0xa9a2c95ad8ef132ffe51619d7b1806663b3577c353bef9f6c7240011bbcae34a) |
| watcher: picks left at level 10 | 49,657 | [`0x6453de4b…`](https://www.oklink.com/x-layer/tx/0x6453de4bf57ec335d4008dc739ad673417884fa5efa63114b699aa1bbe996dc9) |
| cheat: reveals level 9 | 56,145 | [`0xe9135318…`](https://www.oklink.com/x-layer/tx/0xe9135318a86eb78df4d3d2c4db149c0e9ff00321ab8ea2592626dedf456a068b) |
| watcher: picks right at level 9 | 49,645 | [`0x153f8fc7…`](https://www.oklink.com/x-layer/tx/0x153f8fc7b6386c508d0e991c81924a6244f98dac202928e5ea52cde25f8d2fad) |
| cheat: reveals level 8 | 56,145 | [`0x549fb39c…`](https://www.oklink.com/x-layer/tx/0x549fb39cf2860eb3f7a7eceb3f4300e84b1d8fa21a9b277fbeb40e466dc08826) |
| watcher: picks left at level 8 | 49,657 | [`0x657719ee…`](https://www.oklink.com/x-layer/tx/0x657719eed0dfe208ad9fffbd10cef287d908a346fbb5ebf3e1eaca30ed0804c2) |
| cheat: reveals level 7 | 56,145 | [`0x24f77ce3…`](https://www.oklink.com/x-layer/tx/0x24f77ce3259d3c4bbc14ac2aac39ae5dba05cc57d70fc84e67086b689a4b4bb4) |
| watcher: picks left at level 7 | 49,657 | [`0xd83ed5be…`](https://www.oklink.com/x-layer/tx/0xd83ed5be8dbe45f63b92e3e001523b2cf9cdba9f9cbbce77f0479b90aec955d1) |
| cheat: reveals level 6 | 56,145 | [`0x72569940…`](https://www.oklink.com/x-layer/tx/0x725699402a54d4b969ebca0ce409088768ace2b38f500f16591774f8bef250b3) |
| watcher: picks left at level 6 | 49,657 | [`0x75748d18…`](https://www.oklink.com/x-layer/tx/0x75748d18a31b83d4d2c11c3be329421c2af4587f3753b1d99c8850c813648f7d) |
| cheat: reveals level 5 | 56,145 | [`0x1ae2efc7…`](https://www.oklink.com/x-layer/tx/0x1ae2efc7c62fc5974475be1a45d159b486ad92b99756c1d78a1ff0db954c72b8) |
| watcher: picks left at level 5 | 49,657 | [`0xe8232ca1…`](https://www.oklink.com/x-layer/tx/0xe8232ca1e477ff9f7caa4cb7ac4c1d832ee10a9e702df6b92c177e3517af28f8) |
| cheat: reveals level 4 | 56,145 | [`0x6a9e44e2…`](https://www.oklink.com/x-layer/tx/0x6a9e44e28e99d9699f2d18d6d9d73405a13a0139b6880f240e67432133e09067) |
| watcher: picks left at level 4 | 49,657 | [`0x69a2b11c…`](https://www.oklink.com/x-layer/tx/0x69a2b11cf962996320d783e83569e429a0d8868c1109f242dfd5493b758813fe) |
| cheat: reveals level 3 | 56,145 | [`0xe02adc00…`](https://www.oklink.com/x-layer/tx/0xe02adc00fac0be7469a1a79f238c27ef039a12890e5d11a014069b046978ae6b) |
| watcher: picks left at level 3 | 49,657 | [`0xee478fa8…`](https://www.oklink.com/x-layer/tx/0xee478fa8a52143ab53fdad55d587dd61367aac9b50f56dac24aed32bb6df205d) |
| cheat: reveals level 2 | 56,121 | [`0xb5e064f7…`](https://www.oklink.com/x-layer/tx/0xb5e064f7a275dab5e99d355a8d301e3a096c0f758c4ea35bb96cb485cb93712b) |
| watcher: picks right at level 2 | 49,645 | [`0x863d40f8…`](https://www.oklink.com/x-layer/tx/0x863d40f851484d2966b801d9d30b2eff947a95e19b53bb782a3ac208412c3d89) |
| cheat: reveals level 1 | 56,145 | [`0x6ecbcc19…`](https://www.oklink.com/x-layer/tx/0x6ecbcc19cb5ab882dea8302e46394cd007792e4184e2bd558ba3d37f7346a984) |
| watcher: picks left at level 1 | 49,645 | [`0x5653a6a1…`](https://www.oklink.com/x-layer/tx/0x5653a6a10c92cf674adc7975d652b048d3c63a1d1e4e6acc6bbb946227f2ac1a) |
| watcher: proves the wrong step | 887,491 | [`0x3e14144d…`](https://www.oklink.com/x-layer/tx/0x3e14144d80a5322b228ab39f2b6b47cf90148f49186cd6bf2dcd6ba048f74937) |
| operator: claims the result | 125,588 | [`0x437b3c48…`](https://www.oklink.com/x-layer/tx/0x437b3c4861d683038620812a272dad96e4ed9c1e7bbe270e507033d1de421015) |
| operator: finalizes | 56,639 | [`0xf9e3738e…`](https://www.oklink.com/x-layer/tx/0xf9e3738e5cc9ce905197526b755579d2da0d416b6ba07d5cdbe0a717bfd2ea6d) |

## Reproduce

```
npm install
npm run fork                                           # terminal 1: fork of X Layer mainnet
npm run cpu    -- --fork http://127.0.0.1:8545         # terminal 2
npm run digits -- --fork http://127.0.0.1:8545
PRIVATE_KEY=0x... npm run cpu -- --live https://rpc.xlayer.tech --fee 0.00001
```

On a fork the CPU run takes about two minutes, mostly committing the 16.4M-leaf trace three times
(cheat, watcher, operator; about 27 s each).
