# IMPLEMENTATION PLAN: Solusi "No points gained" Bing Search, Adaptive Cooldown, dan Runtime Crash doClaimBonusPoints

Dokumen ini berisi analisis akar masalah (*Root Cause Analysis*), rencana perbaikan arsitektur teknis, dan langkah pengujian untuk mengatasi kendala perolehan poin pencarian Bing serta bug runtime crash pada repository `Microsoft-Rewards-Script`.

---

## 1. Root Cause Analysis (Analisis Akar Masalah)

### 1.1 Masalah "No points gained" pada Bing Search (1/10 s.d. 4/10 | remaining=90)
Berdasarkan log terminal dan audit kode pada `src/functions/activities/browser/Search.ts`, `src/functions/SearchManager.ts`, dan `config.json`, terdapat 4 faktor utama yang saling berkorelasi:

1. **Konkurensi Paralel yang Mencurigakan (`parallelSearching: true`):**
   * Di `config.json` baris 72: `"parallelSearching": true`.
   * Di `SearchManager.ts` baris 113-141: `doParallelSearches()` menjalankan `doMobileSearch` dan `doDesktopSearch` secara bersamaan menggunakan `Promise.all()`.
   * **Dampak Deteksi:** Pada IP dan akun yang sama, dua browser (satu mobile, satu desktop) menembak Bing di detik yang persis sama. Pola ini mustahil dilakukan oleh manusia normal dan secara otomatis memicu flag bot abuse pada mesin pertahanan Microsoft.

2. **Absennya Interaksi Organik SERP (*Zero-Interaction SERP*):**
   * Di `config.json` baris 70-71: `"scrollRandomResults": false` dan `"clickRandomResults": false`. Konfigurasi `organicSearch` juga tidak diaktifkan di `config.json`.
   * Akibatnya, pada `Search.ts` baris 374-386, tidak ada event mouse movement, smooth scrolling, ataupun dwell time membaca hasil pencarian. Bot hanya mengetik query, menunggu beberapa detik dalam keadaan diam (*idle*), lalu membaca counter poin. Server telemetri Bing (`c.bing.com` / event tracker) mencatat interaksi nol, sehingga query tidak divalidasi sebagai pencarian manusia yang berhak mendapat reward.

3. **Kebijakan Pembatasan Microsoft 15-Minute Search Cooldown:**
   * Microsoft Rewards memberlakukan sistem proteksi agresif: Akun yang terdeteksi melakukan pencarian otomatis atau terlalu cepat akan dimasukkan ke dalam status **15-Minute Cooldown**.
   * Dalam status cooldown ini, Microsoft hanya mengizinkan maksimal **3-4 pencarian (15-20 poin)** per jendela 15 menit. Setiap pencarian berikutnya dalam jendela waktu tersebut akan menghasilkan **+0 poin** (`gainedPoints === 0`).

4. **Kelemahan Deteksi Loop Stagnan (`stagnantLoopMax = 10`):**
   * Di `Search.ts` baris 92 & 166: `stagnantLoopMax` di-hardcode sebesar `10` dengan kondisi `if (stagnantLoop > stagnantLoopMax)`. Artinya bot harus mengalami **11 kali berturut-turut** gagal mendapat poin sebelum menghentikan loop pencarian.
   * Bot terus memaksakan kueri setiap 8-12 detik meskipun akun sedang dalam masa cooldown 15 menit. Hal ini membuang antrean kueri, memperparah skor risiko akun (*fraud score*), dan menyebabkan eksekusi terlihat "hang" atau lambat tanpa menghasilkan poin.

---

### 1.2 Bug Runtime Crash pada `doClaimBonusPoints`
* **File Target:** `src/functions/activities/api/ClaimBonusPoints.ts` (baris 35) & `src/functions/activities/api/Quiz.ts` (baris 31).
* **Gejala:** Terminal mengalami crash dengan error:
  `TypeError: Cannot read properties of undefined (reading 'headers')`.
* **Akar Penyebab:**
  * Di `ClaimBonusPoints.ts` baris 35 tertulis:
    ```typescript
    const fingerprintHeaders = { ...this.bot.fingerprint.headers }
    ```
  * Sejak arsitektur sesi dimigrasikan ke `AccountSessionStore` terpadu (Playwright `storageState`), properti `this.bot.fingerprint` bernilai `undefined`.
  * Membaca `.headers` dari objek `undefined` tanpa safe navigation (`?.`) langsung melempar unhandled `TypeError` dan menghentikan worker yang bersangkutan.

---

## 2. Rencana Perbaikan Pencarian & Anti-Cooldown

### 2.1 Penegakan Mutlak Sequential Search (`parallelSearching: false`)
* **File:** `config.json`, `src/config.example.json`, dan `src/functions/SearchManager.ts`.
* **Tindakan:**
  1. Ubah default pada `config.json` dan `src/config.example.json`: `"parallelSearching": false`.
  2. Di `src/functions/SearchManager.ts`: Tambahkan guard keamanan. Jika `parallelSearching` aktif namun akun menjalankan kueri pencarian, beri peringatan log dan alihkan ke `doSequentialSearches()` demi mencegah suspensi dan penalti cooldown simultan.

