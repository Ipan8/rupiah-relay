// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {RupiahRelay} from "../src/RupiahRelay.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockToken is ERC20 {
    constructor(string memory n, string memory s) ERC20(n, s) {}
    function mint(address to, uint256 amt) external { _mint(to, amt); }
}

/// @notice Minimal Permit2 stand-in: records approve() allowances and moves
///         tokens via ERC20 transferFrom, like the real singleton does for a
///         taker that approved it. Only the surface RupiahRelay + the reactor
///         touch: approve / allowance / transferFrom.
contract MockPermit2 {
    mapping(address => mapping(address => mapping(address => uint256))) public allowance; // owner -> token -> spender

    function approve(address token, address spender, uint160 amount, uint48 /*expiration*/) external {
        allowance[msg.sender][token][spender] = amount;
    }

    function allowanceOf(address owner_, address token, address spender) external view returns (uint160) {
        return uint160(allowance[owner_][token][spender]);
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        require(allowance[from][token][msg.sender] >= amount, "permit2: allowance");
        allowance[from][token][msg.sender] -= amount;
        IERC20(token).transferFrom(from, to, amount);
    }
}

/// @notice Stand-in for Textile's UniswapX LimitOrderReactor (v2.1.0).
/// @dev execute() takes the real shape — a SignedOrder tuple (bytes order,
///      bytes sig) — where order = abi.encode(sellToken, buyToken,
///      sellAmount, buyAmount, taker). It pulls the sell token from the taker
///      via Permit2 and pays the buy token to the taker, exactly like a
///      maker fill. `fail` forces a revert (reactor-failure path).
contract MockReactor {
    MockPermit2 public immutable permit2;
    address public immutable maker;
    bool public fail;

    constructor(MockPermit2 _permit2, address _maker) {
        permit2 = _permit2;
        maker = _maker;
    }

    function setFail(bool _fail) external { fail = _fail; }

    function execute(bytes calldata order, bytes calldata /*sig*/) external {
        require(!fail, "reactor: forced fail");
        (address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, address taker) =
            abi.decode(order, (address, address, uint256, uint256, address));
        permit2.transferFrom(taker, maker, uint160(sellAmount), sellToken);
        IERC20(buyToken).transfer(taker, buyAmount);
    }
}

