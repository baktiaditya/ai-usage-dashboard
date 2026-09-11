# AI Usage Dashboard — Implementation Plan

Dashboard lokal untuk memantau quota Codex dan Claude Code serta saldo DeepSeek dan OpenRouter.

## 0. Baseline validasi mesin

Baseline ini diverifikasi pada **2026-09-12 (Asia/Jakarta)** dan harus dianggap dapat drift. M0 wajib mengulang probe, menyimpan fixture yang sudah disanitasi, dan mencatat versi sumber yang digunakan.

| Area | State terverifikasi | Implikasi |
|---|---|---|
| Repository | Baru berisi dokumen ini; belum ada commit, `package.json`, lockfile, schema, atau source code | Bootstrap aplikasi masih bagian dari pekerjaan |
| Runtime | Node.js `24.19.0`, npm `11.17.0`, Corepack `0.35.0`, SQLite `3.45.1` | Gunakan npm + `package-lock.json`; jangan bergantung pada Yarn yang belum dipin dan saat probe mencoba mengakses registry |
| Codex | `codex-cli 0.154.0`, login ChatGPT aktif; `account/rateLimits/read` berhasil dipanggil lewat app-server dan mengembalikan window 300 menit serta 10.080 menit | Feasible melalui JSON-RPC resmi; parsing `/status` atau file auth tidak diperlukan |
| Claude Code | `2.1.267`, login first-party aktif; `subscriptionType` dari `claude auth status` bernilai `null`; belum ada konfigurasi `statusLine` | Interface status line tersedia, tetapi eligibility/payload quota masih perlu dibuktikan dari event aktual setelah respons API pertama |
| API credentials | `DEEPSEEK_API_KEY`, `OPENROUTER_MANAGEMENT_KEY`, dan `OPENROUTER_API_KEY` tidak ada pada environment shell yang diprobe | Live probe DeepSeek/OpenRouter belum bisa dilakukan; missing credential harus menjadi `unavailable`, bukan kegagalan global |
| Scheduler | User systemd berjalan dan user linger aktif | User-level service + timer layak menjadi scheduler utama |

Tidak ada secret, email, account ID, raw auth payload, atau nilai quota sesaat yang perlu dicatat di repository.

## 1. Tujuan

Membangun satu dashboard `localhost-first` yang menjawab tiga pertanyaan: berapa quota subscription yang tersisa, berapa credit API yang tersisa, dan kapan provider perlu ditinjau atau diganti secara manual.

- Menampilkan kondisi terkini keempat provider dalam satu layar.
- Menyimpan snapshot historis agar tren pemakaian dapat dianalisis tanpa menyamakan jenis metrik yang berbeda.
- Menjaga credential dan session token tetap lokal dan dikelola oleh sumber aslinya bila memungkinkan.
- Tetap berguna ketika salah satu adapter gagal atau format upstream berubah.

Dashboard tidak membuat keputusan routing otomatis pada MVP. Ia hanya menyajikan fakta, freshness, dan threshold yang dapat dikonfigurasi.

## 2. Prinsip dan keputusan arsitektur

- **Localhost-first:** UI dan API bind eksplisit ke `127.0.0.1`; bukan hanya memeriksa header atau alamat request.
- **Quota, counter, dan uang dipisahkan:** quota window adalah gauge; `total_usage` adalah counter kumulatif; balance adalah nilai uang per mata uang. Ketiganya tidak dijumlahkan menjadi satu angka.
- **Structured source first:** gunakan API/provider interface yang terdokumentasi. Jangan membaca token dari file auth, memanggil endpoint internal dengan token hasil ekstraksi, atau mem-parse UI terminal jika interface terstruktur tersedia.
- **Pull dan event ingestion dipisahkan:** Codex, DeepSeek, dan OpenRouter dapat dipoll; Claude quota diterima dari status line saat Claude aktif.
- **Read-only behavior:** aplikasi hanya menjalankan operasi baca. Catatan: OpenRouter Management Key tetap merupakan credential administratif yang kuat walaupun adapter hanya memanggil `GET`.
- **Graceful degradation:** kegagalan atau absennya konfigurasi satu provider tidak menggagalkan provider lain.
- **No raw payload storage:** validasi payload di boundary, pilih field yang dibutuhkan, lalu buang payload mentah.
- **Versioned adapters:** simpan versi CLI dan versi schema adapter bersama snapshot agar drift dapat didiagnosis.