### 2.2 Peningkatan Interaksi Organik SERP & Dwell Time
* **File:** `config.json` dan `src/functions/activities/browser/Search.ts`.
* **Tindakan:**
  1. Sinkronisasi konfigurasi interaksi organik di `config.json`:
     - `"parallelSearching": false`
     - `"scrollRandomResults": true`
     - `"searchResultVisitTime": "6sec"`
     - `"searchDelay": { "min": "14sec", "max": "22sec" }`
  2. Di `Search.ts`:
     - Pastikan simulasi scrolling hasil pencarian (`randomScroll`) dijalankan secara konsisten dengan variasi kedalaman scroll (smooth scrolling).
     - Sisipkan human dwell time realistis (antara 6 s.d. 15 detik) sebelum query berikutnya dieksekusi, sehingga sesi merefleksikan perilaku membaca pengguna asli.

### 2.3 Mekanisme Adaptive Cooldown dengan Hard-Verification
* **File:** `src/functions/activities/browser/Search.ts`.
* **Tindakan:**
  1. Turunkan ambang batas stagnan: Ubah `stagnantLoopMax` dari `10` menjadi `3`.
  2. **Hard-Verification sebelum Abort:**
     - Saat `stagnantLoop >= 3`, **JANGAN** langsung membatalkan pencarian.
     - Lakukan 1 kali verifikasi silang langsung ke endpoint API Rewards dengan cache-buster (`api/getuserinfo?type=1&_=${Date.now()}`).
     - Evaluasi saldo `pointProgress` atau `availablePoints`:
       * Jika terbukti saldo/progres di server bertambah (kemungkinan UI browser terlambat memperbarui DOM), reset `stagnantLoop = 0` dan lanjutkan pencarian.
       * Jika terbukti di server saldo tetap stagnan, konfirmasikan bahwa akun berada dalam status cooldown 15 menit.
  3. **Multi-Account Hand-Off yang Mulus:**
     - Catat log: `[COOLDOWN-DETECTED] Microsoft 15-Minute Search Cooldown aktif pada akun ini`.
     - Hentikan search loop pada akun ini secara *graceful* (mengembalikan akumulasi poin yang sudah diperoleh tanpa error).
     - Orchestrator menyimpan sesi akun via `AccountSessionStore`, menutup browser/page secara bersih melalui `AccountDisposer`, dan langsung melanjutkan eksekusi ke akun berikutnya dalam antrean tanpa menghentikan runner utama.

### 2.4 Filter Kueri Pendek & Spam Guard
* **File:** `src/functions/QueryEngine.ts` dan `src/functions/activities/browser/Search.ts`.
* **Tindakan:**
  - Tambahkan filter validasi pada kueri: Abaikan kueri yang terlalu pendek (< 5 karakter atau hanya terdiri dari 1 kata seperti "test", "a", "search") untuk mencegah flag spam dari Bing.

---

## 3. Rencana Perbaikan Bug Runtime `doClaimBonusPoints`

* **File:** `src/functions/activities/api/ClaimBonusPoints.ts` dan `src/functions/activities/api/Quiz.ts`.
* **Tindakan:**
  1. Di `ClaimBonusPoints.ts` baris 35:
     Ganti:
     ```typescript
     const fingerprintHeaders = { ...this.bot.fingerprint.headers }
     ```
     Menjadi safe optional chaining:
     ```typescript
     const fingerprintHeaders = { ...(this.bot.fingerprint?.headers ?? {}) }
     ```
  2. Di `src/functions/activities/api/Quiz.ts` baris 31:
     Lakukan perbaikan identik:
     ```typescript
     const fingerprintHeaders = { ...(this.bot.fingerprint?.headers ?? {}) }
     ```
  3. Bungkus pembacaan token form data dan pemanggilan HTTP request `claimallpointsasync` dengan pengecekan defensif (fallback token kosong dan penanganan status non-200) agar tidak terjadi uncaught promise rejection.

---

## 4. Rencana Pengujian & Validasi

1. **Unit Testing Regresi & Skenario Baru:**
   * Tambahkan skenario uji di `test/antiAbuseRemediation.test.ts`:
     - Test memastikan `ClaimBonusPoints` dan `Quiz` dapat diinstansiasi dan dieksekusi aman saat `bot.fingerprint` bernilai `undefined`.
     - Test memastikan `SearchManager` mematuhi `parallelSearching: false` secara default.
     - Test logika deteksi `stagnantLoop` dengan hard-verification dan graceful hand-off.
     - Test filter kueri pendek (< 5 karakter / 1 kata).
2. **Kompilasi TypeScript:**
   * Jalankan `npm run build` untuk memverifikasi tidak ada kesalahan tipe data (`tsc` bersih, exit code 0).
3. **Validasi Test Suite Keseluruhan:**
   * Jalankan `npm test` untuk memastikan seluruh test suite (210+ pengujian unit) tetap lulus 100%.
