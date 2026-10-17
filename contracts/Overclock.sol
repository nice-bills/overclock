// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// TAP-02 processor contract, read-only part.
interface ICircuits {
    function netlist(uint256 id) external view returns (bytes memory);
    function circuitInfo(uint256 id) external view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount);
}

/// TapeOut factory: only circuits of its registered processors are accepted, because a dispute
/// re-reads the netlist and relies on TapeOut never changing it.
interface ITapeOutFactory {
    function isCPU(address circuits) external view returns (bool);
}

/// Optional: a contract that posts jobs can receive each result as it finalizes.
interface IOverclockReceiver {
    function onOverclockResult(uint256 jobId, bytes calldata outputs, bytes calldata newState) external;
}

/// Optimistic execution of TapeOut circuits.
///
/// An operator runs a job (any number of beats of a circuit) off-chain and claims the last
/// beat's outputs and the final state, committing a Merkle root over the execution-order trace
/// (see src/trace.js for the layout). Anyone who disagrees challenges; the two bisect the trace
/// tree down to the first leaf they disagree on, and the contract re-checks that one step: a
/// single NAND, LATCH read, LATCH write, REF wire or input.
contract Overclock {
    uint8 internal constant NAND = 0x00;
    uint8 internal constant LATCH = 0x01;
    uint8 internal constant REF = 0x02;

    bytes32 internal constant LEAF0 = keccak256(hex"00");
    bytes32 internal constant LEAF1 = keccak256(hex"01");
    bytes32 internal constant PAD = bytes32(0);

    uint256 public immutable bond;
    uint256 public immutable window;
    ITapeOutFactory public immutable factory; // zero only in tests: then any processor is accepted
    address public immutable treasury;
    uint256 public immutable feeBps; // protocol share of each job fee
    uint256 public constant CALLBACK_GAS = 300_000;

    struct Job {
        address cpu;
        uint256 id;
        bytes inputs; // packed, TAP-02 §5: one beat's inputs, or every beat's when perBeat
        bytes state; // packed, TAP-02 §5: the state before beat 0
        uint256 fee;
        uint32 beats;
        bool perBeat;
        uint32 nIn;
        uint32 nOut;
        uint64 nState;
        uint64 flat; // leaves per beat before the state bits
        address poster;
        uint256 parent; // jobId + 1 of the job this one continues from, 0 if none
        // claim
        address claimant;
        bytes32 traceRoot;
        bytes outputs;
        bytes newState;
        uint64 claimedAt;
        bool challenged;
        bool finalized;
    }

    enum Turn { Claimant, Challenger, Leaf }

    struct Game {
        uint256 jobId;
        address challenger;
        uint8 level; // 0 = leaf
        uint256 index;
        bytes32 node; // claimant's hash at (level, index)
        Turn turn;
        uint64 deadline;
    }

    struct Leaf {
        uint256 pos;
        uint8 bit;
        bytes32[] siblings;
    }

    Job[] public jobs;
    Game[] public games;
    mapping(address => mapping(uint256 => uint256)) internal _flat; // flatSize + 1, 0 = not computed
    mapping(address => mapping(uint256 => uint256)) internal _nStateOf; // nState, set with _flat

    event JobPosted(uint256 indexed jobId, address cpu, uint256 id, uint32 beats);
    event Claimed(uint256 indexed jobId, address claimant, bytes32 traceRoot, bytes outputs);
    event Challenged(uint256 indexed jobId, uint256 indexed gameId, address challenger);
    event Revealed(uint256 indexed gameId, uint8 level, uint256 index, bytes32 left, bytes32 right);
    event Picked(uint256 indexed gameId, uint8 level, uint256 index);
    event Resolved(uint256 indexed jobId, uint256 indexed gameId, address winner, string reason);
    event Finalized(uint256 indexed jobId, bytes outputs);
    event Continued(uint256 indexed jobId, uint256 indexed parentJobId);

    constructor(uint256 bond_, uint256 window_, ITapeOutFactory factory_, address treasury_, uint256 feeBps_) {
        require(feeBps_ <= 1000, "fee");
        (bond, window, factory, treasury, feeBps) = (bond_, window_, factory_, treasury_, feeBps_);
    }

    // ---------------------------------------------------------------- jobs and claims

    /// Post a job: run circuit (cpu, id) for `beats` beats from `state`. With perBeat, `inputs`
    /// holds beats * nIn bits (beat b's input i is bit b * nIn + i); otherwise one beat's inputs,
    /// applied every beat. msg.value is the fee paid to whoever's claim finalizes.
    function postJob(address cpu, uint256 id, bytes calldata inputs, bytes calldata state, uint32 beats, bool perBeat)
        external
        payable
        returns (uint256 jobId)
    {
        return _post(cpu, id, inputs, state, beats, perBeat, 0);
    }

    /// Run more beats of the same circuit, starting from a finalized job's final state. A chain of
    /// jobs keeps a stateful machine (a CPU, a game world) running for as long as anyone pays.
    function continueJob(uint256 parentJobId, bytes calldata inputs, uint32 beats, bool perBeat) external payable returns (uint256 jobId) {
        Job storage pj = jobs[parentJobId];
        require(pj.finalized, "parent not final");
        jobId = _post(pj.cpu, pj.id, inputs, pj.newState, beats, perBeat, parentJobId + 1);
        emit Continued(jobId, parentJobId);
    }

    function _post(address cpu, uint256 id, bytes calldata inputs, bytes memory state, uint32 beats, bool perBeat, uint256 parent)
        internal
        returns (uint256 jobId)
    {
        require(beats >= 1, "beats");
        require(address(factory) == address(0) || factory.isCPU(cpu), "not a TapeOut processor");
        uint256 f = flatSize(cpu, id); // reverts on a malformed or missing circuit
        (uint32 nIn, uint32 nOut, uint32 nState,) = ICircuits(cpu).circuitInfo(id);
        require(inputs.length == _bytes(perBeat ? uint256(beats) * nIn : nIn), "inputs length");
        require(state.length == _bytes(nState), "state length");
        jobId = jobs.length;
        Job storage j = jobs.push();
        (j.cpu, j.id, j.inputs, j.state, j.fee, j.poster, j.parent) = (cpu, id, inputs, state, msg.value, msg.sender, parent);
        (j.beats, j.perBeat, j.nIn, j.nOut, j.nState, j.flat) = (beats, perBeat, nIn, nOut, nState, uint64(f));
        emit JobPosted(jobId, cpu, id, beats);
    }

    /// Leaves in the job's whole trace: one block of flat + nState leaves per beat.
    function traceSize(uint256 jobId) public view returns (uint256) {
        Job storage j = jobs[jobId];
        return uint256(j.beats) * (j.flat + j.nState);
    }

    function claim(uint256 jobId, bytes32 traceRoot, bytes calldata outputs, bytes calldata newState) external payable {
        Job storage j = jobs[jobId];
        require(j.claimant == address(0) && !j.finalized, "claimed");
        require(msg.value == bond, "bond");
        require(outputs.length == _bytes(j.nOut) && newState.length == _bytes(j.nState), "result length");
        (j.claimant, j.traceRoot, j.outputs, j.newState, j.claimedAt) = (msg.sender, traceRoot, outputs, newState, uint64(block.timestamp));
        emit Claimed(jobId, msg.sender, traceRoot, outputs);
    }

    function finalize(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.claimant != address(0) && !j.challenged && !j.finalized, "state");
        require(block.timestamp >= j.claimedAt + window, "window");
        j.finalized = true;
        uint256 cut = j.fee * feeBps / 10_000;
        if (cut > 0) _pay(treasury, cut);
        _pay(j.claimant, bond + j.fee - cut);
        emit Finalized(jobId, j.outputs);
        if (j.poster.code.length > 0) {
            // best effort: a receiver that reverts or runs out of gas does not block finalization
            try IOverclockReceiver(j.poster).onOverclockResult{gas: CALLBACK_GAS}(jobId, j.outputs, j.newState) {} catch {}
        }
    }

    /// The final, unchallenged result of a job. Any contract can read it.
    function result(uint256 jobId) external view returns (bytes memory outputs, bytes memory newState) {
        Job storage j = jobs[jobId];
        require(j.finalized, "not final");
        return (j.outputs, j.newState);
    }

    // ---------------------------------------------------------------- disputes over the trace

    function challenge(uint256 jobId) external payable returns (uint256 gameId) {
        Job storage j = jobs[jobId];
        require(j.claimant != address(0) && !j.challenged && !j.finalized, "state");
        require(block.timestamp < j.claimedAt + window, "window");
        require(msg.value == bond, "bond");
        j.challenged = true;
        gameId = games.length;
        games.push(Game(jobId, msg.sender, _depth(traceSize(jobId)), 0, j.traceRoot, Turn.Claimant, uint64(block.timestamp + window)));
        emit Challenged(jobId, gameId, msg.sender);
    }

    /// Claimant opens the node under dispute into its two children.
    function reveal(uint256 gameId, bytes32 left, bytes32 right) external {
        Game storage g = games[gameId];
        require(g.turn == Turn.Claimant && msg.sender == jobs[g.jobId].claimant, "turn");
        require(keccak256(abi.encodePacked(left, right)) == g.node, "hash");
        emit Revealed(gameId, g.level, g.index, left, right);
        g.turn = Turn.Challenger;
        g.deadline = uint64(block.timestamp + window);
        _pending[gameId] = [left, right];
    }

    mapping(uint256 => bytes32[2]) internal _pending;

    /// The two children the claimant revealed for the node under dispute.
    function pending(uint256 gameId) external view returns (bytes32 left, bytes32 right) {
        return (_pending[gameId][0], _pending[gameId][1]);
    }

    function jobCount() external view returns (uint256) {
        return jobs.length;
    }

    function gameCount() external view returns (uint256) {
        return games.length;
    }

    /// Challenger picks the child it disagrees with.
    function pick(uint256 gameId, bool right) external {
        Game storage g = games[gameId];
        require(g.turn == Turn.Challenger && msg.sender == g.challenger, "turn");
        g.node = _pending[gameId][right ? 1 : 0];
        g.index = g.index * 2 + (right ? 1 : 0);
        g.level -= 1;
        g.turn = g.level == 0 ? Turn.Leaf : Turn.Claimant;
        g.deadline = uint64(block.timestamp + window);
        emit Picked(gameId, g.level, g.index);
    }

    /// At the leaf: the challenger supplies the earlier leaves the step depends on (proved against
    /// the claimant's root). The contract recomputes the leaf; if the claimant's leaf differs, the
    /// claimant loses, otherwise the challenger does.
    function resolveLeaf(uint256 gameId, Leaf[] calldata deps) external {
        Game storage g = games[gameId];
        require(g.turn == Turn.Leaf, "turn");
        Job storage j = jobs[g.jobId];
        Ctx memory ctx = _ctx(j, _depth(traceSize(g.jobId)), deps);
        bytes32 expected;
        if (g.index >= traceSize(g.jobId)) {
            expected = PAD;
        } else {
            expected = _expected(ctx, j, g.index) == 1 ? LEAF1 : LEAF0;
        }
        _settle(gameId, g.node != expected, g.node != expected ? "wrong step" : "step was correct");
    }

    /// A claimed result bit that does not match the claimant's own trace. k < nOut is output k of
    /// the last beat; nOut + i is bit i of the final state.
    function disputeOutput(uint256 jobId, uint256 k, Leaf[] calldata deps) external payable {
        Job storage j = jobs[jobId];
        require(j.claimant != address(0) && !j.challenged && !j.finalized, "state");
        require(block.timestamp < j.claimedAt + window, "window");
        require(msg.value == bond, "bond");
        require(k < uint256(j.nOut) + j.nState, "k");
        Ctx memory ctx = _ctx(j, _depth(traceSize(jobId)), deps);
        uint256 last = uint256(j.beats - 1) * (j.flat + j.nState);
        uint256 pos;
        uint8 claimed;
        if (k < j.nOut) {
            pos = _sigPos(j.cpu, j.id, last, _nSignals(j.cpu, j.id) - j.nOut + k);
            claimed = _bit(j.outputs, k);
        } else {
            pos = last + j.flat + (k - j.nOut);
            claimed = _bit(j.newState, k - j.nOut);
        }
        j.challenged = true;
        uint256 gameId = games.length;
        games.push(Game(jobId, msg.sender, 0, pos, bytes32(0), Turn.Leaf, 0));
        bool wrong = _get(ctx, pos) != claimed;
        _settle(gameId, wrong, wrong ? "output does not match trace" : "output matches trace");
    }

    /// Whoever is due to move and misses the deadline loses.
    function timeout(uint256 gameId) external {
        Game storage g = games[gameId];
        require(g.deadline != 0 && block.timestamp > g.deadline, "not yet");
        bool claimantLate = g.turn == Turn.Claimant;
        _settle(gameId, claimantLate, claimantLate ? "claimant timed out" : "challenger timed out");
    }

    function _settle(uint256 gameId, bool claimantWrong, string memory reason) internal {
        Game storage g = games[gameId];
        Job storage j = jobs[g.jobId];
        g.deadline = 0;
        g.turn = Turn.Leaf;
        address winner;
        if (claimantWrong) {
            winner = g.challenger;
            // reopen the job for an honest claim
            (j.claimant, j.traceRoot, j.challenged) = (address(0), bytes32(0), false);
            delete j.outputs;
            delete j.newState;
        } else {
            winner = j.claimant;
            j.challenged = false;
            j.claimedAt = uint64(block.timestamp); // a fresh window for other watchers
        }
        g.level = 255; // closed
        _pay(winner, 2 * bond);
        emit Resolved(g.jobId, gameId, winner, reason);
    }

    // ---------------------------------------------------------------- the one-step check

    struct Ctx {
        bytes inputs;
        bytes state;
        uint256[] pos;
        uint8[] bits;
        uint256 beat; // the beat the leaf under check belongs to
        uint256 flat;
        uint256 block_; // leaves per beat
        uint256 nIn;
        bool perBeat;
    }

    function _ctx(Job storage j, uint8 depth, Leaf[] calldata deps) internal view returns (Ctx memory ctx) {
        ctx.inputs = j.inputs;
        ctx.state = j.state;
        (ctx.flat, ctx.block_, ctx.nIn, ctx.perBeat) = (j.flat, uint256(j.flat) + j.nState, j.nIn, j.perBeat);
        ctx.pos = new uint256[](deps.length);
        ctx.bits = new uint8[](deps.length);
        for (uint256 i; i < deps.length; i++) {
            require(deps[i].bit <= 1 && deps[i].siblings.length == depth, "leaf");
            bytes32 h = deps[i].bit == 1 ? LEAF1 : LEAF0;
            uint256 idx = deps[i].pos;
            for (uint256 d; d < depth; d++) {
                bytes32 s = deps[i].siblings[d];
                h = idx & 1 == 1 ? keccak256(abi.encodePacked(s, h)) : keccak256(abi.encodePacked(h, s));
                idx >>= 1;
            }
            require(h == j.traceRoot, "proof");
            ctx.pos[i] = deps[i].pos;
            ctx.bits[i] = deps[i].bit;
        }
    }

    function _get(Ctx memory ctx, uint256 pos) internal pure returns (uint8) {
        for (uint256 i; i < ctx.pos.length; i++) if (ctx.pos[i] == pos) return ctx.bits[i];
        revert("missing leaf");
    }

    /// The correct value of leaf q of the job's trace, given the leaves it depends on.
    function _expected(Ctx memory ctx, Job storage j, uint256 q) internal returns (uint8) {
        ctx.beat = q / ctx.block_;
        uint256 p = ctx.beat * ctx.block_;
        if (q < p + ctx.flat) return _bitAt(ctx, j.cpu, j.id, p, new uint256[](0), true, 0, q);
        // a state leaf: the value its LATCH's input signal had at the end of this beat
        return _get(ctx, _latchD(j.cpu, j.id, p, q - p - ctx.flat));
    }

    /// Input bit i of the top-level circuit in the current beat.
    function _input(Ctx memory ctx, uint256 i) internal pure returns (uint8) {
        return _bit(ctx.inputs, ctx.perBeat ? ctx.beat * ctx.nIn + i : i);
    }

    /// State bit i going into the current beat: the job's state, or the previous beat's state leaves.
    function _stateBit(Ctx memory ctx, uint256 i) internal pure returns (uint8) {
        if (ctx.beat == 0) return _bit(ctx.state, i);
        return _get(ctx, (ctx.beat - 1) * ctx.block_ + ctx.flat + i);
    }

    /// The correct value of leaf q, inside the invocation of (cpu, id) that starts at position p.
    /// inPos: trace positions of this invocation's inputs (top level reads the job's inputs).
    struct Walk {
        uint256 pos; // trace position of the next element's first leaf
        uint256 sig; // next local signal
        uint256 stBase; // state bits used by earlier elements
        uint256 off; // byte offset of the next record
        // big circuits REF the same sub-circuit over and over; keep the last one's sizes
        address lastSub;
        uint256 lastId;
        uint256 fs;
        uint256 subState;
    }

    function _bitAt(Ctx memory ctx, address cpu, uint256 id, uint256 p, uint256[] memory inPos, bool top, uint256 stateOff, uint256 q)
        internal
        returns (uint8)
    {
        bytes memory nl = ICircuits(cpu).netlist(id);
        (uint32 nIn,,,) = ICircuits(cpu).circuitInfo(id);
        if (q == p) return 0;
        if (q == p + 1) return 1;
        if (q < p + 2 + nIn) {
            uint256 i = q - p - 2;
            return top ? _input(ctx, i) : _get(ctx, inPos[i]);
        }
        // constants and inputs are copied into this invocation's own block
        uint256[] memory sigPos = new uint256[](_countSignals(nl, nIn));
        for (uint256 s; s < 2 + nIn; s++) sigPos[s] = p + s;
        Walk memory w;
        (w.pos, w.sig) = (p + 2 + nIn, 2 + nIn);
        while (w.off < nl.length) {
            uint8 op = _op(nl, w.off);
            if (op == NAND) {
                if (w.pos == q) return 1 - (_get(ctx, sigPos[_u24(nl, w.off + 1)]) & _get(ctx, sigPos[_u24(nl, w.off + 4)]));
                sigPos[w.sig++] = w.pos++;
                w.off += 7;
            } else if (op == LATCH) {
                if (w.pos == q) return _stateBit(ctx, stateOff + w.stBase);
                sigPos[w.sig++] = w.pos++;
                w.stBase += 1;
                w.off += 4;
            } else if (op == REF) {
                (address sub, uint256 sid, uint8 ni, uint8 no) = _refHeader(nl, w.off);
                if (sub != w.lastSub || sid != w.lastId) (w.lastSub, w.lastId, w.fs, w.subState) = (sub, sid, flatSize(sub, sid), _nState(sub, sid));
                if (q < w.pos + w.fs) {
                    uint256[] memory childIn = new uint256[](ni);
                    for (uint256 k; k < ni; k++) childIn[k] = sigPos[_u24(nl, w.off + 31 + 3 * k)];
                    return _bitAt(ctx, sub, sid, w.pos, childIn, false, stateOff + w.stBase, q);
                }
                if (q < w.pos + w.fs + no) return _get(ctx, _sigPos(sub, sid, w.pos, _nSignals(sub, sid) - no + (q - w.pos - w.fs)));
                w.pos += w.fs;
                for (uint256 k; k < no; k++) sigPos[w.sig++] = w.pos++;
                w.stBase += w.subState;
                w.off += 31 + 3 * uint256(ni);
            } else {
                revert("bad opcode");
            }
        }
        revert("position outside invocation");
    }

    /// Trace position of the signal that state bit k of the invocation at p latches.
    function _latchD(address cpu, uint256 id, uint256 p, uint256 k) internal returns (uint256) {
        bytes memory nl = ICircuits(cpu).netlist(id);
        (uint32 nIn,,,) = ICircuits(cpu).circuitInfo(id);
        uint256 pos = p + 2 + nIn;
        uint256 stBase;
        uint256 off;
        while (off < nl.length) {
            uint8 op = _op(nl, off);
            if (op == NAND) {
                pos++;
                off += 7;
            } else if (op == LATCH) {
                if (stBase == k) return _sigPos(cpu, id, p, _u24(nl, off + 1));
                pos++;
                stBase++;
                off += 4;
            } else {
                (address sub, uint256 sid, uint8 ni, uint8 no) = _refHeader(nl, off);
                uint256 subState = _nState(sub, sid);
                if (k < stBase + subState) return _latchD(sub, sid, pos, k - stBase);
                pos += flatSize(sub, sid) + no;
                stBase += subState;
                off += 31 + 3 * uint256(ni);
            }
        }
        revert("no such state bit");
    }

    /// Trace position of local signal `s` of the invocation of (cpu, id) starting at p.
    function _sigPos(address cpu, uint256 id, uint256 p, uint256 s) internal returns (uint256) {
        bytes memory nl = ICircuits(cpu).netlist(id);
        (uint32 nIn,,,) = ICircuits(cpu).circuitInfo(id);
        if (s < 2 + nIn) return p + s;
        uint256 pos = p + 2 + nIn;
        uint256 sig = 2 + nIn;
        uint256 off;
        while (off < nl.length) {
            uint8 op = _op(nl, off);
            if (op == NAND || op == LATCH) {
                if (sig == s) return pos;
                pos++;
                sig++;
                off += op == NAND ? 7 : 4;
            } else {
                (address sub, uint256 sid, uint8 ni, uint8 no) = _refHeader(nl, off);
                pos += flatSize(sub, sid);
                for (uint256 k; k < no; k++) {
                    if (sig == s) return pos;
                    pos++;
                    sig++;
                }
                off += 31 + 3 * uint256(ni);
            }
        }
        revert("no such signal");
    }

    // ---------------------------------------------------------------- netlist helpers

    /// Number of leaves in one beat's trace of (cpu, id), memoized.
    function flatSize(address cpu, uint256 id) public returns (uint256) {
        uint256 m = _flat[cpu][id];
        if (m != 0) return m - 1;
        bytes memory nl = ICircuits(cpu).netlist(id);
        (uint32 nIn,, uint32 nState,) = ICircuits(cpu).circuitInfo(id);
        _nStateOf[cpu][id] = nState;
        uint256 n = 2 + nIn;
        uint256 off;
        while (off < nl.length) {
            uint8 op = _op(nl, off);
            if (op == NAND) {
                n += 1;
                off += 7;
            } else if (op == LATCH) {
                n += 1;
                off += 4;
            } else if (op == REF) {
                (address sub, uint256 sid, uint8 ni, uint8 no) = _refHeader(nl, off);
                n += flatSize(sub, sid) + no;
                off += 31 + 3 * uint256(ni);
            } else {
                revert("bad opcode");
            }
        }
        require(off == nl.length, "truncated");
        _flat[cpu][id] = n + 1;
        return n;
    }

    function _nState(address cpu, uint256 id) internal returns (uint256) {
        flatSize(cpu, id);
        return _nStateOf[cpu][id];
    }

    function _nSignals(address cpu, uint256 id) internal view returns (uint256) {
        (uint32 nIn,,,) = ICircuits(cpu).circuitInfo(id);
        return _countSignals(ICircuits(cpu).netlist(id), nIn);
    }

    function _countSignals(bytes memory nl, uint256 nIn) internal pure returns (uint256 n) {
        n = 2 + nIn;
        uint256 off;
        while (off < nl.length) {
            uint8 op = _op(nl, off);
            if (op == NAND) {
                n++;
                off += 7;
            } else if (op == LATCH) {
                n++;
                off += 4;
            } else {
                (,, uint8 ni, uint8 no) = _refHeader(nl, off);
                n += no;
                off += 31 + 3 * uint256(ni);
            }
        }
    }

    // Netlist reads use mload: the walks over large netlists dominate the one-step check's gas.
    // Callers stay inside the netlist; the bytes read past a record's end are masked off.

    function _op(bytes memory nl, uint256 off) internal pure returns (uint8 r) {
        assembly ("memory-safe") {
            r := byte(0, mload(add(add(nl, 32), off)))
        }
    }

    function _refHeader(bytes memory nl, uint256 off) internal pure returns (address sub, uint256 sid, uint8 ni, uint8 no) {
        uint256 w1;
        uint256 w2;
        assembly ("memory-safe") {
            w1 := mload(add(add(nl, 33), off)) // cpu (20) | id (8) | nIn | nOut | ...
            w2 := mload(add(add(nl, 53), off))
        }
        sub = address(uint160(w1 >> 96));
        sid = w2 >> 192;
        ni = uint8(w2 >> 184);
        no = uint8(w2 >> 176);
    }

    function _u24(bytes memory nl, uint256 off) internal pure returns (uint256 r) {
        assembly ("memory-safe") {
            r := shr(232, mload(add(add(nl, 32), off)))
        }
    }

    /// Bit i of a packed vector, read as the deployed evaluator reads it (TAP-02 §5).
    function _bit(bytes memory v, uint256 i) internal pure returns (uint8) {
        if (i >> 3 >= v.length) return 0;
        return (uint8(v[i >> 3]) >> (i & 7)) & 1;
    }

    function _bytes(uint256 bits) internal pure returns (uint256) {
        return (bits + 7) >> 3;
    }

    function _depth(uint256 n) internal pure returns (uint8 d) {
        uint256 size = 1;
        while (size < n) {
            size <<= 1;
            d++;
        }
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "pay");
    }
}