## 3. Scope MVP

### 3.1 Provider adapters

#### Codex

- Spawn `codex app-server` melalui stdio, lakukan handshake `initialize`/`initialized`, lalu panggil `account/rateLimits/read`.
- Normalisasi `rateLimitsByLimitId` bila tersedia; fallback ke `rateLimits` untuk kompatibilitas.
- Simpan setiap `primary`/`secondary` window sebagai record terpisah dengan `limitId`, `usedPercent`, `windowDurationMins`, dan `resetsAt`.
- Jangan menyimpan `email`, `accountId`, token, reset-credit ID, atau seluruh respons app-server.
- Gunakan schema yang dihasilkan oleh versi CLI terpasang (`codex app-server generate-json-schema`) sebagai fixture pengembangan, tetapi validasi runtime hanya terhadap subset field yang dipakai dashboard.
- Timeout proses, tutup child process dengan bersih, dan jangan mencoba membaca `~/.codex/auth.json` atau database internal.

#### Claude Code

- Gunakan field resmi `rate_limits.five_hour` dan `rate_limits.seven_day` dari JSON input status line. Setiap window berisi `used_percentage` dan `resets_at`.
- Tambahkan bridge status line yang memilih hanya field quota + timestamp observasi dan menulis spool file lokal secara atomik dengan permission `0600`. Jangan menyimpan seluruh input status line karena mengandung metadata session/workspace yang tidak diperlukan.
- Collector membaca dan memvalidasi spool tersebut. Bila belum ada event, event terlalu lama, atau waktu reset sudah lewat tanpa observasi baru, tampilkan `unavailable`/`stale`; jangan menganggap nilai lama masih current.
- Integrasi konfigurasi harus mempertahankan status line yang sudah ada. Jika kelak ditemukan konfigurasi existing, compose secara eksplisit atau fail closed—jangan overwrite diam-diam.
- Field `rate_limits` hanya diharapkan untuk akun Claude.ai Pro/Max (atau gateway dengan spend limit) dan baru tersedia setelah respons API pertama. Karena `subscriptionType` mesin saat ini tidak terdeteksi dan belum ada status line, M0 masih harus membuktikan payload aktual.
- Parsing output interaktif `/status` atau `/usage` bukan source MVP.

#### DeepSeek

- Panggil `GET https://api.deepseek.com/user/balance` dengan API key resmi.
- Normalisasi `is_available` dan seluruh `balance_infos[]`, termasuk `currency`, `total_balance`, `granted_balance`, dan `topped_up_balance`.
- Pertahankan mata uang sumber (`USD` atau `CNY`); jangan menggabungkan atau mengonversi mata uang pada MVP.
- Endpoint balance tidak menyediakan usage. UI hanya boleh menyebut **balance** atau **balance change**, bukan “DeepSeek usage”.

#### OpenRouter

- Panggil `GET https://openrouter.ai/api/v1/credits` menggunakan Management Key.
- Normalisasi `data.total_credits` dan `data.total_usage`; hitung `remaining = total_credits - total_usage` menggunakan decimal arithmetic, bukan floating-point biner.
- Bedakan `401` (missing/invalid credential) dan `403` (credential bukan Management Key) dalam error taxonomy tanpa mencetak respons mentah.

### 3.2 Dashboard

- Empat provider cards dengan status `healthy`, `stale`, `unavailable`, atau `error`.
- Progress bar quota Codex dan Claude Code per window beserta reset time; label UI berasal dari duration/source, bukan asumsi posisi array semata.
- Balance DeepSeek per mata uang, serta total credit, total usage, dan remaining OpenRouter dalam USD.
- `source observed at`, `last successful collection`, dan umur data per provider.
- Advisory deterministik `ok`, `watch`, `switch_suggested`, atau `unknown` berdasarkan threshold lokal per provider/window/currency. Setiap advisory wajib menyertakan reason; data stale/error tidak boleh menghasilkan rekomendasi switch berbasis angka lama.
- Default awal yang dapat dioverride: quota remaining `<=20%` menjadi `watch` dan `<=10%` menjadi `switch_suggested`; threshold balance dikonfigurasi per provider dan mata uang agar USD/CNY tidak tercampur.
- Grafik historis berdasarkan jenis metrik:
  - quota: latest/min/max utilization per window; tidak dijumlahkan sebagai usage harian;
  - OpenRouter: delta `total_usage` untuk hari ini/7/30 hari hanya bila ada baseline sebelum awal periode;
  - DeepSeek: perubahan balance yang dilabeli **balance change**, bukan usage, karena top-up/grant dapat memengaruhi nilai;
  - insufficient history ditampilkan eksplisit, bukan sebagai nol.
