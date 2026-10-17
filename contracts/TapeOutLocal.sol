// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// A local stand-in for TapeOut's X Layer contracts, for running the full flow (create a processor,
/// mint transistors, tape out, run Overclock) on a throwaway chain. It follows the interface and the
/// rules documented from the live contracts (see docs/tapeout-notes.md): fees, burns, netlist
/// validation, REF targets, flattened circuitInfo and SSTORE2 storage. It is not TapeOut's code; the
/// fork rehearsal (scripts/demo.js --fork) runs the same flow against the real contracts.

contract TapeOutFactoryLocal {
    uint256 public deployFee = 0.0066 ether;
    uint256 public protocolFee = 0.00066 ether;
    address[] public cpus;
    mapping(address => bool) public isCPU;

    event CPUCreated(address indexed circuits, address indexed transistors, address indexed creator, string name, uint256 supply, uint256 mintPrice);

    function createCPU(string calldata name, string calldata symbol, string calldata story, uint256 supply, uint256 mintPrice)
        external
        payable
        returns (address transistors, address circuits)
    {
        require(msg.value >= deployFee, "deploy fee");
        TransistorsLocal t = new TransistorsLocal(msg.sender, name, symbol, story, supply, mintPrice, protocolFee);
        CircuitsLocal c = new CircuitsLocal(this, t, name, symbol);
        t.setCircuits(address(c));
        (transistors, circuits) = (address(t), address(c));
        cpus.push(circuits);
        isCPU[circuits] = true;
        emit CPUCreated(circuits, transistors, msg.sender, name, supply, mintPrice);
    }

    function cpuCount() external view returns (uint256) {
        return cpus.length;
    }
}

/// ERC-1155 transistors: NAND = 0, LATCH = 1, one shared supply cap.
contract TransistorsLocal {
    uint256 public constant NAND = 0;
    uint256 public constant LATCH = 1;
    address public immutable creator;
    address public circuits;
    string public cpuName;
    string public cpuSymbol;
    string public story;
    uint256 public immutable supplyCap;
    uint256 public immutable mintPrice;
    uint256 public immutable protocolFee;
    uint256 public minted;
    mapping(address => mapping(uint256 => uint256)) public balanceOf;

    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event Minted(address indexed to, uint256 indexed id, uint256 amount, uint256 paid);

    constructor(address creator_, string memory name, string memory symbol, string memory story_, uint256 cap, uint256 price, uint256 fee) {
        (creator, cpuName, cpuSymbol, story, supplyCap, mintPrice, protocolFee) = (creator_, name, symbol, story_, cap, price, fee);
    }

    function setCircuits(address c) external {
        require(circuits == address(0), "set");
        circuits = c;
    }

    function mint(uint256 id, uint256 amount) external payable {
        require(id <= 1, "bad id");
        require(amount > 0, "zero");
        require(msg.value >= amount * mintPrice + protocolFee, "insufficient");
        require(minted + amount <= supplyCap, "supply cap");
        minted += amount;
        balanceOf[msg.sender][id] += amount;
        emit TransferSingle(msg.sender, address(0), msg.sender, id, amount);
        emit Minted(msg.sender, id, amount, msg.value);
    }

    function burnFrom(address from, uint256 id, uint256 amount) external {
        require(msg.sender == circuits, "only circuits");
        uint256 b = balanceOf[from][id];
        if (b < amount) revert ERC1155InsufficientBalance(from, b, amount, id);
        balanceOf[from][id] = b - amount;
        emit TransferSingle(msg.sender, from, address(0), id, amount);
    }

    error ERC1155InsufficientBalance(address sender, uint256 balance, uint256 needed, uint256 tokenId);
}

interface ICircuitInfo {
    function circuitInfo(uint256 id) external view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount);
}

