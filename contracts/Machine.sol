// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOverclockReceiver} from "./Overclock.sol";

interface IOverclock {
    function continueJob(uint256 parentJobId, bytes calldata inputs, uint32 beats, bool perBeat) external payable returns (uint256);
    function result(uint256 jobId) external view returns (bytes memory outputs, bytes memory newState);
}

/// A stateful TapeOut circuit that keeps running on-chain, one Overclock job at a time. Anyone can
/// pay to advance it; each finalized result moves the head forward, and other contracts can read
/// the machine's current state and beat count without trusting anyone.
contract Machine is IOverclockReceiver {
    IOverclock public immutable overclock;
    uint256 public head; // last finalized job
    uint256 public beats; // beats run since the head of the first job
    bytes public state;
    struct Request {
        uint256 parent;
        uint32 n;
    }

    mapping(uint256 => Request) public pending; // jobId -> what it continues and for how many beats

    event Advanced(uint256 indexed jobId, uint256 beats);

    /// Start from an already finalized job.
    constructor(IOverclock oc, uint256 startJob, uint256 startBeats) {
        overclock = oc;
        head = startJob;
        beats = startBeats;
        (, state) = oc.result(startJob);
    }

    /// Ask for `n` more beats from the current head. msg.value is the job fee.
    function advance(uint32 n) external payable returns (uint256 jobId) {
        jobId = overclock.continueJob{value: msg.value}(head, "", n, false);
        pending[jobId] = Request(head, n);
    }

    function onOverclockResult(uint256 jobId, bytes calldata, bytes calldata newState) external {
        require(msg.sender == address(overclock), "only overclock");
        _apply(jobId, newState);
    }

    /// Fallback if the callback ran out of gas: anyone can apply a finalized result.
    function sync(uint256 jobId) external {
        (, bytes memory newState) = overclock.result(jobId);
        _apply(jobId, newState);
    }

    function _apply(uint256 jobId, bytes memory newState) internal {
        Request memory r = pending[jobId];
        delete pending[jobId];
        // two advances from the same head can both finalize: only a continuation of the current head moves it
        if (r.n == 0 || r.parent != head) return;
        (head, beats, state) = (jobId, beats + r.n, newState);
        emit Advanced(jobId, beats);
    }
}
