# DESIGN — Rupiah Relay (1 halaman)

## Masalah

Freelancer Indonesia dibayar klien luar dalam USD₮, tapi hidupnya pakai rupiah.
Jalur hari ini: terima USD₮ di exchange → jual → withdraw ke bank (potongan, nunggu,
ribet, apalagi kalau klien bayar per job kecil). Yang dibutuhkan: terima USD₮,
otomatis jadi IDRX di dompet, tanpa sentuh exchange.

## Solusi

Agent otonom yang, untuk tiap job payout:
1. Terima USD₮ dari klien ke `RupiahRelay.sol` (escrow, tercatat `payoutId` + penerima + penyetor).
2. Minta preview RFQ ke Textile FX (USD₮ → IDRX); kalau tidak ada quote, antre (hormati `retryAfterMs`).
3. Minta firm quote dengan **taker = relay** + bukti kontrol TakerControl EIP-712
   (domain `Textile Taker Control` v1, chain 42220) yang ditandatangani agent EOA
   atas nama relay — Textile memverifikasinya on-chain via `relay.isValidSignature`
   (EIP-1271, didelegasikan ke owner). 401 → tanda tangan baru; 502 → ulangi bukti yang sama.
4. Pastikan allowance Permit2 relay → reactor cukup (`approveReactor()` bila kurang),
   lalu eksekusi swap lewat kontrak — `relay.swapAndPay(payoutId, swapCalldata, minIdrxOut)` —
   kontrak memanggil Textile `LimitOrderReactor`, menerima IDRX.
5. Kontrak membayar IDRX ke penerima dikurangi fee 0,5%; fee tercatat di `feesAccrued`,
   ditarik agent (fee-only) ke wallet-nya buat bayar gas + biaya layanan.
6. Semua tx agent ditempeli attribution tag ERC-8021 via `@celo/attribution-tags`
   (`withAttribution`) — tag tidak bisa ditambah belakangan. Swap calldata dari
   Textile diteruskan verbatim (suffix attribution-nya, kalau ada, ikut di dalam
   argumen `bytes` dan diabaikan decoder reactor).

## Kontrak yang dibutuhkan

| Kontrak | Peran |
|---|---|
| `RupiahRelay.sol` v2 (baru, Foundry) | Escrow USD₮ per payout; `approveReactor()` (ERC-20 approve ke Permit2 + allowance Permit2 ke reactor); eksekusi swap via Textile reactor (low-level call dengan calldata dari RFQ); bayar IDRX ke penerima; simpan fee 0,5% di `feesAccrued`; `withdrawFees` (fee-only, agent only); `refundPayout` (kembalikan USD₮ ke penyetor kalau payout tidak bisa selesai); `rescueToken` (token non-core saja — USD₮/IDRX tidak bisa di-rescue); `pause`/`unpause` (owner); EIP-1271 `isValidSignature` (didelegasikan ke owner, pakai `tryRecover` supaya signature jelek mengembalikan 0xffffffff, bukan revert). |
| Textile `LimitOrderReactor` | `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3` (sudah live mainnet) — tujuan swap. Narik USD₮ dari taker (relay) via Permit2. |
| Permit2 singleton | `0x000000000022D473030F116dDEE9F6B43aC78BA3` — allowance reactor dicatat di sini. |
| USD₮ / IDRX | Token ERC-20 standar (alamat di README). |

Tidak ada oracle sendiri, tidak ada AMM sendiri — harga datang dari maker Textile RFQ.
Kontrak tidak menyimpan harga; slippage dilindungi `minOut` dari quote (quote kedaluwarsa
= tx revert, aman).

## Alur transaksi + tag (yang dihitung juri)

1. `deposit` — klien transfer USD₮ ke relay (tag ditempel agent/backend saat membangun tx).
2. `approveReactor` — agent menyiapkan allowance Permit2 (1 tx, ber-tag).
3. `swapAndPay` — agent eksekusi swap + payout (1 tx, ber-tag; swap calldata dari
   Textile diteruskan verbatim — tag Textile di dalamnya ikut terbawa).
4. `withdrawFees` — agent ambil fee yang terakumulasi (ber-tag, menunjukkan revenue agent).
5. Registrasi ERC-8004 — 1 tx identitas agent (wajib, semua track).
6. (Opsional) pembayaran x402 ke `buy` (usebuy.ai) buat data/API — dihitung sebagai
   real use di semua track.