- Boundary “hari ini” mengikuti timezone konfigurasi dashboard (default `Asia/Jakarta`); timestamp disimpan dalam UTC dan dikonversi hanya saat query/presentation.
- Diagnostics panel hanya menampilkan error code, adapter/source version, dan pesan aman yang sudah direduksi.
- Manual refresh per provider menggunakan `POST` dan tidak memblokir provider lain.

### 3.3 Collector dan storage

- Sediakan command one-shot, misalnya `npm run collect`, sebagai satu-satunya orchestration path untuk scheduled dan manual collection.
- Jalankan command tersebut setiap 5 menit melalui user-level `systemd` service + timer. Jangan mengandalkan interval di dalam proses Next.js sebagai scheduler utama.
- Pull Codex, DeepSeek, dan OpenRouter secara paralel dengan timeout independen; ingest Claude spool pada run yang sama.
- Gunakan SQLite WAL mode, `busy_timeout`, transaksi pendek, dan unique constraint untuk menangani overlap antara collector/manual refresh dengan proses web.
- Retention default 90 hari. Agregasi harian boleh dipertahankan lebih lama setelah aturan rollup dan idempotensinya diuji.
- Definisikan freshness per source. Default awal: pull source menjadi `stale` setelah tiga interval yang terlewat; Claude event juga menjadi `stale` bila event melewati threshold atau `resets_at` sudah lewat.
- Perlakukan delta counter negatif sebagai discontinuity/reset data, bukan sebagai penggunaan negatif.

## 4. Rancangan teknis

### 4.1 Stack dan bootstrap

- **Next.js + TypeScript** untuk UI dan Route Handlers; adapter yang mengakses SQLite atau child process wajib memakai Node.js runtime, bukan Edge runtime.
- **npm + `package-lock.json`** sebagai package manager yang dipin di repository.
- **Tailwind CSS + shadcn/ui** untuk komponen dashboard.
- **SQLite + Drizzle ORM** untuk schema dan query historis.
- **Recharts** untuk grafik MVP; evaluasi bundle size saat implementation.
- **Zod** untuk validasi konfigurasi, payload adapter, dan spool event.
- **Vitest + Testing Library** untuk unit/component test dan **Playwright** untuk smoke test browser.
- Pin exact dependency versions melalui lockfile dan dokumentasikan minimum supported versions untuk kedua CLI.

### 4.2 Modul

- `ProviderAdapter`: kontrak pull adapter dengan `collect()` dan normalized result/error.
- `adapters/`: implementasi `codex`, `deepseek`, dan `openrouter`.
- `ingestors/claude-statusline`: validator spool event Claude.
- `collector/`: timeout, parallel execution, partial success, freshness evaluation, dan safe diagnostics.
- `repository/`: transaksi snapshot, deduplication, queries, retention, dan rollup.
- API internal: `/api/overview`, `/api/history`, dan `POST /api/providers/:provider/refresh`.
- UI: overview cards, trend chart, freshness indicator, configuration state, dan diagnostics panel.

### 4.3 Kontrak domain minimum

Gunakan discriminated union agar field quota dan uang tidak membentuk kombinasi state yang tidak valid:

- `QuotaSnapshot { provider, observedAt, collectedAt, sourceVersion, usageAllowed?, limitReachedCode?, windows[] }`
- `QuotaWindow { bucketId, windowKind, usedPercent, windowDurationMinutes?, resetsAt? }`
- `CreditSnapshot { provider, observedAt, collectedAt, balances[] }`
- `CreditBalance { currency, total?, granted?, toppedUp?, usage?, remaining?, isAvailable? }`
- `CollectionFailure { provider, attemptedAt, code, safeMessage, retryable }`
- `Advisory { state, reasons[] }`, dihitung saat query dari snapshot fresh + konfigurasi threshold dan tidak disimpan sebagai fakta provider

