# Launch thread draft

For X. Seven posts, each under 280 characters. Attach the film to post 1 and the resolveLeaf OKLink
screenshot to post 4. Tag @XLayerOfficial and TapeOut's account (check the handle) in the last post only.

**1/**
This Game of Life board is 3,712 NAND gates, taped out on TapeOut.

Running 40 generations on-chain costs 441M gas. That's more than two X Layer blocks, so it can't run.

We ran it on X Layer mainnet for 182K gas. Here's how 🧵

**2/**
Overclock is optimistic execution for TapeOut circuits.

An operator runs the job off-chain and claims the result with a bond. Anyone can re-run it for free. If it's wrong, they can prove it.

**3/**
To test it, we sent a cheat.

It flipped one NAND gate, in generation 25: one step out of 181,840.

A watcher re-ran the job, saw a different result, and bisected the trace in 18 rounds, down to that single gate.

**4/**
Then the contract checked one gate. It read the netlist from TapeOut, took the inputs from Merkle proofs, and computed one NAND.

347,509 gas. The cheat lost its bond to the watcher.

https://www.oklink.com/x-layer/tx/0xa4fbe532791e6220310618304ce7f4f908a80411a887986984e0c7819a2a0bff

**5/**
Why only TapeOut makes this possible: a fraud proof needs one step a contract can re-run.

For the EVM, that took rollups years. A TapeOut circuit is NAND gates with exact, fixed semantics, so one gate is the step. LATCH state works too, which ZK can't do yet.

**6/**
Every circuit ever taped out can now run at any size, with no ceremony and no recompiling.

Machine builders pay per job, operators and watchers earn fees and bonds, and AI agents get it through an MCP server and a Claude Code plugin.

**7/**
Live on X Layer mainnet, every transaction public, all open source:

github.com/nice-bills/overclock

Built for TapeOut Accelerate. @XLayerOfficial

## Short version (one post)

A 3,712-gate TapeOut circuit, 40 generations: 441M gas on-chain, over two blocks.

Overclock ran it on X Layer mainnet for 182K. When a cheat flipped 1 gate out of 181,840, a watcher caught it and the contract checked that one NAND.

github.com/nice-bills/overclock