/// ERC-721 circuits. Ids start at 1; nextId() is the last assigned id.
contract CircuitsLocal {
    uint256 public constant TAPEOUT_FEE = 0.0013 ether;
    uint256 internal constant CHUNK = 24_000;
    TapeOutFactoryLocal public immutable factory;
    TransistorsLocal public immutable transistors;
    string public name;
    string public symbol;
    uint256 public nextId;

    struct Info {
        uint32 nIn;
        uint32 nOut;
        uint32 nState;
        uint32 gateCount;
    }

    mapping(uint256 => Info) internal _info;
    mapping(uint256 => address[]) internal _chunks;
    mapping(uint256 => uint256) internal _size;
    mapping(uint256 => address) public ownerOf;

    event Transfer(address indexed from, address indexed to, uint256 indexed id);
    event TapedOut(uint256 indexed circuitId, address indexed author, uint32 gateCount, uint32 nState);

    constructor(TapeOutFactoryLocal f, TransistorsLocal t, string memory n, string memory s) {
        (factory, transistors, name, symbol) = (f, t, n, s);
    }

    function tapeout(bytes calldata nl, uint32 nIn, uint32 nOut) external payable returns (uint256 id) {
        require(msg.value == TAPEOUT_FEE, "tapeout fee");
        require(nOut > 0, "no outputs");
        (uint256 nands, uint256 latches, uint256 gates, uint256 nState, uint256 nSig) = _check(nl, nIn);
        require(nSig - 2 - nIn >= nOut, "too few signals for outputs");
        if (nands > 0) transistors.burnFrom(msg.sender, 0, nands);
        if (latches > 0) transistors.burnFrom(msg.sender, 1, latches);
        id = ++nextId;
        for (uint256 off; off < nl.length; off += CHUNK) {
            uint256 end = off + CHUNK < nl.length ? off + CHUNK : nl.length;
            _chunks[id].push(_write(nl[off:end]));
        }
        _size[id] = nl.length;
        _info[id] = Info(nIn, nOut, uint32(nState), uint32(gates));
        ownerOf[id] = msg.sender;
        emit Transfer(address(0), msg.sender, id);
        emit TapedOut(id, msg.sender, uint32(gates), uint32(nState));
    }

    /// Validates the netlist; returns element counts, flattened gates and state, and the signal count.
    function _check(bytes calldata nl, uint256 nIn) internal view returns (uint256 nands, uint256 latches, uint256 gates, uint256 nState, uint256 nSig) {
        nSig = 2 + nIn;
        uint256 off;
        // first pass: signal count, so LATCH d can be range-checked
        while (off < nl.length) {
            uint8 op = uint8(nl[off]);
            if (op == 0) (nSig, off) = (nSig + 1, off + 7);
            else if (op == 1) (nSig, off) = (nSig + 1, off + 4);
            else if (op == 2) {
                require(off + 31 <= nl.length, "truncated");
                (nSig, off) = (nSig + uint8(nl[off + 30]), off + 31 + 3 * uint256(uint8(nl[off + 29])));
            } else revert("bad opcode");
        }
        require(off == nl.length, "truncated");
        uint256 sig = 2 + nIn;
        off = 0;
        while (off < nl.length) {
            uint8 op = uint8(nl[off]);
            if (op == 0) {
                require(_u24(nl, off + 1) < sig && _u24(nl, off + 4) < sig, "NAND: future signal");
                (nands, gates, sig, off) = (nands + 1, gates + 1, sig + 1, off + 7);
            } else if (op == 1) {
                require(_u24(nl, off + 1) < nSig, "LATCH d out of range");
                (latches, gates, nState, sig, off) = (latches + 1, gates + 1, nState + 1, sig + 1, off + 4);
            } else {
                address cpu = address(bytes20(nl[off + 1:off + 21]));
                uint256 sid = uint64(bytes8(nl[off + 21:off + 29]));
                uint8 ni = uint8(nl[off + 29]);
                uint8 no = uint8(nl[off + 30]);
                require(factory.isCPU(cpu), "REF: target not a registered CPU");
                (uint32 sIn, uint32 sOut, uint32 sState, uint32 sGates) = ICircuitInfo(cpu).circuitInfo(sid);
                require(sIn == ni && sOut == no, "REF: pin mismatch");
                for (uint256 k; k < ni; k++) require(_u24(nl, off + 31 + 3 * k) < sig, "REF: future signal");
                (gates, nState, sig, off) = (gates + sGates, nState + sState, sig + no, off + 31 + 3 * uint256(ni));
            }
        }
    }

    function netlist(uint256 id) external view returns (bytes memory out) {
        require(_info[id].nOut != 0, "no circuit");
        out = new bytes(_size[id]);
        address[] storage cs = _chunks[id];
        for (uint256 i; i < cs.length; i++) {
            address c = cs[i];
            uint256 n = c.code.length - 1;
            assembly ("memory-safe") {
                extcodecopy(c, add(add(out, 32), mul(i, CHUNK)), 1, n)
            }
        }
    }

    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32) {
        Info memory i = _info[id];
        require(i.nOut != 0, "no circuit");
        return (i.nIn, i.nOut, i.nState, i.gateCount);
    }

    function _u24(bytes calldata nl, uint256 off) internal pure returns (uint256) {
        return (uint256(uint8(nl[off])) << 16) | (uint256(uint8(nl[off + 1])) << 8) | uint8(nl[off + 2]);
    }

    function _write(bytes calldata data) internal returns (address a) {
        bytes memory code = abi.encodePacked(hex"63", uint32(data.length + 1), hex"80600e6000396000f3", hex"00", data);
        assembly ("memory-safe") {
            a := create(0, add(code, 32), mload(code))
        }
        require(a != address(0), "write");
    }
}

