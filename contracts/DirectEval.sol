// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ICircuits} from "./Overclock.sol";

/// Baseline for the demo: evaluate beats of a circuit directly on-chain, the way a contract would
/// without Overclock. A straightforward TAP-02 evaluator with REF recursion; gas grows with every
/// gate of every beat.
contract DirectEval {
    uint256 public lastOutputs;

    function run(address cpu, uint256 id, bytes calldata state, uint32 beats) external returns (bytes memory outs, bytes memory st) {
        (, uint32 nOut, uint32 nState,) = ICircuits(cpu).circuitInfo(id);
        uint8[] memory s = new uint8[](nState);
        for (uint256 i; i < nState; i++) s[i] = (i >> 3) < state.length ? (uint8(state[i >> 3]) >> (i & 7)) & 1 : 0;
        uint8[] memory o;
        for (uint32 b; b < beats; b++) (o, s) = _beat(cpu, id, s, new uint8[](0));
        outs = _pack(o, nOut);
        st = _pack(s, nState);
        lastOutputs = uint256(keccak256(outs)); // keep the call a real transaction
    }

    function _beat(address cpu, uint256 id, uint8[] memory state, uint8[] memory ins) internal view returns (uint8[] memory outs, uint8[] memory ns) {
        bytes memory nl = ICircuits(cpu).netlist(id);
        (uint32 nIn, uint32 nOut, uint32 nState,) = ICircuits(cpu).circuitInfo(id);
        uint8[] memory a = new uint8[](_count(nl, nIn));
        a[1] = 1;
        for (uint256 i; i < nIn; i++) a[2 + i] = ins[i];
        ns = new uint8[](nState);
        uint256 sig = 2 + nIn;
        uint256 st;
        uint256 off;
        while (off < nl.length) {
            uint8 op = uint8(nl[off]);
            if (op == 0) {
                a[sig++] = 1 - (a[_u24(nl, off + 1)] & a[_u24(nl, off + 4)]);
                off += 7;
            } else if (op == 1) {
                a[sig++] = state[st++];
                off += 4;
            } else {
                (address sub, uint256 sid, uint8 ni, uint8 no) = _ref(nl, off);
                (,, uint32 subState,) = ICircuits(sub).circuitInfo(sid);
                uint8[] memory si = new uint8[](ni);
                for (uint256 k; k < ni; k++) si[k] = a[_u24(nl, off + 31 + 3 * k)];
                uint8[] memory ss = new uint8[](subState);
                for (uint256 k; k < subState; k++) ss[k] = state[st + k];
                (uint8[] memory so, uint8[] memory sn) = _beat(sub, sid, ss, si);
                for (uint256 k; k < subState; k++) ns[st + k] = sn[k];
                for (uint256 k; k < no; k++) a[sig++] = so[k];
                st += subState;
                off += 31 + 3 * uint256(ni);
            }
        }
        // LATCH writes
        (sig, st, off) = (2 + nIn, 0, 0);
        while (off < nl.length) {
            uint8 op = uint8(nl[off]);
            if (op == 0) off += 7;
            else if (op == 1) {
                ns[st++] = a[_u24(nl, off + 1)];
                off += 4;
            } else {
                (address sub, uint256 sid, uint8 ni,) = _ref(nl, off);
                (,, uint32 subState,) = ICircuits(sub).circuitInfo(sid);
                st += subState;
                off += 31 + 3 * uint256(ni);
            }
        }
        outs = new uint8[](nOut);
        for (uint256 k; k < nOut; k++) outs[k] = a[a.length - nOut + k];
    }

    function _count(bytes memory nl, uint256 nIn) internal pure returns (uint256 n) {
        n = 2 + nIn;
        uint256 off;
        while (off < nl.length) {
            uint8 op = uint8(nl[off]);
            if (op == 0) (n, off) = (n + 1, off + 7);
            else if (op == 1) (n, off) = (n + 1, off + 4);
            else (n, off) = (n + uint8(nl[off + 30]), off + 31 + 3 * uint256(uint8(nl[off + 29])));
        }
    }

    function _ref(bytes memory nl, uint256 off) internal pure returns (address sub, uint256 sid, uint8 ni, uint8 no) {
        uint160 x;
        for (uint256 i; i < 20; i++) x = (x << 8) | uint8(nl[off + 1 + i]);
        uint64 id;
        for (uint256 i; i < 8; i++) id = (id << 8) | uint8(nl[off + 21 + i]);
        return (address(x), id, uint8(nl[off + 29]), uint8(nl[off + 30]));
    }

    function _u24(bytes memory nl, uint256 off) internal pure returns (uint256) {
        return (uint256(uint8(nl[off])) << 16) | (uint256(uint8(nl[off + 1])) << 8) | uint8(nl[off + 2]);
    }

    function _pack(uint8[] memory bits, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes((n + 7) >> 3);
        for (uint256 i; i < n; i++) if (bits[i] == 1) out[i >> 3] = bytes1(uint8(out[i >> 3]) | uint8(1 << (i & 7)));
    }
}
