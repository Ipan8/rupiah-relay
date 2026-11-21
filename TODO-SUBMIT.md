# TODO — Registrasi & Submission (Rupiah Relay)

## Registrasi (langkah Ivan — belum dilakukan)

- [ ] Buat repo GitHub publik `rupiah-relay` (github.com/new → Public, tanpa README)
- [ ] Push scaffold ini ke repo (Suneo, setelah repo ada — via push_files, 1 approval)
- [ ] Daftar di https://www.loops.house/agents-open-for-business
      (nama proyek, repo publik, handle Telegram) → catat **attribution tag** di sini:
      Tag: `______________________`
      (Fallback terpasang di agent: derived dari slug `Ipan8/rupiah-relay` =
      `celo_2b6aa9d3acff` — WAJIB dikonfirmasi vs tag Loops sebelum mainnet.)
- [ ] Follow @Celo + @CeloDevs di X (HP Ivan)
- [ ] Tentukan penerima IDRX pertama (di luar tim): nama + alamat Celo
      Nama: `______________________`  Alamat: `______________________`
- [ ] Danai wallet agent `0xa9cB01C54930511202fd75734bcdDe8FbE9B2453` (Celo mainnet):
      5 CELO + 25 USD₮ — keputusan uang Ivan
- [ ] Verifikasi varian USDT yang masuk = USD₮ `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`
- [ ] Gabung Telegram grup hackathon t.me/celoagenthackathons (opsional, info + office hours)

## Build (Suneo)

- [x] Pasang attribution tag di kode agent (21 Nov — via `@celo/attribution-tags`
      `withAttribution`; fallback derived `celo_2b6aa9d3acff`, konfirmasi vs Loops sebelum mainnet)
- [ ] Registrasi ERC-8004 agent (setelah wallet didanai) → catat ID + link 8004scan
      ERC-8004 ID: `______________________`
      Prep SELESAI 21 Nov: signatures exact dari repo publik erc-8004 (ABI di `research/`),
      `agent-registration.json` + draft `agent/src/register-8004.js`.
      Registrasi = `register(agentURI)` DARI wallet agent (bukan dari relay).
- [x] Integrasi Textile RFQ API v2 (21 Nov — preview live terverifikasi:
      10 USDT → 18.378.002 atomic IDRX; agent v1 lengkap: preview → firm RFQ
      (taker = relay, TakerControl EIP-712 + EIP-1271) → approveReactor →
      swapAndPay → status.json; `--dry-run` + preview-only teruji jalan)
- [ ] Deploy RupiahRelay.sol ke Celo Sepolia → test end-to-end (faucet gratis)
- [ ] Deploy ke Celo mainnet (go-ahead Ivan) → alamat kontrak: `______________________`
- [ ] Konversi #1 USD₮ → IDRX → payout ke penerima (27–28 Nov) → tx hash: `______________________`
- [ ] Konversi #2–#3 (repeat use) → tx hash: `______________________`
- [ ] Bukti kerja (proof package — lihat README): foto kaos tie-dye (proses + jadi)
      di `proof/` + konfirmasi penerima + hubungan keluarga diungkap di README
- [ ] Halaman status live (web/) + README final
- [ ] Video demo <3 menit
- [ ] Tanggapi AskBots review ronde 1 (24 Nov) + ronde 2 (4 Des) — GitHub issue di repo

## Submission (sebelum Sen 7 Des 2026, 16:00 WIB)

- [ ] Deskripsi + masalah + cara kerja (dari README/DESIGN)
- [ ] Link repo publik + link demo/status page
- [ ] Alamat kontrak + alamat agent + ERC-8004 ID/link
- [ ] Tx hash: registrasi ERC-8004, deposit, swapAndPay (≥1), payout IDRX, withdrawFees
- [ ] Named user: nama + job yang diselesaikan (penerima IDRX) + bukti (bukan self-trading)
- [ ] Bukti revenue agent: fee yang terkumpul di wallet agent
- [ ] Submit di Loops House → catat konfirmasi: `______________________`

## Setelah submit

- [ ] Pantau pengumuman winners Jum 11 Des 2026 (pantau-pengumuman.md)
- [ ] Kalau menang: hadiah dibayar dalam CELO ke payout wallet terdaftar
- [ ] Jalur lanjutan: Prezenti Frontier pool ($45.000, grant s.d. $15.000, apply s.d. 29 Des)
