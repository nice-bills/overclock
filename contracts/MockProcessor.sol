// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Test stand-in for a TapeOut processor contract: stores netlists and serves the read-only
/// TAP-02 interface Overclock depends on. It does not check well-formedness or burn transistors.
contract MockProcessor {
    struct Info {
        uint32 nIn;
        uint32 nOut;
        uint32 nState;
        uint32 gateCount;
    }

    mapping(uint256 => bytes) internal _netlist;
    mapping(uint256 => Info) internal _info;
    uint256 public nextId = 1;

    function store(bytes calldata nl, uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount) external returns (uint256 id) {
        id = nextId++;
        _netlist[id] = nl;
        _info[id] = Info(nIn, nOut, nState, gateCount);
    }

    function netlist(uint256 id) external view returns (bytes memory) {
        require(_info[id].nOut != 0, "no circuit");
        return _netlist[id];
    }

    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32) {
        Info memory i = _info[id];
        require(i.nOut != 0, "no circuit");
        return (i.nIn, i.nOut, i.nState, i.gateCount);
    }
}
