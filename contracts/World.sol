// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOverclockReceiver} from "./Overclock.sol";

interface IOverclockWorld {
    function postJob(address cpu, uint256 id, bytes calldata inputs, bytes calldata state, uint32 beats, bool perBeat)
        external
        payable
        returns (uint256 jobId);
    function result(uint256 jobId) external view returns (bytes memory outputs, bytes memory newState);
}

/// TapeOut's container opener and a circuit's ERC-6551 container (the circuit's own account).
interface IOpener {
    function FEE() external view returns (uint256);
    function open(address circuits, uint256 tokenId) external payable returns (address);
    function accountOf(address circuits, uint256 tokenId) external view returns (address);
    function isOpened(address circuits, uint256 tokenId) external view returns (bool);
}

interface IContainer {
    function execute(address to, uint256 value, bytes calldata data, uint8 operation) external payable returns (bytes memory);
}

interface ICircuitNft {
    function ownerOf(uint256 id) external view returns (address);
}

/// The DeWEB hub's TapeSend `send` (TAP-10 §13.5).
interface IHub {
    function send(address circuits, uint256 tokenId, bytes32 to, bytes32 ref, bytes calldata payload) external returns (uint256);
}

/// Overclock World: Red vs Blue, a shared 16x16 two-colour Game of Life on X Layer.
///
/// Players pick a team and buy cells. Between epochs their cells are dropped onto the board, and the
/// world then runs `epochBeats` generations of the TapeOut world circuit (src/world.js) as one Overclock
/// job, which this contract posts and pays for out of the cells it sold. Running an epoch directly would
/// take billions of gas; through Overclock it is a claim and a finalize, and anyone can prove a wrong
/// generation on-chain. After `epochsPerSeason` epochs the team with more live cells wins the season's
/// pot, shared by its players in proportion to the cells they bought. Then the board is cleared.
///
/// The world is its own TapeOut circuit. Once this contract holds the world circuit's NFT, `adopt` opens the
/// circuit's container (its ERC-6551 account), and from then on every epoch is posted by that container, so
/// on-chain the circuit pays for its own compute. At the end of each season the container announces the
/// final board and the winner as a public TapeSend message (TAP-10 Part III) in its own outbox.
///
/// State layout (TAP-02 packed, as the circuit has it): 256 "alive" bits, then 256 "blue" bits; cell k is
/// x = k % 16, y = k / 16. Here each half is a uint256 whose bit k is cell k.
contract World is IOverclockReceiver {
    uint8 public constant RED = 1;
    uint8 public constant BLUE = 2;
    uint256 public constant MAX_CELLS = 12; // per placement

    IOverclockWorld public immutable overclock;
    address public immutable cpu;
    uint256 public immutable worldId;
    uint32 public immutable epochBeats;
    uint32 public immutable epochsPerSeason;
    uint256 public immutable cellPrice;
    uint256 public immutable jobFee; // paid to the operator whose result finalizes
    uint256 public immutable keeperTip; // paid to whoever advances the world
    IHub public immutable hub; // the DeWEB hub, or 0 for no announcements
    address public immutable deployer; // the only one who may name the opener, once

    address public container; // the world circuit's own account, once adopted
    uint256 public execFee; // what the container charges per call (TapeOut's protocol fee)

    uint256 public alive; // the board after the last finalized epoch
    uint256 public blue;
    uint256 public pendingAlive; // cells bought for the next epoch
    uint256 public pendingBlue;
    uint256 public running; // jobId + 1 of the epoch being run, 0 if none
    uint32 public epoch; // epochs finished in the current season
    uint32 public season;
    uint256 public owed; // every pot not yet paid out; the rest of the balance is fuel

    struct Season {
        uint256 pot;
        uint256[3] placed; // cells bought, by team
        uint8 winner; // 0 while running or on a tie (the pot rolls over)
        uint32 red; // live cells at the end
        uint32 blue;
    }

    mapping(uint32 => Season) internal seasons;
    mapping(uint32 => mapping(address => uint8)) public teamOf;
    mapping(uint32 => mapping(address => uint256)) public placedBy;
    mapping(uint32 => mapping(address => bool)) public claimed;

    event Placed(uint32 indexed season, address indexed player, uint8 team, uint256 cells, uint256 count);
    event EpochStarted(uint32 indexed season, uint32 epoch, uint256 jobId);
    event EpochEnded(uint32 indexed season, uint32 epoch, uint256 jobId, uint256 red, uint256 blue);
    event SeasonEnded(uint32 indexed season, uint8 winner, uint256 red, uint256 blue, uint256 pot);
    event Claimed(uint32 indexed season, address indexed player, uint256 amount);

    constructor(
        IOverclockWorld overclock_,
        address cpu_,
        uint256 worldId_,
        uint32 epochBeats_,
        uint32 epochsPerSeason_,
        uint256 cellPrice_,
        uint256 jobFee_,
        uint256 keeperTip_,
        IHub hub_
    ) {
        require(epochBeats_ > 0 && epochsPerSeason_ > 0, "params");
        (overclock, cpu, worldId, epochBeats, epochsPerSeason) = (overclock_, cpu_, worldId_, epochBeats_, epochsPerSeason_);
        (cellPrice, jobFee, keeperTip, hub) = (cellPrice_, jobFee_, keeperTip_, hub_);
        deployer = msg.sender;
    }

    event Adopted(address container, uint256 execFee);
    event Announced(uint32 indexed season, uint256 inboxIndex);
    event AnnounceFailed(uint32 indexed season);

    /// Make the world its own circuit: this contract must already hold the world circuit's NFT. Opens the
    /// circuit's container if nobody has yet (msg.value pays the opener's fee) and posts every later epoch
    /// through it. `execFee_` is what the container charges per call; it is paid out of fuel.
    function adopt(IOpener opener, uint256 execFee_) external payable {
        require(msg.sender == deployer, "deployer");
        require(container == address(0), "adopted");
        require(ICircuitNft(cpu).ownerOf(worldId) == address(this), "not the holder");
        if (!opener.isOpened(cpu, worldId)) opener.open{value: msg.value}(cpu, worldId);
        else require(msg.value == 0, "already open");
        (container, execFee) = (opener.accountOf(cpu, worldId), execFee_);
        emit Adopted(container, execFee_);
    }

    /// Buy cells for `team`: bit k of `cells` is cell k. They join the board at the start of the next
    /// epoch, replacing whatever is there. A player stays on one team for the whole season. Half of
    /// what you pay goes to the season's pot, half to running the world.
    function place(uint8 team, uint256 cells) external payable {
        require(team == RED || team == BLUE, "team");
        uint256 n = _popcount(cells);
        require(n > 0 && n <= MAX_CELLS, "cells");
        require(cells & (pendingAlive | pendingBlue) == 0, "taken");
        require(msg.value == n * cellPrice, "price");
        uint8 t = teamOf[season][msg.sender];
        require(t == 0 || t == team, "one team a season");
        teamOf[season][msg.sender] = team;
        pendingAlive |= cells;
        if (team == BLUE) pendingBlue |= cells;
        Season storage s = seasons[season];
        s.placed[team] += n;
        placedBy[season][msg.sender] += n;
        s.pot += msg.value / 2;
        owed += msg.value / 2;
        emit Placed(season, msg.sender, team, cells, n);
    }

    /// Anyone can top up what runs the world.
    function fund() external payable {}

    /// What runs the world: the balance that no pot is owed.
    function fuel() public view returns (uint256) {
        return address(this).balance - owed;
    }

    /// Move the world on: take the finalized result of the running epoch (if any), end the season if it
    /// is over, drop the bought cells and post the next epoch. Pays the caller `keeperTip` when it posts one.
    /// Returns the new epoch's job, or type(uint256).max when nothing is left to run.
    function advance() external returns (uint256 jobId) {
        require(running != 0 || (alive | pendingAlive) != 0, "empty world");
        if (running != 0) {
            uint256 done = running - 1;
            (, bytes memory st) = overclock.result(done); // reverts until final
            (alive, blue) = (_half(st, 0), _half(st, 32));
            running = 0;
            epoch += 1;
            emit EpochEnded(season, epoch, done, _popcount(alive & ~blue), _popcount(blue));
            if (epoch == epochsPerSeason) _endSeason();
        }
        alive |= pendingAlive;
        blue = (blue & ~pendingAlive) | pendingBlue;
        (pendingAlive, pendingBlue) = (0, 0);
        if (alive == 0) return type(uint256).max; // a season just ended on an empty board: nothing to run
        require(fuel() >= jobFee + keeperTip + execFee, "fuel");
        if (container == address(0)) {
            jobId = overclock.postJob{value: jobFee}(cpu, worldId, "", state(), epochBeats, false);
        } else {
            // the circuit's own account posts the job: fund it with the fee, then have it call Overclock
            _pay(container, jobFee);
            bytes memory call_ = abi.encodeCall(IOverclockWorld.postJob, (cpu, worldId, "", state(), epochBeats, false));
            jobId = abi.decode(IContainer(container).execute{value: execFee}(address(overclock), jobFee, call_, 0), (uint256));
        }
        running = jobId + 1;
        emit EpochStarted(season, epoch, jobId);
        if (keeperTip > 0) _pay(msg.sender, keeperTip);
    }

    /// A winning player's share of a finished season's pot.
    function claim(uint32 s) external returns (uint256 amount) {
        Season storage x = seasons[s];
        require(s < season && x.winner != 0, "no winner");
        require(teamOf[s][msg.sender] == x.winner && !claimed[s][msg.sender], "nothing to claim");
        claimed[s][msg.sender] = true;
        amount = x.pot * placedBy[s][msg.sender] / x.placed[x.winner];
        owed -= amount;
        _pay(msg.sender, amount);
        emit Claimed(s, msg.sender, amount);
    }

    /// Overclock calls this when an epoch finalizes. The world moves on in `advance`, which also posts
    /// the next epoch and needs more gas than a callback gets.
    function onOverclockResult(uint256, bytes calldata, bytes calldata) external {}

    // ---------------------------------------------------------------- views

    /// The board as the circuit's packed state: 32 bytes of alive bits, then 32 bytes of blue bits.
    function state() public view returns (bytes memory st) {
        st = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            st[i] = bytes1(uint8(alive >> (8 * i)));
            st[32 + i] = bytes1(uint8(blue >> (8 * i)));
        }
    }

    function scores() external view returns (uint256 red, uint256 blue_) {
        return (_popcount(alive & ~blue), _popcount(blue));
    }

    function seasonInfo(uint32 s)
        external
        view
        returns (uint256 pot, uint256 redPlaced, uint256 bluePlaced, uint8 winner, uint32 red, uint32 blue_)
    {
        Season storage x = seasons[s];
        return (x.pot, x.placed[RED], x.placed[BLUE], x.winner, x.red, x.blue);
    }

    // ---------------------------------------------------------------- internals

    function _endSeason() internal {
        Season storage s = seasons[season];
        (uint256 r, uint256 b) = (_popcount(alive & ~blue), _popcount(blue));
        (s.red, s.blue) = (uint32(r), uint32(b));
        uint8 w = r > b ? RED : b > r ? BLUE : 0;
        if (w != 0 && s.placed[w] == 0) w = 0;
        s.winner = w;
        emit SeasonEnded(season, w, r, b, s.pot);
        _announce(w, r, b, s.pot);
        uint256 rollover = w == 0 ? s.pot : 0;
        season += 1;
        epoch = 0;
        (alive, blue) = (0, 0);
        seasons[season].pot += rollover;
    }

    /// The season's result as a public TapeSend message from the world's container to its own endpoint:
    /// payload "TS" 0x02 0x00 (public) followed by TAP-10 §16 content, with the final board drawn in
    /// squares. Best effort: a hub that refuses never holds the game up.
    function _announce(uint8 w, uint256 r, uint256 b, uint256 pot) internal {
        if (address(hub) == address(0) || container == address(0)) return;
        bytes32 me = bytes32((uint256(block.chainid) << 160) | uint160(container));
        bytes32 ref = keccak256(abi.encodePacked("overclock-world/season", season));
        try hub.send(cpu, worldId, me, ref, seasonMessage(season, w, r, b, pot)) returns (uint256 i) {
            emit Announced(season, i);
        } catch {
            emit AnnounceFailed(season);
        }
    }

    function seasonMessage(uint32 s, uint8 w, uint256 r, uint256 b, uint256 pot) public view returns (bytes memory) {
        bytes memory rows;
        for (uint256 y = 0; y < 16; y++) {
            for (uint256 x = 0; x < 16; x++) {
                uint256 k = y * 16 + x;
                bool on = (alive >> k) & 1 == 1;
                rows = abi.encodePacked(rows, !on ? bytes(unicode"·") : (blue >> k) & 1 == 1 ? bytes(unicode"🟦") : bytes(unicode"🟥"));
            }
            rows = abi.encodePacked(rows, "\\n");
        }
        string memory head = w == RED ? "Red wins" : w == BLUE ? "Blue wins" : "A draw, the pot rolls over";
        return abi.encodePacked(
            hex"54530200",
            '{"v":1,"kind":"message","subject":"Overclock World, season ',
            _dec(s),
            ": ",
            head,
            '","body":"',
            rows,
            "\\nRed ",
            _dec(r),
            " cells, Blue ",
            _dec(b),
            " cells. Pot ",
            _okb(pot),
            ' OKB. Every generation was settled by Overclock on X Layer."}'
        );
    }

    function _dec(uint256 v) internal pure returns (bytes memory out) {
        if (v == 0) return "0";
        while (v != 0) {
            out = abi.encodePacked(bytes1(uint8(48 + v % 10)), out);
            v /= 10;
        }
    }

    // wei as OKB with up to 6 decimals
    function _okb(uint256 wei_) internal pure returns (bytes memory) {
        uint256 micro = wei_ / 1e12;
        bytes memory frac = _dec(micro % 1e6);
        while (frac.length < 6) frac = abi.encodePacked("0", frac);
        return abi.encodePacked(_dec(micro / 1e6), ".", frac);
    }

    // bit k of the result is bit k of the 32 bytes at `off`, in TAP-02 order (byte k/8, bit k%8)
    function _half(bytes memory st, uint256 off) internal pure returns (uint256 v) {
        for (uint256 i = 0; i < 32; i++) v |= uint256(uint8(st[off + i])) << (8 * i);
    }

    function _popcount(uint256 x) internal pure returns (uint256 n) {
        while (x != 0) {
            x &= x - 1;
            n++;
        }
    }

    function _pay(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        require(ok, "pay");
    }

    /// Fuel from anyone, and the container's refunds; kept empty because refunds arrive with 2,300 gas.
    receive() external payable {}

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