interface IOwnerOf {
    function ownerOf(uint256 id) external view returns (address);
}

/// Stand-in for TapeOut's opener: gives a circuit its own account, controlled by the circuit's owner.
contract OpenerLocal {
    uint256 public constant FEE = 0.08 ether;
    TapeOutFactoryLocal public immutable factory;
    mapping(bytes32 => address) internal _accounts;

    event Opened(address indexed circuits, uint256 indexed tokenId, address indexed account, address payer);

    constructor(TapeOutFactoryLocal f) {
        factory = f;
    }

    function open(address circuits, uint256 tokenId) external payable returns (address a) {
        require(msg.value >= FEE, "fee");
        require(factory.isCPU(circuits), "not a CPU");
        IOwnerOf(circuits).ownerOf(tokenId);
        bytes32 k = keccak256(abi.encode(circuits, tokenId));
        require(_accounts[k] == address(0), "opened");
        a = address(new CircuitAccountLocal(circuits, tokenId));
        _accounts[k] = a;
        if (msg.value > FEE) payable(msg.sender).transfer(msg.value - FEE);
        emit Opened(circuits, tokenId, a, msg.sender);
    }

    function accountOf(address circuits, uint256 tokenId) external view returns (address) {
        return _accounts[keccak256(abi.encode(circuits, tokenId))];
    }

    function isOpened(address circuits, uint256 tokenId) external view returns (bool) {
        return _accounts[keccak256(abi.encode(circuits, tokenId))] != address(0);
    }
}

contract CircuitAccountLocal {
    uint256 public constant EXEC_FEE = 0.0013 ether;
    address public immutable circuits;
    uint256 public immutable tokenId;
    uint256 public state;

    constructor(address c, uint256 id) {
        (circuits, tokenId) = (c, id);
    }

    receive() external payable {}

    function owner() public view returns (address) {
        return IOwnerOf(circuits).ownerOf(tokenId);
    }

    function token() external view returns (uint256, address, uint256) {
        return (block.chainid, circuits, tokenId);
    }

    function execute(address to, uint256 value, bytes calldata data, uint8 operation) external payable returns (bytes memory result) {
        require(msg.sender == owner(), "NotOwner");
        require(operation == 0, "OnlyCall");
        require(msg.value >= EXEC_FEE, "ProtocolFeeTooLow");
        state++;
        bool ok;
        (ok, result) = to.call{value: value}(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        if (msg.value > EXEC_FEE) payable(msg.sender).transfer(msg.value - EXEC_FEE);
    }
}
