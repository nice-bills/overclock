# World is not launched

`World.sol` (Overclock World: Red vs Blue) is **not deployed on any network and is not part of the
Overclock product or its submission**. It was cut from the product on 16 Nov 2026 (see section 9 of
[PLAN.md](../PLAN.md)): a game dilutes the claim that Overclock runs other people's machines and proves
their designs.

The code stays in the repository, with its tests and `scripts/rehearse-world.js`, as a worked example of
a contract that posts Overclock jobs from a TapeOut circuit's own ERC-6551 container. It is not covered by
[docs/security-audit.md](../docs/security-audit.md), and one known issue is left open: the final epoch of
a season can be sniped (PLAN.md, section 2).

Nothing in the README or the write-ups points at it. The MCP server only offers `world_*` tools, and
the operator only starts a keeper, when a network's `deployments/<chainId>.json` has a `world` entry. No
deployment file has one, and none should get one.
