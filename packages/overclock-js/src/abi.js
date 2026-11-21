// The slice of the Overclock ABI this library calls (contracts/Overclock.sol, v2).
// test/overclock-js.test.js checks every line against the compiled contract.
export const OVERCLOCK_ABI = [
  'function postJob(address cpu, uint256 id, bytes inputs, bytes state, uint32 beats, bool perBeat) payable returns (uint256 jobId)',
  'function jobs(uint256) view returns (address cpu, uint256 id, bytes inputs, bytes state, uint256 fee, uint32 beats, bool perBeat, uint32 nIn, uint32 nOut, uint64 nState, uint64 flat, address poster, uint256 parent, address claimant, bytes32 traceRoot, bytes outputs, bytes newState, uint64 claimedAt, uint32 openGames, bool finalized)',
  'function jobCount() view returns (uint256)',
  'function bondFor(uint256 jobId) view returns (uint256)',
  'function bond() view returns (uint256)',
  'function window() view returns (uint256)',
  'function finalize(uint256 jobId)',
  'function result(uint256 jobId) view returns (bytes outputs, bytes newState)',
  'event JobPosted(uint256 indexed jobId, address cpu, uint256 id, uint32 beats)',
  'event Finalized(uint256 indexed jobId, bytes outputs)',
];