/// @notice Contract v2 tests: fee 0.5%, payout, reverts, EIP-1271, pause,
///         refund, rescue, Permit2 approval. Live Textile preview (21 Nov):
///         10 USDT (10e6) -> 18,378,002 atomic IDRX (183,780 IDR).
contract RupiahRelayTest is Test {
    RupiahRelay relay;
    MockToken usdt;
    MockToken idrx;
    MockToken other; // non-core token for rescue tests
    MockPermit2 permit2;
    MockReactor reactor;

    uint256 agentPk = 0xA6E17; // agent EOA private key (test only)
    address agent;
    address client = address(0xC11E7);
    address freelancer = address(0xF1E2);
    address maker = address(0x1A9E2);

    bytes4 constant EIP1271_MAGIC = 0x1626ba7e;
    bytes4 constant EIP1271_FAIL = 0xffffffff;

    // 10 USDT -> 18,378,002 atomic IDRX (live preview 21 Nov 2026)
    uint256 constant SELL = 10e6;
    uint256 constant BUY = 18_378_002;
    uint256 constant FEE = 91_890; // BUY * 50 / 10000 = 91,890.01 -> 91,890
    uint256 constant TO_RECIPIENT = BUY - FEE; // 18,286,112

    function setUp() public {
        agent = vm.addr(agentPk);
        usdt = new MockToken("USD Tether", "USDT");
        idrx = new MockToken("IDRX", "IDRX");
        other = new MockToken("Other", "OTH");
        permit2 = new MockPermit2();
        reactor = new MockReactor(permit2, maker);
        relay = new RupiahRelay(address(usdt), address(idrx), address(reactor), address(permit2));
        relay.transferOwnership(agent);

        usdt.mint(client, 100e6);
        idrx.mint(address(reactor), 1_000_000_000); // reactor holds IDRX to pay out
        vm.prank(client);
        usdt.approve(address(relay), type(uint256).max);
    }

    // -- helpers -------------------------------------------------------

    function _order(uint256 sellAmount, uint256 buyAmount) internal view returns (bytes memory) {
        return abi.encode(address(usdt), address(idrx), sellAmount, buyAmount, address(relay));
    }

    function _swapCalldata(uint256 sellAmount, uint256 buyAmount) internal view returns (bytes memory) {
        return abi.encodeWithSelector(MockReactor.execute.selector, _order(sellAmount, buyAmount), bytes(""));
    }

    function _deposit() internal returns (uint256 id) {
        vm.prank(client);
        id = relay.deposit(freelancer, SELL);
    }

    function _approveReactor() internal {
        vm.prank(agent);
        relay.approveReactor(type(uint160).max, uint48(block.timestamp + 7 days));
    }

    function _pay(uint256 id, uint256 minOut) internal {
        vm.prank(agent);
        relay.swapAndPay(id, _swapCalldata(SELL, BUY), minOut);
    }

    // -- deposit -------------------------------------------------------

    function testDepositRecordsPayout() public {
        uint256 id = _deposit();
        (address r, address d, uint256 amt, uint256 out, bool done, bool refunded) = relay.payouts(id);
        assertEq(r, freelancer);
        assertEq(d, client);
        assertEq(amt, SELL);
        assertEq(out, 0);
        assertFalse(done);
        assertFalse(refunded);
        assertEq(usdt.balanceOf(address(relay)), SELL);
    }

    function testDepositRevertsZeroRecipient() public {
        vm.prank(client);
        vm.expectRevert("no recipient");
        relay.deposit(address(0), SELL);
    }

    function testDepositRevertsZeroAmount() public {
        vm.prank(client);
        vm.expectRevert("no amount");
        relay.deposit(freelancer, 0);
    }

    function testDepositRevertsWhenPaused() public {
        vm.prank(agent);
        relay.pause();
        vm.prank(client);
        vm.expectRevert();
        relay.deposit(freelancer, SELL);
    }

    // -- approveReactor ------------------------------------------------

    function testApproveReactorSetsPermit2Allowance() public {
        _approveReactor();
        assertEq(permit2.allowanceOf(address(relay), address(usdt), address(reactor)), type(uint160).max);
        assertEq(usdt.allowance(address(relay), address(permit2)), type(uint256).max);
    }

    function testApproveReactorRevertsNonOwner() public {
        vm.prank(client);
        vm.expectRevert();
        relay.approveReactor(1000, uint48(block.timestamp + 1 days));
    }

    // -- swapAndPay: happy path ----------------------------------------

    function testSwapAndPayFullFlow() public {
        uint256 id = _deposit();
        _approveReactor();
        _pay(id, BUY); // minOut = exact quote
        assertEq(idrx.balanceOf(freelancer), TO_RECIPIENT);
        assertEq(relay.feesAccrued(), FEE);
        assertEq(idrx.balanceOf(address(relay)), FEE); // only the fee stays
        (,,, uint256 out, bool done, bool refunded) = relay.payouts(id);
        assertEq(out, BUY);
        assertTrue(done);
        assertFalse(refunded);
        assertEq(usdt.balanceOf(maker), SELL); // maker got the USDT
    }

    function testFeeIsExactlyHalfPercent() public {
        uint256 id = _deposit();
        _approveReactor();
        _pay(id, 1);
        // fee = floor(18,378,002 * 50 / 10,000) = 91,890 (0.49999...%)
        assertEq(relay.feesAccrued(), FEE);
        assertEq(idrx.balanceOf(freelancer), TO_RECIPIENT);
    }

    // -- swapAndPay: reverts -------------------------------------------

    function testSwapAndPayRevertsDoublePay() public {
        uint256 id = _deposit();
        _approveReactor();
        _pay(id, 1);
        vm.prank(agent);
        vm.expectRevert("already paid");
        relay.swapAndPay(id, _swapCalldata(SELL, BUY), 1);
    }

    function testSwapAndPayRevertsSlippage() public {
        uint256 id = _deposit();
        _approveReactor();
        vm.prank(agent);
        vm.expectRevert("slippage");
        relay.swapAndPay(id, _swapCalldata(SELL, BUY), BUY + 1);
        // payout survives a reverted swap: still payable with a fresh quote
        (,,,,, bool done) = relay.payouts(id);
        assertFalse(done);
    }

    function testSwapAndPayRevertsReactorFailure() public {
        uint256 id = _deposit();
        _approveReactor();
        reactor.setFail(true);
        vm.prank(agent);
        vm.expectRevert("reactor call failed");
        relay.swapAndPay(id, _swapCalldata(SELL, BUY), 1);
        (,,,,, bool done) = relay.payouts(id);
        assertFalse(done);
    }

    function testSwapAndPayRevertsNonOwner() public {
        uint256 id = _deposit();
        _approveReactor();
        vm.prank(client);
        vm.expectRevert();
        relay.swapAndPay(id, _swapCalldata(SELL, BUY), 1);
    }

    function testSwapAndPayRevertsWhenPaused() public {
        uint256 id = _deposit();
        _approveReactor();
        vm.prank(agent);
        relay.pause();
        vm.prank(agent);
        vm.expectRevert();
        relay.swapAndPay(id, _swapCalldata(SELL, BUY), 1);
    }

    function testSwapAndPayRevertsZeroMinOut() public {
        uint256 id = _deposit();
        _approveReactor();
        vm.prank(agent);
        vm.expectRevert("no minOut");
        relay.swapAndPay(id, _swapCalldata(SELL, BUY), 0);
    }

    function testSwapAndPayRevertsWithoutPermit2Allowance() public {
        // no approveReactor() call: the reactor cannot pull USDT
        uint256 id = _deposit();
        vm.prank(agent);
        vm.expectRevert("reactor call failed");
        relay.swapAndPay(id, _swapCalldata(SELL, BUY), 1);
    }

    // -- withdrawFees (fee-only) ----------------------------------------

    function testWithdrawFeesOnlyFee() public {
        uint256 id = _deposit();
        _approveReactor();
        _pay(id, 1);
        // extra IDRX dust arrives (e.g. a rounding leftover) — it is NOT a fee
        idrx.mint(address(relay), 1234);
        vm.prank(agent);
        relay.withdrawFees(agent);
        assertEq(idrx.balanceOf(agent), FEE);
        assertEq(relay.feesAccrued(), 0);
        assertEq(idrx.balanceOf(address(relay)), 1234); // dust stays
    }

    function testWithdrawFeesRevertsWhenEmpty() public {
        vm.prank(agent);
        vm.expectRevert("no fees");
        relay.withdrawFees(agent);
    }

    function testWithdrawFeesRevertsNonOwner() public {
        uint256 id = _deposit();
        _approveReactor();
        _pay(id, 1);
        vm.prank(client);
        vm.expectRevert();
        relay.withdrawFees(client);
    }

    // -- refund + rescue ------------------------------------------------

    function testRefundPayout() public {
        uint256 id = _deposit();
        uint256 balBefore = usdt.balanceOf(client);
        vm.prank(agent);
        relay.refundPayout(id);
        assertEq(usdt.balanceOf(client), balBefore + SELL);
        (,,,, bool done, bool refunded) = relay.payouts(id);
        assertTrue(done);
        assertTrue(refunded);
    }

    function testRefundRevertsAfterPaid() public {
        uint256 id = _deposit();
        _approveReactor();
        _pay(id, 1);
        vm.prank(agent);
        vm.expectRevert("already paid");
        relay.refundPayout(id);
    }

    function testRefundRevertsDoubleRefund() public {
        uint256 id = _deposit();
        vm.prank(agent);
        relay.refundPayout(id);
        vm.prank(agent);
        vm.expectRevert("already paid");
        relay.refundPayout(id);
    }

    function testSwapAfterRefundReverts() public {
        uint256 id = _deposit();
        vm.prank(agent);
        relay.refundPayout(id);
        vm.prank(agent);
        vm.expectRevert("already paid");
        relay.swapAndPay(id, _swapCalldata(SELL, BUY), 1);
    }

    function testRescueNonCoreToken() public {
        other.mint(address(relay), 500);
        vm.prank(agent);
        relay.rescueToken(address(other), agent, 500);
        assertEq(other.balanceOf(agent), 500);
    }

    function testRescueRevertsCoreToken() public {
        vm.prank(agent);
        vm.expectRevert("core token");
        relay.rescueToken(address(usdt), agent, 1);
        vm.prank(agent);
        vm.expectRevert("core token");
        relay.rescueToken(address(idrx), agent, 1);
    }

    function testRescueRevertsNonOwner() public {
        other.mint(address(relay), 500);
        vm.prank(client);
        vm.expectRevert();
        relay.rescueToken(address(other), client, 500);
    }

    // -- pause ----------------------------------------------------------

    function testPauseUnpauseOnlyOwner() public {
        vm.prank(client);
        vm.expectRevert();
        relay.pause();
        vm.prank(agent);
        relay.pause();
        assertTrue(relay.paused());
        vm.prank(agent);
        relay.unpause();
        assertFalse(relay.paused());
    }

    // -- EIP-1271 --------------------------------------------------------

    function testIsValidSignatureValid() public view {
        bytes32 digest = keccak256("Textile TakerControl test digest");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        assertEq(relay.isValidSignature(digest, sig), EIP1271_MAGIC);
    }

    function testIsValidSignatureWrongSigner() public view {
        bytes32 digest = keccak256("Textile TakerControl test digest");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, digest); // not the owner
        bytes memory sig = abi.encodePacked(r, s, v);
        assertEq(relay.isValidSignature(digest, sig), EIP1271_FAIL);
    }

    function testIsValidSignatureGarbageDoesNotRevert() public view {
        bytes32 digest = keccak256("Textile TakerControl test digest");
        // 65 zero bytes: invalid v — tryRecover returns failure, no revert
        assertEq(relay.isValidSignature(digest, new bytes(65)), EIP1271_FAIL);
        // short signature: also no revert
        assertEq(relay.isValidSignature(digest, new bytes(10)), EIP1271_FAIL);
    }
}
