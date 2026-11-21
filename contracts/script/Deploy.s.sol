// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {RupiahRelay} from "../src/RupiahRelay.sol";

/// @notice Deploy RupiahRelay. Use --network celo-sepolia first, mainnet only
///         with Ivan's go-ahead. Env: PRIVATE_KEY (agent wallet, never commit).
///         TODO: fill real mainnet token addresses at deploy time (see README).
contract Deploy is Script {
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant IDRX = 0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22;
    address constant REACTOR = 0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        new RupiahRelay(USDT, IDRX, REACTOR, PERMIT2);
        vm.stopBroadcast();
        // TODO: log relay address + verify on Celoscan
    }
}
