// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// TAP-02 processor contract, read-only part.
interface ICircuits {
    function netlist(uint256 id) external view returns (bytes memory);
    function circuitInfo(uint256 id) external view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount);
}

/// Optimistic execution of TapeOut circuits.
///
/// An operator runs one beat of a circuit off-chain and claims the outputs, committing a
/// Merkle root over the execution-order trace (see src/trace.js for the layout). Anyone who
/// disagrees challenges; the two bisect the trace tree down to the first leaf they disagree on,
/// and the contract re-checks that one step: a single NAND, LATCH read, REF wire or input.
contract Overclock {
    uint8 internal constant NAND = 0x00;
    uint8 internal constant LATCH = 0x01;
    uint8 internal constant REF = 0x02;

    bytes32 internal constant LEAF0 = keccak256(hex"00");
    bytes32 internal constant LEAF1 = keccak256(hex"01");
    bytes32 internal constant PAD = bytes32(0);

    uint256 public immutable bond;
    uint256 public immutable window;

    struct Job {
        address cpu;
        uint256 id;
        bytes inputs; // packed, TAP-02 §5
        bytes state; // packed, TAP-02 §5
        uint256 fee;
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

    event JobPosted(uint256 indexed jobId, address cpu, uint256 id);
    event Claimed(uint256 indexed jobId, address claimant, bytes32 traceRoot, bytes outputs);
    event Challenged(uint256 indexed jobId, uint256 indexed gameId, address challenger);
    event Revealed(uint256 indexed gameId, uint8 level, uint256 index, bytes32 left, bytes32 right);
    event Picked(uint256 indexed gameId, uint8 level, uint256 index);
    event Resolved(uint256 indexed jobId, uint256 indexed gameId, address winner, string reason);
    event Finalized(uint256 indexed jobId, bytes outputs);

    constructor(uint256 bond_, uint256 window_) {
        bond = bond_;
        window = window_;
    }

    // ---------------------------------------------------------------- jobs and claims

    function postJob(address cpu, uint256 id, bytes calldata inputs, bytes calldata state) external payable returns (uint256 jobId) {
        flatSize(cpu, id); // reverts on a malformed or missing circuit
        jobId = jobs.length;
        Job storage j = jobs.push();
        (j.cpu, j.id, j.inputs, j.state, j.fee) = (cpu, id, inputs, state, msg.value);
        emit JobPosted(jobId, cpu, id);
    }

    function claim(uint256 jobId, bytes32 traceRoot, bytes calldata outputs, bytes calldata newState) external payable {
        Job storage j = jobs[jobId];
        require(j.claimant == address(0) && !j.finalized, "claimed");
        require(msg.value == bond, "bond");
        (j.claimant, j.traceRoot, j.outputs, j.newState, j.claimedAt) = (msg.sender, traceRoot, outputs, newState, uint64(block.timestamp));
        emit Claimed(jobId, msg.sender, traceRoot, outputs);
    }

    function finalize(uint256 jobId) external {
        Job storage j = jobs[jobId];
        require(j.claimant != address(0) && !j.challenged && !j.finalized, "state");
        require(block.timestamp >= j.claimedAt + window, "window");
        j.finalized = true;
        _pay(j.claimant, bond + j.fee);
        emit Finalized(jobId, j.outputs);
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
        games.push(Game(jobId, msg.sender, _depth(flatSize(j.cpu, j.id)), 0, j.traceRoot, Turn.Claimant, uint64(block.timestamp + window)));
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
        uint8 depth = _depth(flatSize(j.cpu, j.id));
        Ctx memory ctx = _ctx(j, depth, deps);
        bytes32 expected;
        if (g.index >= flatSize(j.cpu, j.id)) {
            expected = PAD;
        } else {
            uint8 b = _bitAt(ctx, j.cpu, j.id, 0, new uint256[](0), true, 0, g.index);
            expected = b == 1 ? LEAF1 : LEAF0;
        }
        _settle(gameId, g.node != expected, g.node != expected ? "wrong step" : "step was correct");
    }

    /// Claimed outputs that do not match the claimant's own trace.
    function disputeOutput(uint256 jobId, uint256 k, Leaf[] calldata deps) external payable {
        Job storage j = jobs[jobId];
        require(j.claimant != address(0) && !j.challenged && !j.finalized, "state");
        require(block.timestamp < j.claimedAt + window, "window");
        require(msg.value == bond, "bond");
        (, uint32 nOut,,) = ICircuits(j.cpu).circuitInfo(j.id);
        require(k < nOut, "k");
        Ctx memory ctx = _ctx(j, _depth(flatSize(j.cpu, j.id)), deps);
        uint256 nSig = _nSignals(j.cpu, j.id);
        uint256 pos = _sigPos(j.cpu, j.id, 0, nSig - nOut + k);
        j.challenged = true;
        uint256 gameId = games.length;
        games.push(Game(jobId, msg.sender, 0, pos, bytes32(0), Turn.Leaf, 0));
        bool wrong = _get(ctx, pos) != _bit(j.outputs, k);
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
    }

    function _ctx(Job storage j, uint8 depth, Leaf[] calldata deps) internal view returns (Ctx memory ctx) {
        ctx.inputs = j.inputs;
        ctx.state = j.state;
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

    /// The correct value of leaf q, inside the invocation of (cpu, id) that starts at position p.
    /// inPos: trace positions of this invocation's inputs (top level reads the job's inputs).
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
            return top ? _bit(ctx.inputs, i) : _get(ctx, inPos[i]);
        }
        // constants and inputs are copied into this invocation's own block
        uint256[] memory sigPos = new uint256[](_countSignals(nl, nIn));
        for (uint256 s; s < 2 + nIn; s++) sigPos[s] = p + s;
        uint256 pos = p + 2 + nIn;
        uint256 sig = 2 + nIn;
        uint256 stBase;
        uint256 off;
        while (off < nl.length) {
            uint8 op = uint8(nl[off]);
            if (op == NAND) {
                if (pos == q) return 1 - (_get(ctx, sigPos[_u24(nl, off + 1)]) & _get(ctx, sigPos[_u24(nl, off + 4)]));
                sigPos[sig++] = pos++;
                off += 7;
            } else if (op == LATCH) {
                if (pos == q) return _bit(ctx.state, stateOff + stBase);
                sigPos[sig++] = pos++;
                stBase += 1;
                off += 4;
            } else if (op == REF) {
                (address sub, uint256 sid, uint8 ni, uint8 no) = _refHeader(nl, off);
                uint256 fs = flatSize(sub, sid);
                (,, uint32 subState,) = ICircuits(sub).circuitInfo(sid);
                if (q < pos + fs) {
                    uint256[] memory childIn = new uint256[](ni);
                    for (uint256 k; k < ni; k++) childIn[k] = sigPos[_u24(nl, off + 31 + 3 * k)];
                    return _bitAt(ctx, sub, sid, pos, childIn, false, stateOff + stBase, q);
                }
                uint256 subSig = _nSignals(sub, sid);
                for (uint256 k; k < no; k++) {
                    if (pos + fs + k == q) return _get(ctx, _sigPos(sub, sid, pos, subSig - no + k));
                }
                pos += fs;
                for (uint256 k; k < no; k++) sigPos[sig++] = pos++;
                stBase += subState;
                off += 31 + 3 * uint256(ni);
            } else {
                revert("bad opcode");
            }
        }
        revert("position outside invocation");
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
            uint8 op = uint8(nl[off]);
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
        (uint32 nIn,,,) = ICircuits(cpu).circuitInfo(id);
        uint256 n = 2 + nIn;
        uint256 off;
        while (off < nl.length) {
            uint8 op = uint8(nl[off]);
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

    function _nSignals(address cpu, uint256 id) internal view returns (uint256) {
        (uint32 nIn,,,) = ICircuits(cpu).circuitInfo(id);
        return _countSignals(ICircuits(cpu).netlist(id), nIn);
    }

    function _countSignals(bytes memory nl, uint256 nIn) internal pure returns (uint256 n) {
        n = 2 + nIn;
        uint256 off;
        while (off < nl.length) {
            uint8 op = uint8(nl[off]);
            if (op == NAND) {
                n++;
                off += 7;
            } else if (op == LATCH) {
                n++;
                off += 4;
            } else {
                uint8 ni = uint8(nl[off + 29]);
                n += uint8(nl[off + 30]);
                off += 31 + 3 * uint256(ni);
            }
        }
    }

    function _refHeader(bytes memory nl, uint256 off) internal pure returns (address sub, uint256 sid, uint8 ni, uint8 no) {
        uint160 a;
        for (uint256 i; i < 20; i++) a = (a << 8) | uint8(nl[off + 1 + i]);
        uint64 id;
        for (uint256 i; i < 8; i++) id = (id << 8) | uint8(nl[off + 21 + i]);
        return (address(a), id, uint8(nl[off + 29]), uint8(nl[off + 30]));
    }

    function _u24(bytes memory nl, uint256 off) internal pure returns (uint256) {
        return (uint256(uint8(nl[off])) << 16) | (uint256(uint8(nl[off + 1])) << 8) | uint8(nl[off + 2]);
    }

    /// Bit i of a packed vector, read as the deployed evaluator reads it (TAP-02 §5).
    function _bit(bytes memory v, uint256 i) internal pure returns (uint8) {
        if (i >> 3 >= v.length) return 0;
        return (uint8(v[i >> 3]) >> (i & 7)) & 1;
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