`remainingPercent` untuk quota dihitung di presentation layer sebagai `clamp(100 - usedPercent, 0, 100)`. Nilai sumber `usedPercent` tetap disimpan agar fidelity dan diagnostics terjaga.

### 4.4 Data model minimum

#### `provider_snapshots`

- `id`
- `collector_attempt_id`
- `provider`
- `kind` (`quota` atau `credit`)
- `source_observed_at`
- `collected_at`
- `source_version`
- `schema_version`
- `source_event_id` nullable untuk source event-driven
- partial unique key `(provider, source_event_id)` ketika `source_event_id` tersedia; setiap poll sukses tetap merupakan observasi historis tersendiri

#### `quota_windows`

- `snapshot_id`
- `bucket_id`
- `window_kind`
- `used_percent`
- `window_duration_minutes` nullable
- `reset_at` nullable

#### `credit_balances`

- `snapshot_id`
- `currency`
- `total_balance` nullable
- `granted_balance` nullable
- `topped_up_balance` nullable
- `total_credits` nullable
- `total_usage` nullable
- `remaining_credit` nullable
- `is_available` nullable

Semua nilai uang disimpan sebagai canonical decimal string atau scaled integer dengan skala terdokumentasi; jangan gunakan SQLite `REAL`.

#### `collector_runs` dan `collector_attempts`

- run: `id`, `started_at`, `finished_at`, `duration_ms`
- attempt: `run_id`, `provider`, `outcome` (`success`, `unavailable`, atau `error`), `started_at`, `finished_at`, `error_code`, `retry_count`

Hitung success/failure count dari attempts agar partial success dapat diaudit dan tidak drift dari detailnya.

Database tidak menyimpan API key, OAuth token, email akun, account ID, full CLI/status-line input, full app-server response, atau payload API mentah.

### 4.5 Semantik status

- `healthy`: collection terakhir sukses dan masih berada dalam freshness policy.
- `stale`: pernah sukses, tetapi umur data melewati threshold atau reset quota sudah lewat tanpa observasi baru.
- `unavailable`: source/credential belum dikonfigurasi, akun tidak eligible, field source tidak tersedia, atau format/version guard tidak dikenali.
- `error`: source seharusnya tersedia dan sebuah attempt gagal karena timeout, network, auth rejection, atau upstream error.

Status attempt dan freshness snapshot adalah konsep berbeda dan tidak disimpan sebagai satu status pada snapshot immutable. Overview menghitung card state saat query dengan precedence berikut: latest attempt `error`; source `unavailable` atau belum pernah punya snapshot; snapshot melewati freshness policy menjadi `stale`; selain itu `healthy`. Last known value boleh tetap terlihat pada state `error`/`unavailable` dengan timestamp dan warning yang jelas.

## 5. Security dan operasi

- `DEEPSEEK_API_KEY` dan `OPENROUTER_MANAGEMENT_KEY` dibaca dari environment proses collector. Untuk systemd, gunakan file environment di luar repository dengan permission `0600`; user service tidak otomatis mewarisi environment shell.
- Perlakukan OpenRouter Management Key sebagai high-impact secret karena dapat mengakses operasi administratif lain. Gunakan key khusus dashboard bila provider mendukung pemisahan operasional, batasi permission file, dan jangan pernah mengirimkannya ke browser.
- Credential OAuth Codex/Claude tidak disalin ke `.env`. Codex adapter mendelegasikan auth ke app-server; Claude bridge hanya menerima field status line yang sudah disediakan CLI.
- Selector/redactor berjalan sebelum logging dan persistence. Test wajib membuktikan email, account ID, bearer token, authorization header, dan raw payload tidak lolos.
- Web server bind ke `127.0.0.1`. Endpoint refresh menerima `POST`, memverifikasi same-origin/CSRF, menerapkan rate limit lokal, dan tidak mempercayai `Host`/`X-Forwarded-For` sebagai satu-satunya kontrol.
- File database, spool, environment, logs, dan konfigurasi sensitif berada di luar asset publik, masuk `.gitignore` bila berada di tree, serta memakai permission minimal.
- Systemd unit menggunakan absolute `WorkingDirectory`, restart policy terbatas, timeout, dan umask `0077`. Timer memakai `Persistent=true` bila catch-up setelah reboot memang diinginkan.
- Jika nanti diakses dari HP, tambahkan autentikasi, TLS, origin policy, dan jaringan privat sebelum membuka listener non-loopback.

