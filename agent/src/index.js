/**
 * Rupiah Relay agent v1 — USD₮ -> IDRX payout via Textile FX (Celo mainnet).
 *
 * Loop (one tick):
 *  1. Find pending payouts: Deposit events on RupiahRelay since the last
 *     checkpoint (state.json) + manual entries in jobs.json.
 *  2. For each pending payout: Textile RFQ preview (POST /rfq/preview).
 *     No quote -> back off (honour retryAfterMs), try again next tick.
 *  3. Firm quote (POST /rfq/request) with taker = the RELAY contract and a
 *     TakerControl EIP-712 proof signed by the agent EOA on behalf of the
 *     relay. Textile verifies the proof on-chain via the relay's EIP-1271
 *     isValidSignature (delegated to the owner = this agent).
 *     - 401 proof_of_control_required -> sign a fresh proof, resend once.
 *     - 502 taker_control_unverifiable -> retry the same proof once.
 *     - proof_of_control_invalid -> fall back to the eip191 text rendering.
 *  4. Check the quote (taker == relay, sellAmount matches, swap target ==
 *     the relay's reactor, quote not expired), then make sure the relay's
 *     Permit2 allowance for the reactor covers the payout
 *     (relay.approveReactor() if short).
 *  5. Send relay.swapAndPay(payoutId, swapCalldata, minIdrxOut). Every tx
 *     the agent sends is tagged with the ERC-8021 attribution suffix via
 *     @celo/attribution-tags (withAttribution) — the tag is required by the
 *     hackathon and cannot be added later. The swap calldata returned by
 *     Textile is passed through verbatim (its own attribution suffix, if
 *     any, survives inside the bytes argument).
 *  6. On success: report the tx to Textile (POST /rfq/{id}/submit, best
 *     effort), verify the payout on-chain, record it in status.json.
 *  Failure paths: no quote / expired quote / reverted swap -> re-quote
 *     once, then mark the payout failed-for-this-tick (never stuck, never
 *     retried blindly). A stale firm quote is cancelled best-effort
 *     (POST /rfq/{id}/cancel) when abandoned.
 *
 * Safety: this agent NEVER deploys, NEVER moves funds except through the
 * relay's own swapAndPay/withdrawFees, NEVER signs anything except the
 * TakerControl proof and its own relay transactions. The private key lives
 * in .env (mode 600) — never in this repo. Run with --dry-run to preview
 * only (no firm request, no tx). Without RELAY_ADDRESS it runs a single
 * Textile connectivity preview and exits.
 */
import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { withAttribution, codeFromRepo } from "@celo/attribution-tags";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = join(__dirname, "..");
const STATE_FILE = join(AGENT_DIR, "state.json");
const STATUS_FILE = join(AGENT_DIR, "status.json");
const JOBS_FILE = join(AGENT_DIR, "jobs.json");

// --- verified mainnet constants (21 Nov 2026) ---------------------------
const CHAIN_ID = 42220;
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"; // USD₮, 6 decimals
const IDRX = "0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22"; // IDRX, 2 decimals
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const TEXTILE_API = process.env.TEXTILE_API_BASE ?? "https://api.textilecredit.com/v2";
const TAKER_CONTROL_DOMAIN = { name: "Textile Taker Control", version: "1", chainId: CHAIN_ID };
const TAKER_CONTROL_TYPES = {
  TakerControl: [
    { name: "taker", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint256" },
  ],
};
// Field names/order follow the spec's "(taker, chainId, nonce, issuedAt)".
// If the venue ever answers proof_of_control_invalid, the agent falls back
// to the eip191 text rendering (exact text from the spec) — see signTakerProof.

const RELAY_ABI = parseAbi([
  "function deposit(address recipient, uint256 usdtIn) returns (uint256)",
  "function swapAndPay(uint256 payoutId, bytes swapCalldata, uint256 minIdrxOut)",
  "function withdrawFees(address to)",
  "function approveReactor(uint160 amount, uint48 expiration)",
  "function refundPayout(uint256 payoutId)",
  "function payouts(uint256) view returns (address recipient, address depositor, uint256 usdtIn, uint256 idrxOut, bool done, bool refunded)",
  "function nextPayoutId() view returns (uint256)",
  "function reactor() view returns (address)",
  "function permit2() view returns (address)",
  "function feesAccrued() view returns (uint256)",
  "function paused() view returns (bool)",
  "event Deposit(uint256 indexed payoutId, address indexed from, address indexed recipient, uint256 usdtIn)",
]);
const PERMIT2_ABI = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
]);

