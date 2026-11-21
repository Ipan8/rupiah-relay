// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @notice Minimal Permit2 interface (Uniswap Permit2 singleton).
/// @dev Only the functions RupiahRelay needs: approve (taker -> reactor
///      allowance) and the allowance view. The reactor itself pulls tokens
///      via Permit2.transferFrom — the relay never calls transferFrom.
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
    function allowance(address owner_, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}

/// @title RupiahRelay — escrow USD₮ -> swap via Textile FX -> payout IDRX.
/// @notice Agent (owner) executes the swap with RFQ calldata from Textile.
///         Fee 0.5% stays in the contract, tracked in `feesAccrued`; the
///         agent withdraws ONLY the accrued fee to fund its own gas.
/// @dev Taker model (verified vs Textile RFQ API v2, fx-docs.textilecredit.com):
///      the RELAY is the taker. The agent EOA signs the TakerControl EIP-712
///      proof on behalf of the relay; Textile verifies it on-chain via this
///      contract's EIP-1271 `isValidSignature`, which delegates to the owner.
///      EIP-712 domain: { name: "Textile Taker Control", version: "1",
///      chainId: 42220 }, type TakerControl(taker, chainId, nonce, issuedAt).
///      Settlement: UniswapX LimitOrderReactor v2.1.0, which pulls the input
///      token from the taker through Permit2 — hence `approveReactor()`.
contract RupiahRelay is Ownable, ReentrancyGuard, Pausable, IERC1271 {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdt; // USD₮ 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e
    IERC20 public immutable idrx; // IDRX 0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22
    address public immutable reactor; // Textile LimitOrderReactor 0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3
    address public immutable permit2; // Permit2 singleton 0x000000000022D473030F116dDEE9F6B43aC78BA3

    uint256 public constant FEE_BPS = 50; // 0.5%
    uint256 public constant BPS = 10_000;

    /// @notice IDRX fee accrued from completed payouts, not yet withdrawn.
    uint256 public feesAccrued;

    struct Payout {
        address recipient;
        address depositor;
        uint256 usdtIn;
        uint256 idrxOut;
        bool done;
        bool refunded;
    }

    mapping(uint256 => Payout) public payouts;
    uint256 public nextPayoutId;

    event Deposit(uint256 indexed payoutId, address indexed from, address indexed recipient, uint256 usdtIn);
    event Paid(uint256 indexed payoutId, address indexed recipient, uint256 idrxOut, uint256 fee);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event ReactorApproved(address indexed spender, uint160 amount, uint48 expiration);
    event PayoutRefunded(uint256 indexed payoutId, address indexed depositor, uint256 usdtIn);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    constructor(address _usdt, address _idrx, address _reactor, address _permit2) Ownable(msg.sender) {
        require(_usdt != address(0) && _idrx != address(0), "zero token");
        require(_reactor != address(0) && _permit2 != address(0), "zero addr");
        usdt = IERC20(_usdt);
        idrx = IERC20(_idrx);
        reactor = _reactor;
        permit2 = _permit2;
    }

    // ------------------------------------------------------------------
    // EIP-1271 — Textile taker-control verification
    // ------------------------------------------------------------------

    /// @notice EIP-1271: valid iff `signature` over `hash` recovers to the
    ///         owner (the agent EOA). Textile calls this to verify the
    ///         TakerControl proof when the taker is this contract.
    /// @dev Uses tryRecover so a malformed signature returns the failure
    ///      value instead of reverting (a revert would surface at Textile
    ///      as taker_control_unverifiable / 502).
    function isValidSignature(bytes32 hash, bytes memory signature)
        external
        view
        override
        returns (bytes4 magicValue)
    {
        (address signer,,) = ECDSA.tryRecover(hash, signature);
        return signer == owner() ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    // ------------------------------------------------------------------
    // Client flow
    // ------------------------------------------------------------------

    /// @notice Client deposits USD₮ for a named recipient. Agent picks it up offchain.
    function deposit(address recipient, uint256 usdtIn)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 payoutId)
    {
        require(recipient != address(0), "no recipient");
        require(usdtIn > 0, "no amount");
        payoutId = nextPayoutId++;
        payouts[payoutId] = Payout({
            recipient: recipient,
            depositor: msg.sender,
            usdtIn: usdtIn,
            idrxOut: 0,
            done: false,
            refunded: false
        });
        usdt.safeTransferFrom(msg.sender, address(this), usdtIn);
        emit Deposit(payoutId, msg.sender, recipient, usdtIn);
    }

    // ------------------------------------------------------------------
    // Agent flow
    // ------------------------------------------------------------------

    /// @notice Allow the Textile reactor to pull USD₮ via Permit2.
    /// @dev Two hops: (1) relay approves Permit2 to move its USD₮;
    ///      (2) Permit2 records the reactor allowance. Call again to top up
    ///      or extend — the agent checks allowance before each payout.
    function approveReactor(uint160 amount, uint48 expiration) external nonReentrant onlyOwner {
        emit ReactorApproved(reactor, amount, expiration);
        usdt.forceApprove(permit2, type(uint256).max);
        IPermit2(permit2).approve(address(usdt), reactor, amount, expiration);
    }

    /// @notice Agent-only: run the Textile swap (calldata from the firm RFQ
    ///         quote, with minOut enforced on the received amount), then pay
    ///         IDRX to the recipient minus the 0.5% fee.
    /// @dev swapCalldata is the exact swap tx data the RFQ API returns
    ///      (target = reactor). The reactor pulls USD₮ from this contract
    ///      through Permit2 — call approveReactor() first if allowance is
    ///      short. The payout is marked done BEFORE the external call, but
    ///      any revert (reactor failure, slippage, transfer failure) rolls
    ///      the whole tx back, so a failed swap never burns a payout.
    function swapAndPay(uint256 payoutId, bytes calldata swapCalldata, uint256 minIdrxOut)
        external
        nonReentrant
        onlyOwner
        whenNotPaused
    {
        require(minIdrxOut > 0, "no minOut");
        Payout storage p = payouts[payoutId];
        require(!p.done, "already paid");
        require(!p.refunded, "refunded");
        p.done = true;

        uint256 idrxBefore = idrx.balanceOf(address(this));
        (bool ok,) = reactor.call(swapCalldata);
        require(ok, "reactor call failed");
        uint256 idrxReceived = idrx.balanceOf(address(this)) - idrxBefore;
        require(idrxReceived >= minIdrxOut, "slippage");

        uint256 fee = (idrxReceived * FEE_BPS) / BPS;
        uint256 toRecipient = idrxReceived - fee;
        p.idrxOut = idrxReceived;
        feesAccrued += fee;
        // NOTE: `Paid` is emitted after the reactor call by necessity —
        // idrxReceived is only known after the swap. The function is
        // nonReentrant-guarded, so the reentrancy this lint warns about
        // cannot reorder or fabricate this log (forge lint false positive).
        emit Paid(payoutId, p.recipient, idrxReceived, fee);
        idrx.safeTransfer(p.recipient, toRecipient);
    }

    /// @notice Agent withdraws ONLY the accrued fee (fee-only — leftover
    ///         IDRX from dust or failed payouts stays in the contract).
    function withdrawFees(address to) external onlyOwner {
        uint256 amount = feesAccrued;
        require(amount > 0, "no fees");
        require(to != address(0), "no recipient");
        feesAccrued = 0;
        idrx.safeTransfer(to, amount);
        emit FeesWithdrawn(to, amount);
    }

    /// @notice Agent-only: refund a payout that can never complete (e.g. no
    ///         IDRX liquidity for days). USD₮ goes back to the depositor.
    function refundPayout(uint256 payoutId) external nonReentrant onlyOwner {
        Payout storage p = payouts[payoutId];
        require(!p.done, "already paid");
        require(!p.refunded, "refunded");
        p.done = true;
        p.refunded = true;
        usdt.safeTransfer(p.depositor, p.usdtIn);
        emit PayoutRefunded(payoutId, p.depositor, p.usdtIn);
    }

    /// @notice Agent-only: rescue tokens that are NOT the core pair (e.g. a
    ///         client sent the wrong token). USD₮/IDRX have their own paths
    ///         (refundPayout / withdrawFees) and can never be rescued.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(token != address(usdt) && token != address(idrx), "core token");
        require(to != address(0), "no recipient");
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    // ------------------------------------------------------------------
    // Circuit breaker
    // ------------------------------------------------------------------

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
