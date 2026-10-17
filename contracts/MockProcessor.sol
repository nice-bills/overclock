// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Test stand-in for a TapeOut processor contract: stores netlists and serves the read-only
/// TAP-02 interface Overclock depends on. Like the deployed factory, it keeps netlists in
/// SSTORE2 chunks (contract bytecode), so reading one costs what it costs on X Layer.
/// It does not check well-formedness or burn transistors.
contract MockProcessor {
    struct Info {
        uint32 nIn;
        uint32 nOut;
        uint32 nState;
        uint32 gateCount;
    }

    uint256 internal constant CHUNK = 24_000;

    mapping(uint256 => address[]) internal _chunks;
    mapping(uint256 => uint256) internal _size;
    mapping(uint256 => Info) internal _info;
    uint256 public nextId = 1;

    function store(bytes calldata nl, uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount) external returns (uint256 id) {
        id = nextId++;
        for (uint256 off; off < nl.length; off += CHUNK) {
            uint256 end = off + CHUNK < nl.length ? off + CHUNK : nl.length;
            _chunks[id].push(_write(nl[off:end]));
        }
        _size[id] = nl.length;
        _info[id] = Info(nIn, nOut, nState, gateCount);
    }

    function netlist(uint256 id) external view returns (bytes memory out) {
        require(_info[id].nOut != 0, "no circuit");
        out = new bytes(_size[id]);
        address[] storage cs = _chunks[id];
        for (uint256 i; i < cs.length; i++) {
            address c = cs[i];
            uint256 n = c.code.length - 1;
            assembly {
                extcodecopy(c, add(add(out, 32), mul(i, CHUNK)), 1, n)
            }
        }
    }

    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32) {
        Info memory i = _info[id];
        require(i.nOut != 0, "no circuit");
        return (i.nIn, i.nOut, i.nState, i.gateCount);
    }

    /// Deploy `data` as the runtime code of a new contract, behind a STOP byte.
    function _write(bytes calldata data) internal returns (address a) {
        bytes memory code = abi.encodePacked(hex"63", uint32(data.length + 1), hex"80600e6000396000f3", hex"00", data);
        assembly {
            a := create(0, add(code, 32), mload(code))
        }
        require(a != address(0), "write");
    }
}
