# Rupiah Relay — Celo "Agents Open for Business" Hackathon

**Track utama: Stablecoin Corridors** (hadiah 1st $1.000 / 2nd $600 / 3rd $400).
Stretch: Altana Agent Wallets (satu proyek boleh menang di max 2 track).

**Satu kalimat:** agent yang menerima USD₮ dari klien, menukarnya ke IDRX di Textile FX,
dan membayar freelancer Indonesia — dengan fee 0,5% yang membiayai gas agent itu sendiri.

## Live demo

**Demo (halaman status): https://rupiah-relay-ipan12.vercel.app** — alamat relay Celo Sepolia
(`0x7eF98a8914B6b9771B3746065a94c54F29D46610`) + 5 tx bukti konversi 24 Nov 2026:
deposit 10 mock USDT → penerima 18.286.112 atomic IDRX, fee 91.890 (0,5%), EIP-1271 valid.
Bukti lengkap: [`agent/sepolia-proof.json`](agent/sepolia-proof.json) (+ [`agent/status-sepolia.json`](agent/status-sepolia.json)).

## Kenapa konsep ini

- **Job beneran, buat orang beneran.** Brief hackathon: "ship an agent that does a real job
  for a person or business on Celo mainnet, and pays for what that job needs." Job-nya:
  freelancer Indonesia dibayar klien dalam USD₮ tapi butuh rupiah (IDRX). Halaman resmi
  hackathon sendiri mencontohkan ide ini ("Freelancer payouts in local currency").
- **Koridornya koridor Ivan.** IDRX (Rupiah) adalah salah satu koridor resmi track ini
  (USD₮ ↔ cNGN, IDRX, wARS, wBRL, wMXN, wCOP). Ivan orang Indonesia — dia dan
  lingkarannya adalah pengguna pertamanya.
- **Pas sama keahlian Ivan.** LP / DLMM / FX / swap autopilot (Sol Warlock, Meridian).
  Yang ini bukan trading — ini FX routing + payout otomatis, skill yang sama.
- **Self-sustaining (bukan dari deposit gede).** Fee 0,5% per konversi masuk ke wallet
  agent; gas Celo sub-cent per tx, jadi satu konversi $10 (fee $0,05) membiayai ~5–50 tx.
  Agent bayar kebutuhannya sendiri dari revenue, sesuai brief.
- **Syarat track-nya konkret dan tercapai:** ≥1 konversi Textile FX ber-tag di mainnet
  dalam koridor resmi + pembayaran IDRX sampai ke penerima di luar tim + identitas ERC-8004.

## Status build (21 Nov 2026 — contract v2 + agent v1 ✅)

| Bagian | Status |
|---|---|
| `RupiahRelay.sol` v2 | ✅ `forge build` bersih, `forge test` **29/29 pass** (mock reactor + MockPermit2). Fee 0,5% tepat, payout, semua revert, EIP-1271 valid/invalid, pause, refund, rescue. |
| Agent viem v1 (`agent/src/index.js`) | ✅ `npm install` + `node --check` OK. Poll Deposit → preview → firm RFQ → swapAndPay → status.json. |
| Textile RFQ live | ✅ Preview live 21 Nov: **10 USDT → 18.378.002 atomic IDRX (183.780 IDR)**, fee ~2 bps, depth ~54.636 USDT. Agent preview-only run mengulang angka yang sama persis. |
| ERC-8004 prep | ✅ Signatures exact dari repo publik `erc-8004/erc-8004-contracts` @ `b9e466c2` (ABI lengkap di `research/`). `agent-registration.json` + draft `agent/src/register-8004.js` siap — registrasi sendiri HANYA setelah wallet didanai. |
| Attribution tag | ✅ Tag Loops resmi: **`celo_e8a3571fc9bd`** (enrolment 21 Nov 2026, akun GitHub Ipan8). Agent pakai tag ini via `ATTRIBUTION_TAG` di `.env` (lihat `.env.example`); fallback `codeFromRepo` hanya kalau env kosong. |
| Deploy / funding / registrasi | ⏳ Menunggu Ivan: repo GitHub, registrasi Loops, dana 5 CELO + 25 USD₮, nama + wallet penerima. |

## Desain singkat

```
Klien --USD₮--> [RupiahRelay.sol] --(agent: preview + firm RFQ, taker = relay)-->
  Textile LimitOrderReactor swap USD₮ -> IDRX --IDRX--> Freelancer (penerima)
  Fee 0,5% tercatat di feesAccrued -> withdrawFees (fee-only) -> wallet agent
  TakerControl EIP-712 ditandatangani agent EOA -> Textile verifikasi on-chain
  via relay.isValidSignature (EIP-1271, didelegasikan ke owner)
  Reactor narik USD₮ via Permit2 (approveReactor) — bukan transfer langsung
  Semua tx agent ditempeli attribution tag ERC-8021 (@celo/attribution-tags)
  Agent terdaftar di ERC-8004 (wajib semua track)
```