Tag: kode ERC-8021 dari registrasi Loops (`celo_...`), ditempel di akhir calldata
tiap tx yang dibangun agent (bukan di kontrak) via `@celo/attribution-tags`
(`withAttribution`). Panduan: github.com/celo-org/attribution-tags.
Tag TIDAK bisa ditambah belakangan — pasang sebelum tx pertama.
Tag Loops resmi: `celo_e8a3571fc9bd` (enrolment 21 Nov 2026, akun GitHub Ipan8) —
agent membacanya dari env `ATTRIBUTION_TAG`. Fallback kalau env kosong: kode
diturunkan dari slug repo (`codeFromRepo("Ipan8/rupiah-relay")`). Textile juga
bisa menempelkan tag sendiri kalau RFQ diminta dengan
`includeAttribution: true` + `builderCodes: [tag]` (best-effort; non-partner bisa
tetap tidak ter-tag di sisi Textile — tag agent di tx luar yang dijamin).

## Dari mana agent dapat pemasukan (self-sustaining)

- Fee 0,5% dari tiap konversi (contoh: konversi $10 → fee $0,05).
- Biaya agent per konversi: gas Celo ~$0,001–0,01 (sub-cent, 1 detik finality) +
  spread FX maker (±0,1–1%, ditanggung klien/penerima via quote, bukan agent).
- Break-even: 1 konversi $10 sudah membiayai ~5–50 tx berikutnya.
- Uang fee menumpuk di wallet agent → bayar gas, bayar x402 (100 kredit gratis dulu),
  dan kalau volume naik, jadi modal kerja berikutnya. Tidak ada deposit besar di muka.

## Kenapa bukan LP autopilot (alternatif yang dipertimbangkan)

@CeloDevs me-RT "agents manage LP positions, FX trades, swaps in autopilot" — LP autopilot
di Celo memang dekat dengan skill Ivan. Tapi: (a) LP butuh modal kerja jauh lebih besar
dan risiko impermanent loss — uang Ivan dipertaruhkan; (b) track Corridors mensyaratkan
pembayaran ke penerima luar tim, yang LP tidak penuhi; (c) payout freelancer adalah
job yang lebih jelas "real job for a real person" (25% bobot penjurian) dan koridor
IDRX adalah keunggulan Ivan yang tidak dimiliki builder lain. LP autopilot tetap bisa
jadi fitur fase 2 (agent menginvestasikan fee yang menumpuk ke LP Celo) — dicatat sebagai
roadmap, bukan janji submit.

## Risiko + mitigasi

| Risiko | Mitigasi |
|---|---|
| Quote RFQ kedaluwarsa / slippage | `minOut` di quote; tx revert aman, coba lagi dengan quote baru. Agent membatalkan quote basi (best-effort) dan re-quote sekali. |
| Textile tidak punya likuiditas IDRX saat itu | RFQ mengembalikan "no quote" — agent lapor + antre (hormati `retryAfterMs`), tidak kirim tx gagal. |
| TakerControl / EIP-1271 ditolak venue | 401 → tanda tangan baru; 502 → ulangi bukti yang sama; `proof_of_control_invalid` → fallback eip191 text rendering. Relay mengembalikan 0xffffffff (bukan revert) untuk signature jelek. |
| Swap target bukan reactor (rute recall/executor lain) | Agent memeriksa `transactions.swap.to` vs `relay.reactor()` dan membatalkan quote — rute recall tidak didukung (tidak pernah opt-in `settlementCapabilities`). |
| USDT dari Binance bukan USD₮ Textile | Verifikasi varian token saat funding (build 22 Nov); swap ke USD₮ dulu bila perlu. |
| Penerima IDRX belum ada | Ivan tentukan 1 orang beneran sebelum 27 Nov — tanpa ini track tidak terpenuhi. |
| Self-trading / wash dicurigai juri | Semua payout ke penerima luar tim, jumlah bervariasi, job beneran — dokumentasikan di submission. |
| Harga CELO / gas naik | Gas Celo sub-cent; buffer 5 CELO cukup untuk puluhan tx. |

## Stack

- Kontrak: Solidity 0.8.30, Foundry (sudah ada di VM: `~/.foundry/bin`).
- Agent: Node v24 + viem (feeCurrency opsional — gas dibayar CELO, sederhana dulu).
- Frontend: 1 halaman statis (status + tx terakhir dari `status.json` yang ditulis agent).
- Test: Foundry test lokal + Celo Sepolia (faucet gratis) sebelum mainnet.
- Skill: `celo-docs` (ter-install) + Textile FX docs + attribution-tags repo.