## 6. Milestone implementasi

### M0 — Discovery dan feasibility gate

- Ulangi baseline versi CLI/runtime dan catat tanggalnya.
- Generate schema app-server dari Codex terpasang dan simpan fixture respons `account/rateLimits/read` yang sudah disanitasi.
- Buat proof-of-concept Claude status-line bridge tanpa menimpa konfigurasi existing; lakukan minimal satu respons Claude untuk memastikan `rate_limits` benar-benar hadir pada akun ini.
- Provision credential DeepSeek dan OpenRouter di luar repository, lalu live-probe endpoint resmi dengan output yang disanitasi. Jangan menjadikan secret provisioning bagian dari source control.
- Putuskan dan dokumentasikan freshness threshold final, balance threshold per mata uang, serta perilaku setelah reset time lewat.
- **Gate Codex:** lulus pada baseline 2026-09-12; ulangi setelah upgrade CLI.
- **Gate Claude:** belum lulus sampai payload `rate_limits` aktual terlihat; jika akun tidak eligible, provider tetap dapat diluncurkan sebagai `unavailable`.
- **Gate DeepSeek/OpenRouter:** belum lulus karena credential tidak ada pada environment yang diprobe.

MVP boleh dilanjutkan dengan adapter unavailable, tetapi acceptance untuk provider tertentu baru dianggap selesai setelah gate provider tersebut lulus.

### M1 — Bootstrap dan provider foundation

- Inisialisasi Next.js/TypeScript dengan npm lockfile.
- Buat discriminated domain contract, konfigurasi tervalidasi, error taxonomy, freshness policy, safe logger, dan mock fixtures.

### M2 — Pull adapters

- Implementasikan Codex app-server, DeepSeek balance, dan OpenRouter credits dengan timeout, retry terbatas, version guard, dan test.
- Pastikan perubahan upstream menghasilkan `unavailable`/error yang aman, bukan angka yang keliru.

### M3 — Claude event ingestion

- Implementasikan status-line bridge, atomic spool, konfigurasi yang preserve existing status line, schema/version guard, dan stale/reset handling.

### M4 — Storage dan collector

- Buat migration SQLite, deduplication, one-shot collector, concurrency handling, user systemd unit/timer, retention, dan health logging.

### M5 — Dashboard UI

- Buat overview cards, chart histori per jenis metrik, empty/loading/error/stale state, responsive layout, dan manual refresh.

### M6 — Hardening

- Tambahkan unit test parser, integration test API/repository, redaction test, failure isolation, browser smoke test, upgrade compatibility fixture, backup/restore test, dan setup guide.

## 7. Acceptance criteria MVP

- Satu halaman menampilkan last known state keempat provider tanpa memblokir ketika satu adapter gagal atau belum dikonfigurasi.
- Codex membaca quota melalui `account/rateLimits/read`; tidak membaca file auth atau mem-parse terminal UI.
- Claude hanya menampilkan quota jika bridge menerima payload tervalidasi dan masih fresh; absennya payload tampil sebagai `unavailable`/`stale`.
- DeepSeek menampilkan semua balance per mata uang tanpa mengklaim memiliki usage; OpenRouter menampilkan total credits, total usage, dan remaining dari endpoint resmi.
- Semua angka uang menggunakan decimal-safe arithmetic dan semua window quota mempertahankan `usedPercent`, duration, serta reset time sumber.
- Snapshot historis tersimpan. Grafik 7/30 hari hanya muncul ketika baseline cukup dan menggunakan agregasi yang sesuai jenis metrik.
- Setiap provider menampilkan source observed time, last collection time, status, dan diagnostic aman.
- Advisory switch bersifat deterministik, menampilkan reason + threshold yang terpicu, dan menjadi `unknown` ketika datanya tidak fresh.
- Secret/PII tidak muncul di browser, log, fixture, database, atau error response; redaction tests mencakup payload aktual yang disanitasi.
- Server bind ke `127.0.0.1` secara default; refresh endpoint menggunakan `POST` + same-origin/CSRF guard.
- Collector user systemd bertahan melewati logout/reboot sesuai policy, dapat dijalankan ulang secara idempotent, dan histori tetap utuh.