Detail penuh: `DESIGN.md`.

## Deadline (sudah dikonversi ke WIB, pakai wib.py)

| Momen | Waktu |
|---|---|
| Build dibuka | Jum 20 Nov 2026, 21:00 WIB (sudah jalan) |
| Livestream Self (Agent Vault + Agent ID) | Sel 24 Nov 2026, 21:00 WIB |
| Livestream Altana | Rab 25 Nov 2026, 21:00 WIB |
| Livestream Stablecoin Corridors | Sel 1 Des 2026, 21:00 WIB |
| AskBots review ronde 2 | Jum 4 Des 2026 |
| **Submissions close** | **Sen 7 Des 2026, 16:00 WIB** (09:00 GMT) |
| Winners diumumkan | Jum 11 Des 2026 |

## Kebutuhan dana mainnet (MINIMUM, keputusan Ivan — jangan diasumsikan)

Harga live 21 Nov 2026 ~06:55 WIB (Kraken): **CELO ≈ $0,0545**, USDT ≈ $0,998.

| Kebutuhan | Jumlah | Keterangan |
|---|---|---|
| CELO buat gas | **5 CELO ≈ $0,27** | Puluhan tx (deploy kontrak, registrasi ERC-8004, konversi, payout). Gas Celo sub-cent per tx. |
| USD₮ modal kerja | **$25 USD₮** | 2–3 konversi demo @ $10. Ini BUKAN hangus — USD₮ mengalir jadi IDRX yang dibayar ke penerima. Yang hilang cuma spread FX Textile (±0,1–1%, harga dari maker RFQ) + fee agent 0,5% (masuk wallet agent, bukan hilang). |
| **Total out-of-pocket awal** | **≈ $25,30** | — |
| x402 facilitator | $0 (100 kredit settlement gratis buat akun baru mainnet) | Setelah itu gas at cost + 0,3% per settlement. |

**Cara dapatnya (langkah Ivan):** beli CELO + USDT di Binance → withdraw ke jaringan Celo
ke wallet agent `0xa9cB01C54930511202fd75734bcdDe8FbE9B2453`.
⚠️ **Verifikasi saat build:** pastikan USDT yang masuk Celo adalah USD₮
`0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` (yang dipakai Textile). Kalau Binance
mengirim varian USDT lain, swap dulu ke USD₮ di DEX Celo (mis. Ubeswap) — dicek di fase build.

**Yang TIDAK butuh uang Ivan:** pendaftaran hackathon (gratis), registrasi ERC-8004 (cuma gas),
attribution tag (gratis, didapat saat registrasi), testnet Celo Sepolia (faucet gratis),
AskBots review (gratis), 3 bulan Agent Vault Plus + Chainstack Growth (perk gratis).

## Langkah Ivan (yang tersisa cuma ini)

1. **Buat repo GitHub publik** (nama saran: `rupiah-relay`) — GitHub App tidak bisa
   create repo, jadi ini langkah Ivan di web (github.com/new, Public, tanpa README).
2. **Daftar di Loops House** — https://www.loops.house/agents-open-for-business
   (akun + proyek: nama, repo publik, handle Telegram) → dapat **attribution tag**
   ERC-8021 (`celo_...`). Tag ini WAJIB ditempel di semua tx sebelum tx pertama dikirim.
3. **Follow @Celo + @CeloDevs di X** (dari HP).
4. **Tentukan penerima IDRX pertama di luar tim** — orang Indonesia beneran dengan alamat
   Celo, yang mau menerima IDRX. Syarat track: pembayaran stablecoin lokal harus sampai
   ke penerima di luar tim (self-payment / arbitrage tidak dihitung).
5. **Danai wallet agent** (alamat di atas): 5 CELO + 25 USD₮ di Celo mainnet.
6. **(Opsional, stretch)** Self Agent ID — butuh paspor Ivan (KYC Self). Bukan syarat
   track Corridors; hanya kalau mau masuk track Self Agent ID / Agent Vault.

## Rencana build hari-per-hari (21 Nov → 7 Des)