// --- config --------------------------------------------------------------
const argv = new Set(process.argv.slice(2));
const ONCE = argv.has("--once");
const DRY_RUN = argv.has("--dry-run");
const POLL_MS = Number(process.env.POLL_INTERVAL_MS ?? 60_000);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? 50); // 0.5% under quote
const APPROVAL_DAYS = Number(process.env.APPROVAL_DAYS ?? 7);
const PREVIEW_AMOUNT = process.env.DRY_RUN_SELL_AMOUNT ?? "10000000"; // 10 USDT

function env(name, required = false) {
  const v = process.env[name];
  if (required && !v) throw new Error(`missing env ${name} (see .env.example)`);
  return v ?? "";
}

// Attribution tag: prefer the Loops-issued code; otherwise derive it from
// the repo slug exactly the way the Celo Builders platform does
// (codeFromRepo — sha256(slug) first 6 bytes, "celo_" prefix). A derived
// code must be confirmed against the Loops registration before mainnet use.
function resolveAttributionTag() {
  const tag = env("ATTRIBUTION_TAG");
  if (tag) return { tag, derived: false };
  const repo = env("REPO_SLUG") || "Ipan8/rupiah-relay";
  const derived = codeFromRepo(repo);
  console.warn(`[warn] ATTRIBUTION_TAG unset — using code derived from repo slug ${repo}: ${derived}. Confirm it matches the Loops registration.`);
  return { tag: derived, derived: true };
}

// --- small helpers -------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => Date.now();
const hexNonce = () => `0x${randomBytes(32).toString("hex")}`;

function readJson(path, fallback) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch (e) {
    console.warn(`[warn] cannot read ${path}: ${e.message}`);
    return fallback;
  }
}
function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