## 8. Test strategy

- **Unit:** Zod schemas, version/unknown-field handling, percentage clamping, decimal arithmetic, status/freshness transitions, and error redaction.
- **Contract fixtures:** satu fixture tersanitasi per provider dan CLI version; fixture malformed/partial wajib ada.
- **Integration:** mocked HTTP, spawned fake JSON-RPC process, SQLite migrations/constraints/WAL, spool atomicity, collector partial success, dan API same-origin checks.
- **Browser:** cards dan charts untuk healthy/stale/unavailable/error, multiple quota windows, multiple currencies, insufficient history, dan manual refresh.
- **Live smoke (opt-in):** tidak berjalan di CI; hanya memeriksa shape/status endpoint tanpa mencetak atau merekam raw response.

## 9. Risiko utama dan mitigasi

| Risiko | Mitigasi |
|---|---|
| Format/protocol CLI berubah | Adapter terisolasi, fixture per versi, generated schema saat discovery, subset validation, version guard, dan `unavailable` |
| Claude tidak aktif atau akun tidak eligible | Event timestamp + stale policy; jangan menjanjikan polling realtime; tampilkan unavailable dengan setup hint |
| Management Key OpenRouter bocor | Environment file `0600`, process-only access, redaction, tidak pernah dikirim ke UI, dokumentasikan privilege administratif |
| Rate limit API | Interval polling konservatif, jitter, timeout, bounded backoff, dan cache snapshot terakhir |
| Quota subscription dianggap sebagai biaya | Pisahkan quota gauge dari money/counter; jangan konversi ke USD |
| DeepSeek balance dianggap usage | Label balance change secara eksplisit dan jangan hitung spend tanpa transaction/usage API |
| Reset time tidak tersedia atau sudah lewat | Field nullable; status stale setelah reset lewat tanpa observasi baru; tampilkan `unknown` bila null |
| Nilai uang meleset karena floating point | Decimal string/scaled integer dan decimal-safe calculations |
| Scheduler dan web process menulis bersamaan | SQLite WAL, `busy_timeout`, transaksi pendek, dedup key, dan overlap test |
| Credential/PII leakage | Field allowlist sebelum log/storage, redaction test, no raw payload, localhost binding, dan CSRF guard |

## 10. Out of scope untuk MVP

- Akses publik atau multi-user.
- Routing provider otomatis.
- Mengubah paket, membeli credit, mengonsumsi reset credit, membuat/mengubah API key, atau tindakan billing lainnya.
- Browser/terminal automation untuk scraping halaman atau TUI usage.
- Konversi quota subscription menjadi estimasi USD.
- Mengklaim DeepSeek usage dari perubahan balance.
- Alert Telegram/email dan forecasting canggih; dapat ditambahkan setelah data historis stabil.

## 11. Urutan eksekusi berikutnya

1. Selesaikan gate Claude dengan bridge sementara yang hanya menangkap field allowlist dan satu event aktual.
2. Provision DeepSeek/OpenRouter credential secara lokal, lalu selesaikan live contract probe tanpa menyimpan raw response.
3. Bootstrap npm/Next.js dan finalkan TypeScript union + Zod schemas sebelum migration database atau UI.
4. Implementasikan collector one-shot dan persistence lebih dulu; UI dibangun setelah minimal satu fixture per provider lolos contract test.

## 12. Referensi resmi yang diverifikasi

- [Codex app-server protocol dan `account/rateLimits/read`](https://developers.openai.com/codex/app-server/)
- [Claude Code status line — rate limit usage](https://code.claude.com/docs/en/statusline#rate-limit-usage)
- [DeepSeek — Get User Balance](https://api-docs.deepseek.com/api/get-user-balance)
- [OpenRouter — Get remaining credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits)
- [OpenRouter — Management API Keys](https://openrouter.ai/docs/guides/overview/auth/management-api-keys)
