/**
 * ERC-8004 registration — DRAFT, do not run yet.
 *
 * Run only AFTER: (1) the agent wallet is funded with CELO for gas
 * (Ivan's go-ahead), (2) the repo exists and the agentURI metadata JSON is
 * hosted at a public URL. Usage:
 *
 *   cd agent && AGENT_URI=https://<host>/agent.json node src/register-8004.js
 *
 * What it does: calls register(agentURI) on the Celo mainnet Identity
 * Registry FROM the agent EOA (the NFT owner + agentWallet become the agent
 * EOA automatically), reads the agentId from the Registered event, and
 * writes it back into agent-registration.json.
 *
 * NEVER run this from the relay contract and NEVER register twice — one
 * agent, one identity. Registration costs only gas.
 */
import { createPublicClient, createWalletClient, http, parseAbi, parseEventLogs } from "viem";
import { celo } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const REGISTRATION_FILE = join(ROOT, "agent-registration.json");

const ABI = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);

async function main() {
  const uri = process.env.AGENT_URI;
  if (!uri) throw new Error("AGENT_URI env required (public URL of the agent metadata JSON)");
  const pk = process.env.AGENT_PRIVATE_KEY;
  if (!pk) throw new Error("AGENT_PRIVATE_KEY env required (mode 600 .env, never commit)");
  const rpc = process.env.CELO_RPC_URL ?? "https://forno.celo.org";
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
  const publicClient = createPublicClient({ chain: celo, transport: http(rpc) });
  const walletClient = createWalletClient({ chain: celo, transport: http(rpc), account });

  console.log(`Registering agent ${account.address} with URI ${uri}`);
  const hash = await walletClient.writeContract({
    address: REGISTRY,
    abi: ABI,
    functionName: "register",
    args: [uri],
  });
  console.log(`register tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`register tx reverted (${hash})`);
  const logs = parseEventLogs({ abi: ABI, logs: receipt.logs });
  const registered = logs.find((l) => l.eventName === "Registered");
  if (!registered) throw new Error("Registered event not found in receipt");
  const agentId = registered.args.agentId;
  console.log(`agentId: ${agentId}`);
  console.log(`verify: https://8004scan.io/agent/${agentId}`);

  const reg = JSON.parse(readFileSync(REGISTRATION_FILE, "utf8"));
  reg.agentId = agentId.toString();
  reg.status = "REGISTERED";
  reg.agentURI.url = uri;
  writeFileSync(REGISTRATION_FILE, JSON.stringify(reg, null, 2) + "\n");
  console.log(`wrote agentId ${agentId} to agent-registration.json`);
}

main().catch((e) => {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
});