async function textile(path, { method = "GET", body, claimToken } = {}) {
  const headers = { "content-type": "application/json" };
  const apiKey = env("TEXTILE_API_KEY");
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (claimToken) headers["x-rfq-claim"] = claimToken;
  const res = await fetch(`${TEXTILE_API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`textile ${method} ${path} -> HTTP ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// --- taker control proof -------------------------------------------------
// The taker is the RELAY (a contract). The proof is an EIP-712 signature
// over the TakerControl struct, signed by the agent EOA (the relay owner);
// Textile verifies it via relay.isValidSignature (EIP-1271).
async function signTakerProofEip712(account, taker) {
  const nonce = hexNonce();
  const issuedAt = nowMs();
  const signature = await account.signTypedData({
    domain: TAKER_CONTROL_DOMAIN,
    types: TAKER_CONTROL_TYPES,
    primaryType: "TakerControl",
    message: { taker, chainId: BigInt(CHAIN_ID), nonce, issuedAt: BigInt(issuedAt) },
  });
  return { nonce, issuedAt, signature };
}

// Exact eip191 text rendering from the Textile spec (address + nonce lowercase).
function takerControlText(taker, nonce, issuedAt) {
  return [
    "Textile Taker Control",
    "Version: 1",
    "",
    "Sign to prove you control this wallet so Textile can request a firm",
    "quote for it. This does not approve any transfer, trade or allowance.",
    "",
    `Wallet: ${taker.toLowerCase()}`,
    `Chain: ${CHAIN_ID}`,
    `Nonce: ${nonce.toLowerCase()}`,
    `Issued at: ${issuedAt}`,
  ].join("\n");
}
async function signTakerProofEip191(account, taker) {
  const nonce = hexNonce();
  const issuedAt = nowMs();
  const signature = await account.signMessage({ message: takerControlText(taker, nonce, issuedAt) });
  return { nonce, issuedAt, signature, scheme: "eip191" };
}

// --- Textile RFQ ---------------------------------------------------------
async function previewQuote(sellAmount) {
  const res = await textile("/rfq/preview", {
    method: "POST",
    body: { chainId: CHAIN_ID, sellToken: USDT, buyToken: IDRX, sellAmount: String(sellAmount) },
  });
  return res.data;
}

async function requestFirmQuote(account, taker, sellAmount, attribution) {
  const base = { chainId: CHAIN_ID, sellToken: USDT, buyToken: IDRX, sellAmount: String(sellAmount), taker };
  if (attribution) {
    base.includeAttribution = true;
    base.builderCodes = [attribution];
  }
  // Attempt 1: EIP-712 proof.
  let proof = await signTakerProofEip712(account, taker);
  try {
    return await textile("/rfq/request", { method: "POST", body: { ...base, takerProof: proof } });
  } catch (e) {
    const reason = e.body?.details?.reason ?? e.body?.error?.reason ?? "";
    if (e.status === 401 && reason === "proof_of_control_required") {
      console.log("[rfq] proof required — signing fresh and resending");
      proof = await signTakerProofEip712(account, taker);
      return await textile("/rfq/request", { method: "POST", body: { ...base, takerProof: proof } });
    }
    if (e.status === 502 && reason === "taker_control_unverifiable") {
      console.log("[rfq] EIP-1271 read failed at venue — retrying same proof once");
      await sleep(2000);
      return await textile("/rfq/request", { method: "POST", body: { ...base, takerProof: proof } });
    }
    if (e.status === 401 && (reason === "proof_of_control_invalid" || reason === "proof_of_control_stale")) {
      console.log("[rfq] EIP-712 proof rejected — falling back to eip191 text rendering");
      proof = await signTakerProofEip191(account, taker);
      return await textile("/rfq/request", { method: "POST", body: { ...base, takerProof: proof } });
    }
    throw e;
  }
}

async function cancelQuote(rfqId, claimToken) {
  if (!rfqId) return;
  try {
    await textile(`/rfq/${rfqId}/cancel`, { method: "POST", claimToken });
    console.log(`[rfq] cancelled stale quote ${rfqId}`);
  } catch (e) {
    console.warn(`[warn] cancel ${rfqId} failed: ${e.message}`);
  }
}

async function submitTx(rfqId, claimToken, txHash) {
  if (!rfqId) return;
  try {
    await textile(`/rfq/${rfqId}/submit`, { method: "POST", body: { txHash }, claimToken });
    console.log(`[rfq] reported settlement tx ${txHash} for ${rfqId}`);
  } catch (e) {
    console.warn(`[warn] submit tx ${txHash} failed: ${e.message}`);
  }
}

// --- agent ---------------------------------------------------------------
class Agent {
  constructor(ctx) {
    Object.assign(this, ctx);
    this.cooldowns = new Map(); // payoutId -> nextRetryAt ms
    this.status = {
      updatedAt: new Date().toISOString(),
      relay: this.relayAddress,
      chainId: CHAIN_ID,
      attributionTag: this.attributionTag,
      attributionDerived: this.attributionDerived,
      mode: DRY_RUN ? "dry-run" : "live",
      pending: [],
      completed: readJson(STATUS_FILE, {}).completed ?? [],
      failed: readJson(STATUS_FILE, {}).failed ?? [],
    };
  }

  async pendingPayouts() {
    const pending = new Map();
    const state = readJson(STATE_FILE, {});
    let fromBlock = state.lastBlock ? BigInt(state.lastBlock) : null;
    const latest = await this.publicClient.getBlockNumber();
    if (fromBlock === null) {
      // First run: only future deposits (pre-existing ones go via jobs.json).
      fromBlock = latest;
      console.log(`[agent] first run — watching deposits from block ${latest}`);
    }
    if (fromBlock <= latest) {
      const logs = await this.publicClient.getLogs({
        address: this.relayAddress,
        event: parseAbi(["event Deposit(uint256 indexed payoutId, address indexed from, address indexed recipient, uint256 usdtIn)"])[0],
        fromBlock,
        toBlock: latest,
      });
      for (const log of logs) pending.set(Number(log.args.payoutId), { payoutId: Number(log.args.payoutId), recipient: log.args.recipient, usdtIn: log.args.usdtIn });
      writeJson(STATE_FILE, { ...state, lastBlock: (latest + 1n).toString() });
    }
    // Manual queue (backfill + test payouts).
    for (const job of readJson(JOBS_FILE, [])) {
      if (job.payoutId === undefined) continue;
      pending.set(Number(job.payoutId), { payoutId: Number(job.payoutId), recipient: job.recipient, usdtIn: job.usdtIn ? BigInt(job.usdtIn) : undefined });
    }
    // Verify on-chain state; drop done/refunded.
    const out = [];
    for (const p of [...pending.values()].sort((a, b) => a.payoutId - b.payoutId)) {
      const [recipient, , usdtIn, , done, refunded] = await this.publicClient.readContract({
        address: this.relayAddress, abi: RELAY_ABI, functionName: "payouts", args: [BigInt(p.payoutId)],
      });
      if (done || refunded) continue;
      out.push({ payoutId: p.payoutId, recipient: p.recipient ?? recipient, usdtIn: p.usdtIn ?? usdtIn });
    }
    return out;
  }

  async ensureAllowance(usdtIn) {
    const reactor = await this.publicClient.readContract({ address: this.relayAddress, abi: RELAY_ABI, functionName: "reactor" });
    const [amount, expiration] = await this.publicClient.readContract({
      address: PERMIT2, abi: PERMIT2_ABI, functionName: "allowance",
      args: [this.relayAddress, USDT, reactor],
    });
    const needUntil = BigInt(Math.floor(nowMs() / 1000) + 3600); // cover 1h
    if (amount >= usdtIn && expiration > needUntil) return reactor;
    console.log(`[agent] Permit2 allowance short (${amount} < ${usdtIn} or expiring) — calling approveReactor`);
    const hash = await this.walletClient.writeContract({
      address: this.relayAddress, abi: RELAY_ABI, functionName: "approveReactor",
      args: [2n ** 160n - 1n, Math.floor(nowMs() / 1000) + APPROVAL_DAYS * 86400],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[agent] approveReactor mined: ${hash}`);
    return reactor;
  }

  async executePayout(p) {
    const tag = `[payout ${p.payoutId}]`;
    if ((this.cooldowns.get(p.payoutId) ?? 0) > nowMs()) {
      console.log(`${tag} cooling down until ${new Date(this.cooldowns.get(p.payoutId)).toISOString()}`);
      return;
    }
    // 1. Preview.
    const preview = await previewQuote(p.usdtIn);
    if (preview.status !== "preview") {
      const waitMs = preview.retryAfterMs ?? 60_000;
      console.log(`${tag} no quote (${preview.reason ?? "?"}) — retry in ${Math.round(waitMs / 1000)}s`);
      this.cooldowns.set(p.payoutId, nowMs() + waitMs);
      this.recordFailed(p, `no_quote: ${preview.reason ?? "?"}`);
      return;
    }
    console.log(`${tag} preview: ${p.usdtIn} USDT -> ${preview.buyAmount} IDRX (fee ${preview.feeAmount}, rate ${preview.rateRay})`);
    if (DRY_RUN) {
      console.log(`${tag} dry-run — stopping before firm request`);
      return;
    }
    // 2. Firm quote (taker = relay).
    let firm;
    try {
      firm = await requestFirmQuote(this.account, this.relayAddress, p.usdtIn, this.attributionTag);
    } catch (e) {
      console.error(`${tag} firm quote failed: ${e.message} ${JSON.stringify(e.body ?? {})}`);
      this.recordFailed(p, `firm_quote: ${e.message}`);
      return;
    }
    const rfqId = firm.data?.id ?? firm.data?.rfqId ?? null;
    const claimToken = firm.data?.claimToken ?? null;
    const quote = firm.data?.quote;
    const swap = firm.data?.transactions?.swap;
    if (!quote || !swap) {
      console.error(`${tag} firm quote missing quote/transactions — abandoning`);
      await cancelQuote(rfqId, claimToken);
      this.recordFailed(p, "firm_quote: missing quote/transactions");
      return;
    }
    // 3. Validate the quote before spending gas.
    if (quote.taker?.toLowerCase() !== this.relayAddress.toLowerCase()) {
      console.error(`${tag} quote taker mismatch (${quote.taker}) — abandoning`);
      await cancelQuote(rfqId, claimToken);
      this.recordFailed(p, "quote taker mismatch");
      return;
    }
    if (BigInt(quote.sellAmount) !== p.usdtIn) {
      console.error(`${tag} quote sellAmount mismatch — abandoning`);
      await cancelQuote(rfqId, claimToken);
      this.recordFailed(p, "quote sellAmount mismatch");
      return;
    }
    if (swap.to?.toLowerCase() !== this.reactorAddress.toLowerCase()) {
      console.error(`${tag} swap target ${swap.to} is not the relay reactor ${this.reactorAddress} (recall/executor route unsupported) — abandoning`);
      await cancelQuote(rfqId, claimToken);
      this.recordFailed(p, "swap target is not the reactor");
      return;
    }
    if (swap.value !== "0") {
      console.error(`${tag} swap value is not 0 — abandoning`);
      await cancelQuote(rfqId, claimToken);
      this.recordFailed(p, "swap value != 0");
      return;
    }
    if (quote.expiresAt && Date.parse(quote.expiresAt) < nowMs() + 30_000) {
      console.log(`${tag} quote already expired/near-expiry — re-quoting next tick`);
      await cancelQuote(rfqId, claimToken);
      this.recordFailed(p, "quote expired");
      return;
    }
    const minIdrxOut = (BigInt(quote.buyAmount) * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
    console.log(`${tag} firm quote ${rfqId}: buy ${quote.buyAmount} IDRX, minOut ${minIdrxOut}, expires ${quote.expiresAt}`);
    // 4. Allowance, then swapAndPay.
    try {
      await this.ensureAllowance(p.usdtIn);
      const hash = await this.walletClient.writeContract({
        address: this.relayAddress, abi: RELAY_ABI, functionName: "swapAndPay",
        args: [BigInt(p.payoutId), swap.data, minIdrxOut],
      });
      console.log(`${tag} swapAndPay sent: ${hash}`);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`swapAndPay tx reverted (${hash})`);
      await submitTx(rfqId, claimToken, hash);
      const [, , , idrxOut] = await this.publicClient.readContract({
        address: this.relayAddress, abi: RELAY_ABI, functionName: "payouts", args: [BigInt(p.payoutId)],
      });
      const fee = (idrxOut * 50n) / 10_000n;
      console.log(`${tag} DONE: ${idrxOut} IDRX paid (fee ${fee}), tx ${hash}`);
      this.status.completed.unshift({ payoutId: p.payoutId, recipient: p.recipient, usdtIn: p.usdtIn.toString(), idrxOut: idrxOut.toString(), fee: fee.toString(), txHash: hash, rfqId, at: new Date().toISOString() });
      this.status.completed = this.status.completed.slice(0, 50);
    } catch (e) {
      console.error(`${tag} swap failed: ${e.message} — will re-quote next tick`);
      await cancelQuote(rfqId, claimToken);
      this.recordFailed(p, `swap: ${e.message}`);
    }
  }

  recordFailed(p, reason) {
    this.status.failed.unshift({ payoutId: p.payoutId, reason, at: new Date().toISOString() });
    this.status.failed = this.status.failed.slice(0, 50);
  }

  async tick() {
    this.status.updatedAt = new Date().toISOString();
    this.reactorAddress = await this.publicClient.readContract({ address: this.relayAddress, abi: RELAY_ABI, functionName: "reactor" });
    const pending = await this.pendingPayouts();
    console.log(`[tick ${this.status.updatedAt}] ${pending.length} pending payout(s)`);
    this.status.pending = pending.map((p) => ({ payoutId: p.payoutId, recipient: p.recipient, usdtIn: p.usdtIn.toString() }));
    for (const p of pending) {
      try {
        await this.executePayout(p);
      } catch (e) {
        console.error(`[payout ${p.payoutId}] unexpected error: ${e.message}`);
        this.recordFailed(p, `unexpected: ${e.message}`);
      }
    }
    writeJson(STATUS_FILE, this.status);
  }
}

// --- main ----------------------------------------------------------------
async function main() {
  const rpc = env("CELO_RPC_URL") || "https://forno.celo.org";
  const relayAddress = env("RELAY_ADDRESS");
  const { tag, derived } = resolveAttributionTag();
  console.log(`Rupiah Relay agent — chain ${CHAIN_ID}, rpc ${rpc}`);
  console.log(`Attribution tag: ${tag}${derived ? " (derived — confirm vs Loops)" : ""}`);
  if (!relayAddress) {
    // No relay yet: connectivity preview only, then exit.
    console.log("[preview-only] RELAY_ADDRESS unset — checking Textile connectivity");
    const preview = await previewQuote(PREVIEW_AMOUNT);
    console.log(`[preview-only] ${PREVIEW_AMOUNT} USDT -> ${preview.buyAmount ?? "?"} IDRX (status ${preview.status}, reason ${preview.reason ?? "-"})`);
    return;
  }
  const pk = env("AGENT_PRIVATE_KEY", true);
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  const publicClient = createPublicClient({ chain: celo, transport: http(rpc) });
  let walletClient = createWalletClient({ chain: celo, transport: http(rpc), account });
  walletClient = walletClient.extend(withAttribution(tag));
  console.log(`Agent EOA: ${account.address} (relay owner)`);
  console.log(`Relay: ${relayAddress} ${DRY_RUN ? "(dry-run: preview only)" : ""}`);
  const agent = new Agent({ publicClient, walletClient, account, relayAddress, attributionTag: tag, attributionDerived: derived });
  if (ONCE || DRY_RUN) {
    await agent.tick();
    return;
  }
  for (;;) {
    try {
      await agent.tick();
    } catch (e) {
      console.error(`[tick] error: ${e.message}`);
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
});