| Tanggal | Kerja |
|---|---|
| 21 Nov | Riset + desain + scaffold ini ✅ |
| 22 Nov | Ivan: repo GitHub + registrasi Loops → attribution tag. Suneo: pasang tag di kode agent, registrasi ERC-8004 agent (setelah wallet agent didanai). |
| 23–24 Nov | Build inti agent: integrasi Textile RFQ API v2 + swap via LimitOrderReactor; test di sandbox/testnet dulu (Textile punya testnet sandbox). ✅ SELESAI 21 Nov — kontrak v2 (29/29 test), agent v1, preview live terverifikasi, ERC-8004 prep. |
| 25–26 Nov | Deploy RupiahRelay.sol ke Celo mainnet (wallet agent, gas kecil — go-ahead Ivan). Uji konversi kecil pertama. |
| 27–28 Nov | Konversi beneran #1: USD₮ → IDRX → bayar ke penerima (nama + alamat dari Ivan). Verifikasi di Celoscan, catat tx hash. |
| 29 Nov–1 Des | Konversi #2–#3 (repeat use = traction), perbaiki bug, ikut livestream Corridors 1 Des. |
| 2–3 Des | Video demo <3 menit + polish README + halaman status live. |
| 4 Des | AskBots review ronde 2 (GitHub issue di repo) — tanggapi. |
| 5–6 Des | Tulis submission: deskripsi, tx hash, named user + job yang selesai, bukti revenue agent. Submit di Loops sebelum deadline. |
| 7 Des 16:00 WIB | Submissions close. Winners 11 Des. |

## Struktur repo (scaffold ini)

```
contracts/   Foundry — RupiahRelay.sol (escrow + swap via Textile reactor + payout + fee)
agent/       Node + viem — RFQ quote, build tx + attribution tag, kirim, catat status
web/         Halaman status minimal (alamat kontrak, tx terakhir, saldo agent)
DESIGN.md    Desain teknis 1 halaman
TODO-SUBMIT.md  Checklist registrasi + submission
```

## Bukti kerja (proof package — yang dinilai juri)

Tiap konversi harus meninggalkan jejak ini (agent menuliskannya ke `agent/status.json`):

1. **Deliverable beneran** — foto kaos tie-dye (proses + produk jadi) dari penerima,
   disimpan di `proof/` + ditautkan di README submission. Ini bukti "real job for a real person".
2. **Tx hash on-chain** — deposit USD₮ → `swapAndPay` (ber-tag) → payout IDRX → `withdrawFees`.
   Semua tx agent ber-tag ERC-8021 (`celo_e8a3571fc9bd`, tag Loops resmi).
3. **Konfirmasi penerima** — pesan/teks dari freelancer yang membenarkan: menerima IDRX
   sejumlah X untuk order kaos Y (jumlah + desain). Hubungan keluarga diungkap transparan
   di README (aturan hanya melarang anggota tim + wallet yang didanai tim).
4. **Video demo + README** — alur lengkap ditunjukkan: klien bayar → agent kerja → penerima terima.
5. **Reputasi ERC-8004** — setelah konversi #1, minta klien/penerima memberi feedback
   via Reputation Registry (`giveFeedback`) — agent TIDAK boleh menilai dirinya sendiri.

## Referensi (semua terverifikasi 21 Nov 2026)

- Hackathon: https://www.loops.house/agents-open-for-business
- Textile FX docs: https://fx-docs.textilecredit.com (RFQ API v2, sandbox testnet)
- Textile LimitOrderReactor (mainnet): `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`
- Attribution tags: https://github.com/celo-org/attribution-tags
- ERC-8004: https://docs.celo.org/build-on-celo/build-with-ai/8004 · https://8004scan.io
- x402 facilitator: https://x402.celo.org · skill: https://x402.celo.org/skill.md
- Celo docs skill (ter-install di custom-skills/celo-docs): https://docs.celo.org/skill.md
- Token mainnet: USD₮ `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e` · IDRX `0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22` · cNGN `0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f` · wARS `0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D` · wBRL `0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0` · wMXN `0x337E7456B420bD3481e7FA61fA9850343d610d34` · wCOP `0x8a1D45e102e886510e891d2Ec656a708991e2D76`
- Celo mainnet: chain ID 42220, RPC https://forno.celo.org · Explorer: https://celoscan.io
- Telegram grup hackathon: t.me/celoagenthackathons · Office hours Kamis 12:00 GMT
- Prezenti Frontier pool: $45.000 (grant s.d. $15.000, apply s.d. 29 Des) — jalur lanjutan kalau proyek ini hidup

## Aturan mainnet

JANGAN transaksi mainnet, JANGAN connect wallet Ivan, JANGAN bayar apa pun tanpa
go-ahead Ivan per item. Wallet agent (EVM `0xa9cB...2453`) dipakai buat kerja;
pendanaan mainnet = keputusan uang Ivan.
