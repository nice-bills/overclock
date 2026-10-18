// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Measures the gas of a view call too big for estimateGas to search over: call it through
/// measure() with eth_call and read back the gas used and the call's return data.
contract GasProbe {
    function measure(address to, bytes calldata data) external view returns (uint256 gasUsed, bytes memory ret) {
        uint256 g = gasleft();
        bool ok;
        (ok, ret) = to.staticcall(data);
        gasUsed = g - gasleft();
        require(ok, "call failed");
    }
}
