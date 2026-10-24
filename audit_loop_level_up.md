# AUDIT FORENSIK CODEBASE LINUX: BUG INFINITE LOOP LEVEL-UP, FREEZE 36 MENIT, DAN LINUX PARITY CHECK

**Status Codebase**: Local Repository Linux (Lubuntu)  
**Branch Aktif**: `v3` (Local)  
**Tipe Dokumen**: Laporan Audit Forensik & Rencana Perbaikan Arsitektur (Strict Read-Only)  
**Kebijakan Integritas**: Zero Code Modification pada tahap ini, Tidak Ada `git push` ke Remote.

---

## DAFTAR ISI
1. [Ringkasan Eksekutif & Status Sistem](#1-ringkasan-eksekutif--status-sistem)
2. [Fokus 1: Audit Bug Infinite Loop Reset Kuota Level-Up](#2-fokus-1-audit-bug-infinite-loop-reset-kuota-level-up)
   - 2.1. Alur Logika DAPI Sync & Pemicu Log Berkala (Setiap 4 Kueri)
   - 2.2. Analisis Ketiadaan Flag Status Level Akun (`isLevelUpHandled`)
   - 2.3. Cacat Perhitungan Target Kuota: `remaining = 90` vs Progres Riil
3. [Fokus 2: Audit Freeze 36 Menit ("graham ike") & Cacat Batas Deadline](#3-fokus-2-audit-freeze-36-menit-graham-ike--cacat-batas-deadline)
   - 3.1. Titik Macet Evaluasi DOM & Navigasi Tanpa Batas Timeout
   - 3.2. Ketiadaan Wrapper `runGuardedOperation` pada Modul Pencarian
   - 3.3. Cacat Arsitektur Deadline: Pengabaian `calculateDynamicDeadline` pada Mode Sequential
4. [Fokus 3: Audit Kegagalan Verifikasi Daily Set (0/3 Verified)](#4-fokus-3-audit-kegagalan-verifikasi-daily-set-03-verified)
   - 4.1. Jebakan Redirect HTTP 302: `/dashboard` vs `/about`
   - 4.2. Siklus Bouncing pada Helper `ensureOnRewardsDashboard`
   - 4.3. Mengapa "Keep Earning" Berhasil (+21 Poin) sedangkan "Daily Set" Gagal Total (0 Poin)
5. [Fokus 4: Audit Paritas Fitur Linux vs Windows](#5-fokus-4-audit-paritas-fitur-linux-vs-windows)
   - 5.1. Isolasi Kueri Lintas Akun (`QueryCore.sessionUsedQueries`)
   - 5.2. Penanganan Desktop Client Hints (`HeadlessChrome`) & Spoofing WebGL Direct3D11 ANGLE
   - 5.3. Status Sinkronisasi Mutex Sesi Manual (`ManualActionStore` & `ObserverLock`)
6. [Rencana Perbaikan Terstruktur & Langkah Implementasi](#6-rencana-perbaikan-terstruktur--langkah-implementasi)

---

## 1. RINGKASAN EKSEKUTIF & STATUS SISTEM

Berdasarkan inspeksi forensik baris demi baris pada branch `v3` di lingkungan Linux Lubuntu, ditemukan 4 anomali kritikal yang saling terkait:

| Komponen | Gejala yang Teramati | Akar Masalah Arsitektur | Tingkat Keparahan |
| :--- | :--- | :--- | :--- |
| **Search Engine** (`Search.ts` + `BrowserFunc.ts`) | Log `[LEVEL-UP]` berulang setiap 4 kueri dan pencarian tidak kunjung selesai (infinite loop). | Fallback Mobile DAPI mengembalikan hardcoded `pcSearch: 0/90`. Tidak ada flag pengunci level akun, dan target sisa direset mentah ke 90 poin tanpa menghitung progres yang telah dicapai. | **CRITICAL** (Menyebabkan akun membuang ratusan kueri & terancam spam ban) |
| **Runtime Guardian** (`Search.ts` + `index.ts`) | Eksekusi tertahan selama 36 menit pada kueri ke-45 ("graham ike"). | `searchPage.evaluate()` tidak memiliki timeout; `Search.ts` tidak dibungkus `runGuardedOperation`; dan `calculateDynamicDeadline` **hanya** dipasang pada mode dual-worker, sedangkan mode `sequential` berjalan tanpa batas waktu timeout. | **CRITICAL** (Menahan thread eksekusi hingga 36+ menit) |
| **Daily Set Worker** (`Workers.ts` + `UrlReward.ts`) | Rekonsiliasi batch menghasilkan `0/3 Verified` dan delta saldo akun = 0. | Daily Set memaksakan navigasi ke `rewards.bing.com/dashboard` yang dialihkan server ke `rewards.bing.com/about`. Di halaman `/about`, tidak ada kartu aktivitas maupun checkmark. Sebaliknya, rute `/earn` milik Keep Earning berhasil normal. | **HIGH** (Kehilangan poin Daily Set harian) |
| **Paritas Platform** (`QueryEngine.ts` & Git Sync) | Kueri pencarian bocor antar akun; fitur mutex manual Windows belum ada di Linux. | `sessionUsedQueries` berupa `Set` statis global yang tidak pernah di-reset antar akun. Submodul `ManualActionStore` dan `ObserverLock` dari `origin/v3` belum ter-merge ke local `v3`. | **MEDIUM-HIGH** (Penipisan pool kueri lintas akun) |

---

## 2. FOKUS 1: AUDIT BUG INFINITE LOOP RESET KUOTA LEVEL-UP

### 2.1. Alur Logika DAPI Sync & Pemicu Log Berkala (Setiap 4 Kueri)

Pemeriksaan pada `src/functions/activities/browser/Search.ts`:

- **Baris 646–655**:
  ```typescript
  // Sinkronisasi DAPI berkala per 4 kueri saja
  if (currentSearchCount % 4 === 0) {
      const counters = await this.bot.browser.func.getSearchPoints(searchPage, true, isMobile)
      this.bot.browser.func.cachedCounters = counters
      this.bot.logger.debug(
          isMobile,
          'SEARCH-BING',
          `Search counters after query (DAPI sync) | count=${currentSearchCount} | query="${query}"`
      )
      return counters
  }
  ```

Ketika kueri ke-4, ke-8, ke-12, dst dieksekusi, parameter `forceDapi = true` diteruskan ke `getSearchPoints()`.

Pemeriksaan alur berikutnya di `src/browser/BrowserFunc.ts`:
- **Baris 368**: Karena `forceDapi === true`, cache lokal `this.cachedCounters` dilewati secara paksa.
- **Baris 372–379**: Tab browser berada pada URL hasil pencarian (`https://www.bing.com/search?q=...`), di mana objek `window.dashboard` **tidak ada**. Akibatnya, `inPageData?.counters` bernilai `undefined`.
- **Baris 390–392**: Kode masuk ke blok fallback:
  ```typescript
  if (!counters) {
      try {
          const dashboardData = await this.getDashboardData()
  ```
- Di dalam `getDashboardData()`:
  1. Halaman aktif bukan `rewards.bing.com`, sehingga in-page fetch dilewati (**Baris 140**).
  2. Panggilan Axios `/api/getuserinfo` mengembalikan 404 (atau ditandai deprecated) (**Baris 222**).
  3. Parsing HTML dashboard gagal karena bukan halaman utama (**Baris 230**).
  4. Kode jatuh ke fallback terakhir di **Baris 256–263**:
     ```typescript
     // 4. Fallback Terakhir: Adaptasi dari Mobile App API
     if (this.bot.accessToken) {
         const appData = await this.getAppDashboardData()
         const mapped = this.mapAppDataToDashboard(appData)
         if (mapped) return mapped
     }
     ```
- Di dalam `mapAppDataToDashboard(appData)` (**Baris 87–94**):
  ```typescript
  return {
      userStatus: {
          availablePoints: balance,
          counters: {
              pcSearch: [{ pointProgress: 0, pointProgressMax: 90 }],
              mobileSearch: [{ pointProgress: 0, pointProgressMax: 60 }]
          }
      },
  ```
  **Temuan Kunci**: Nilai `pointProgress` **dibuat kaku menjadi 0** dan `pointProgressMax` **dibuat kaku menjadi 90**!

- Kembali ke `Search.ts`:
  - **Baris 154–155**: `missingSearchPoints(searchCounters, isMobile)` menghitung:
    $$\text{newMissingPointsTotal} = \text{pointProgressMax} - \text{pointProgress} = 90 - 0 = 90$$
  - Pada kueri 1, 2, dan 3 sebelumnya, pelacakan optimistik telah mengurangkan `missingPointsTotal` dari 90 menjadi 81 (misal: $90 - 3 - 3 - 3 = 81$).
  - **Baris 173**: Dihitung selisih target sisa:
    $$\text{counterDelta} = \text{missingPointsTotal} - \text{newMissingPointsTotal} = 81 - 90 = -9$$
  - **Baris 176**: Evaluasi kondisi `counterDelta < 0` terpenuhi:
    ```typescript
    if (counterDelta < 0) {
        // Kenaikan kuota maksimal di tengah jalan (Level Up / Quota Leap: Level 1 -> Level 2)
        this.bot.logger.info(
            isMobile,
            'SEARCH-BING',
            `[LEVEL-UP] Search quota expanded mid-session (Level 1 -> Level 2 detected). Resetting remaining target from ${missingPointsTotal} to ${newMissingPointsTotal} points.`,
            'green'
        )
    ```
  Karena sinkronisasi DAPI terpanggil persis setiap 4 kueri, dan DAPI selalu menyuplai data palsu `pointProgress: 0, pointProgressMax: 90`, log palsu Level-Up pasti meledak setiap 4 kueri!

---

### 2.2. Analisis Ketiadaan Flag Status Level Akun (`isLevelUpHandled`)

Pemeriksaan komprehensif pada variabel kelas dan lokal di `Search.ts` dan `index.ts`:

- Di seluruh file `Search.ts`, **TIDAK DITEMUKAN** satupun variabel guard atau flag boolean seperti:
  - `isLevelUpHandled`
  - `isLevelUpLocked`
  - `accountLevel`
  - `hasQuotaExpanded`
- Evaluasi pada **Baris 176** (`if (counterDelta < 0)`) dilakukan secara *stateless* tanpa batas pada setiap putaran loop pencarian.
- Tidak ada mekanisme memori yang mencatat: *"Akun ini sudah pernah naik ke Level 2 pada sesi ini, jangan izinkan transisi Level-Up terjadi lagi!"*.
- Kegagalan penguncian status ini menyebabkan bot memperlakukan lonjakan delta negatif palsu sebagai peristiwa baru berulang kali tanpa henti.

---

### 2.3. Cacat Perhitungan Target Kuota: `remaining = 90` vs Progres Riil

Perhatikan pembaruan nilai target pada **Baris 286** di `Search.ts`:

```typescript
284: }
285: 
286: missingPointsTotal = newMissingPointsTotal
287: 
288: if (missingPointsTotal === 0) {
```

#### Analisis Matematis Cacat Perhitungan:
1. Misalkan akun sudah mengumpulkan 30 poin pada sesi berjalan.
2. Sisa target kuota riil adalah $90 - 30 = 60$ poin.
3. Namun karena `searchCounters.pcSearch[0].pointProgress` bernilai `0`, nilai `newMissingPointsTotal` dihitung secara membabi buta sebagai:
   $$\text{newMissingPointsTotal} = 90 - 0 = 90$$
4. Kode pada baris 286 menimpa nilai `missingPointsTotal = 90`.
5. Semua progres pencarian yang sudah dilakukan sebelumnya **DIBUANG**!
6. Loop pencarian:
   - Kueri 1: Sisa 87
   - Kueri 2: Sisa 84
   - Kueri 3: Sisa 81
   - Kueri 4: Terpicu DAPI Sync $\rightarrow$ sisa **direset kembali ke 90**!
   - Kueri 5: Sisa 87
   - Kueri 6: Sisa 84
   - Kueri 7: Sisa 81
   - Kueri 8: Terpicu DAPI Sync $\rightarrow$ sisa **direset kembali ke 90**!

Inilah akar penyebab mengapa bot berputar tanpa batas (*infinite loop*) hingga puluhan kueri melampaui batas wajar harian.

---

## 3. FOKUS 2: AUDIT FREEZE 36 MENIT ("GRAHAM IKE") & CACAT BATAS DEADLINE

### 3.1. Titik Macet Evaluasi DOM & Navigasi Tanpa Batas Timeout

Log eksekusi menunjukkan bot terhenti total pada kueri ke-45 ("graham ike") mulai pukul **17:04:05** hingga **17:40:17** (tertahan 36 menit).

Pemeriksaan kode pengetikan dan eksekusi kueri pada `Search.ts`:
- **Baris 586–590**:
  ```typescript
  for (const char of query) {
      const charDelay = Math.floor(Math.random() * (55 - 25 + 1)) + 25
      await searchPage.keyboard.type(char, { delay: charDelay })
  }
  await searchPage.keyboard.press('Enter')
  ```
  - Setelah `searchPage.keyboard.press('Enter')`, **TIDAK ADA** pemanggilan `searchPage.waitForNavigation()` atau `searchPage.waitForLoadState('domcontentloaded')` dengan batasan timeout eksplisit.
  - Peramban browser sedang melakukan pembongkaran konteks dokumen lama (*unloading execution context*) untuk memuat halaman SERP Bing baru.

- **Baris 633–639**:
  ```typescript
  // In-page balance tracking (#id_rc atau #rh_meter)
  const inPageBalance = await searchPage.evaluate(() => {
      const rc = document.getElementById('id_rc')?.innerText?.replace(/[^0-9]/g, '')
      if (rc && !isNaN(Number(rc)) && Number(rc) > 0) return Number(rc)
      const flyout = document.querySelector('#rh_meter .rh_meter_points, .id_rh_pts, #id_rh, #id_h')?.textContent?.replace(/[^0-9]/g, '')
      if (flyout && !isNaN(Number(flyout)) && Number(flyout) > 0) return Number(flyout)
      return null
  }).catch(() => null)
  ```
  - **Sifat Kritis Playwright**: `page.evaluate()` **TIDAK MEMILIKI BATAS TIMEOUT DEFAULT** di Playwright/Patchright!
  - Jika renderer Chromium mengalami *stall*, koneksi websocket CDP tertahan, atau execution context frame hancur di tengah navigasi formulir Bing, pemanggilan `await searchPage.evaluate()` akan **menggantung selamanya** (*hang indefinitely*).
  - Klausa `.catch(() => null)` hanya menangani *rejection*. Jika *Promise* tidak pernah selesai (*never resolves or rejects*), klausa `.catch()` tidak akan pernah dieksekusi.

---

### 3.2. Ketiadaan Wrapper `runGuardedOperation` pada Modul Pencarian

Bandingkan arsitektur keamanan antara `UrlReward.ts` dan `Search.ts`:

- Pada `UrlReward.ts`:
  Setiap interaksi dibungkus ketat dengan `runGuardedOperation`:
  ```typescript
  // Contoh di UrlReward.ts baris 458:
  const navResult = await runGuardedOperation({
      stage: 'activity-navigation',
      timeoutMs: 30000,
      operation: async () => { ... }
  })
  ```
- Pada `Search.ts`:
  - `Search.ts` **hanya** mengimpor `interruptibleWait` dari `BrowserOperationGuard` (**Baris 10**).
  - Pemanggilan navigasi URL SERP, pengetikan form, eksekusi tombol `Enter`, simulasi scroll acak, dan evaluasi saldo DOM **berjalan secara telanjang** tanpa perlindungan timeout tahap, anggaran waktu (*budget limit*), maupun pemantauan watchdog.

---

### 3.3. Cacat Arsitektur Deadline: Pengabaian `calculateDynamicDeadline` pada Mode Sequential

Pemeriksaan pada `src/index.ts` baris 1561–1655 membongkar cacat arsitektur fatal:

```typescript
1561: if (execMode === 'sequential') {
1562:     for (const account of batch) {
1563:         if (this.stopRequested) break
...
1572:         try {
1573:             const worker = this.runAccountWorkflow(account)
1574:             const [res] = await Promise.allSettled([worker])
1575:             processedInBatchCount++
...
1582:     }
1583: } else {
1584:     // Dual-Worker Staggered Dispatcher
...
1642:     const dynamicDeadlineMs = calculateDynamicDeadline(100, 2 * 60 * 1000)
1643:     let deadlineTimeout: NodeJS.Timeout | undefined
1644:     const deadlinePromise = new Promise<{ kind: 'timeout' }>(resolve => {
1645:         deadlineTimeout = setTimeout(() => resolve({ kind: 'timeout' }), dynamicDeadlineMs)
1646:     })
1647: 
1648:     const barrierPromise = Promise.allSettled(workerPromises).then(results => ({
1649:         kind: 'completed' as const,
1650:         results
1651:     }))
1652: 
1653:     const raceResult = await Promise.race([barrierPromise, deadlinePromise])
```

#### Temuan Utama:
1. Fungsi adaptif `calculateDynamicDeadline()` (baris 107–121) yang dirancang untuk membatasi eksekusi akun maksimal 12–25 menit **HANYA DILETAKKAN DI DALAM BLOK DUAL-WORKER (`else`)**!
2. Pada mode **`sequential`** (yang aktif pada deployment Linux ini):
   - Eksekusi akun dipanggil dengan `await Promise.allSettled([worker])` tanpa race barrier!
   - Nilai timeout dinamis adalah **0 detik (tanpa batas)**.
   - Ketika Playwright hang pada `searchPage.evaluate()` di kueri 45, sistem tidak memiliki mekanisme interupsi global.
   - Proses tertahan selama 36 menit penuh sampai TCP keepalive atau interupsi OS memutus koneksi pada pukul 17:40:17.

---

## 4. FOKUS 3: AUDIT KEGAGALAN VERIFIKASI DAILY SET (0/3 VERIFIED)

### 4.1. Jebakan Redirect HTTP 302: `/dashboard` vs `/about`

Log melaporkan:
`Batch reconciliation | advertisedTotal=30 observedAccountBalanceDelta=0 verified=0/3`

Pemeriksaan alur penentuan URL pada `src/functions/activities/api/UrlReward.ts`:
- **Baris 254–260**:
  ```typescript
  const isDailySet =
      offerIdLower.includes('dailyset') ||
      offerIdLower.includes('child') ||
      (promotion.name || '').toLowerCase().includes('dailyset') ||
      (promotion.title || '').toLowerCase().includes('daily set')

  let targetDashboard = isDailySet ? 'https://rewards.bing.com/dashboard' : 'https://rewards.bing.com/earn'
  ```
  - Untuk aktivitas Daily Set, kode menetapkan `targetDashboard = 'https://rewards.bing.com/dashboard'`.
  - Untuk promosi lain ("Keep Earning"), kode menetapkan `targetDashboard = 'https://rewards.bing.com/earn'`.

Pada infrastruktur web modern Microsoft Rewards:
- URL `https://rewards.bing.com/dashboard` secara otomatis merespons HTTP 302 Redirect ke `https://rewards.bing.com/about` (halaman marketing statis pra-login/edukasi publik).
- Sebaliknya, URL `https://rewards.bing.com/earn` adalah rute SPA internal aktif yang memuat daftar penawaran akun dengan benar.

---

### 4.2. Siklus Bouncing pada Helper `ensureOnRewardsDashboard`

Pemeriksaan pada `src/functions/Workers.ts`:
- **Baris 24–38**:
  ```typescript
  export async function ensureOnRewardsDashboard(page: Page): Promise<void> {
      if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return
      try {
          const currentUrl = typeof page.url === 'function' ? page.url() : ''
          if (currentUrl.includes('/about') || !currentUrl.includes('rewards.bing.com/dashboard')) {
              await page
                  .goto('https://rewards.bing.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 15000 })
                  .catch(() => {})
              await page
                  .waitForSelector(
                      '#daily-sets, [data-bi-area*="DailySet"], #dailyset, .daily-set, [id*="dashboard"], [class*="dashboard"]',
                      { timeout: 4000 }
                  )
                  .catch(() => {})
          }
      } catch {}
  }
  ```

#### Mekanisme Terjebak (*Infinite Bounce*):
1. Helper memeriksa: `currentUrl.includes('/about')` $\rightarrow$ bernilai `true`.
2. Helper melakukan navigasi: `goto('https://rewards.bing.com/dashboard')`.
3. Server Microsoft seketika melempar redirect 302 kembali ke: `https://rewards.bing.com/about`!
4. Selector `#daily-sets` diuji hingga timeout 4000ms dan gagal karena elemen tersebut tidak ada pada `/about`.
5. Tab browser tetap berada di URL `/about`.

---

### 4.3. Mengapa "Keep Earning" Berhasil (+21 Poin) sedangkan "Daily Set" Gagal Total (0 Poin)

| Aspek Operasional | Daily Set (Gagal 0/3) | Keep Earning (Sukses +21 Poin) |
| :--- | :--- | :--- |
| **URL Navigasi Awal** | `https://rewards.bing.com/dashboard` | `https://rewards.bing.com/earn` |
| **Respons Server Bing** | 302 Redirect ke `rewards.bing.com/about` | 200 OK langsung merender Single Page App Rewards |
| **Interaksi DOM Tile** | Gagal menemukan elemen kartu (tidak ada klik tile dashboard) | Berhasil menemukan dan mengklik kartu promosi di halaman `/earn` |
| **Klaim URL Alternatif** | Membuka `destinationUrl` langsung tanpa aktivasi tile session | Terpicu via klik tile native dan parameter URL lengkap |
| **Verifikasi DOM & Saldo** | Gagal karena `ensureOnRewardsDashboard` memantul ke `/about` | Berhasil membaca kenaikan saldo dan tanda centang di `/earn` |
| **Hasil Rekonsiliasi** | Delta Saldo: 0, Centang: False $\rightarrow$ **0 Poin** | Delta Saldo: +21, Status: Verified $\rightarrow$ **+21 Poin** |

---

## 5. FOKUS 4: AUDIT PARITAS FITUR LINUX VS WINDOWS

### 5.1. Isolasi Kueri Lintas Akun (`QueryCore.sessionUsedQueries`)

Pemeriksaan pada `src/functions/QueryEngine.ts`:
- **Baris 9**:
  ```typescript
  export class QueryCore {
      public static sessionUsedQueries = new Set<string>()
  ```
- **Temuan Forensik**:
  - Variabel `sessionUsedQueries` dideklarasikan sebagai properti `static` milik kelas `QueryCore`.
  - Di seluruh codebase (`Search.ts`, `Workers.ts`, `index.ts`), **TIDAK ADA SATUPUN PERINTAH `sessionUsedQueries.clear()`** saat pergantian akun maupun saat inisialisasi runner!
  - **Dampak Lintas Akun**:
    - Kueri yang telah dieksekusi oleh Akun #1 disimpan permanen di dalam memori Node.js.
    - Ketika Akun #2 berjalan dalam proses yang sama, ratusan kueri dari Akun #1 diblokir karena dianggap *"already used in session"*.
    - Menjelang akun ke-5 atau ke-10, pool kueri menjadi kering (*query starvation*), memicu bot melakukan loop pencarian kueri fallback yang tidak relevan.
  - **Status Paritas**: **BELUM AKTIF / CACAT** (Memerlukan isolasi per akun atau pembersihan eksplisit saat `runAccountWorkflow` selesai).

---

### 5.2. Penanganan Desktop Client Hints (`HeadlessChrome`) & Spoofing WebGL Direct3D11 ANGLE

Pemeriksaan komparasi commit lokal Linux:
- **Commit `a808f60`** (*feat(webgl): spoof Direct3D11 ANGLE on Linux desktop to prevent Mesa driver leaks*):
  - Terpasang di `src/runtime/environment/BrowserEnvironmentPolicy.ts` baris 319–375.
  - Memalsukan WebGL Vendor menjadi: `'Google Inc. (Intel)'`
  - Memalsukan WebGL Renderer menjadi: `'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)'`.
  - Mengeliminasi bocoran driver Linux (`Mesa / llvmpipe / Gallium`).
- **Commit `3d63885`** (*feat(linux): enforce linux chromium stability flags and windows desktop fingerprint consistency*):
  - Terpasang di `BrowserEnvironmentPolicy.ts` baris 378–380 melalui override CDP `Emulation.setUserAgentOverride`.
  - Memastikan `Sec-CH-UA-Platform: "Windows"`, `navigator.platform: "Win32"`, dan menghapus string `HeadlessChrome` dari header HTTP native.
- **Status Paritas**: **SUDAH TERPASANG & AKTIF** pada branch Linux.

---

### 5.3. Status Sinkronisasi Mutex Sesi Manual (`ManualActionStore` & `ObserverLock`)

Perbandingan git diff antara branch lokal `v3` dengan branch Windows `origin/v3`:
- Local branch Linux `v3` berada di atas base commit `19e73da` dan telah mengimplementasikan:
  - `commit 02f8831 fix(session): preserve active writer lock ownership` di `AccountSessionStore.ts`.
  - `commit cdb615d fix(session): unify atomic Playwright storage state persistence`.
- Namun, pada `origin/v3` (Windows), terdapat subsistem Observer dan Manual Action Center yang belum dimerge:
  - `src/manual/ManualActionStore.ts`
  - `src/manual/ManualActionTypes.ts`
  - `src/manual/ObservationImporter.ts`
  - `src/manual/ObservationReconciler.ts`
  - `src/runtime/observer/ObserverLock.ts` (Single-writer lock untuk intervensi manual).
  - `src/runtime/observer/AccountEvidenceStore.ts`
- **Status Paritas**: **BELUM SINKRON**. Arsitektur mutex penyimpanan sesi dasar (`AccountSessionStore`) sudah ada di Linux, namun lapisan koordinasi aksi manual (`ManualActionStore` & `ObserverLock`) masih eksklusif berada di Windows (`origin/v3`).

---

## 6. RENCANA PERBAIKAN TERSTRUKTUR & LANGKAH IMPLEMENTASI

> [!IMPORTANT]
> Seluruh rencana perbaikan di bawah ini dirancang untuk mempertahankan arsitektur non-destruktif dan zero-regression. Tidak ada file kode yang diubah sebelum instruksi persetujuan diberikan oleh pengguna.

### Proposal 1: Remediasi Bug Infinite Loop Level-Up (`Search.ts` & `BrowserFunc.ts`)

1. **Penguncian Flag Level-Up (`isLevelUpHandled`)**:
   - Tambahkan variabel kontrol lokal sesi pencarian di `Search.ts`:
     ```typescript
     let isLevelUpHandled = false
     ```
   - Pada baris 176, ubah evaluasi kondisi menjadi:
     ```typescript
     if (counterDelta < 0 && !isLevelUpHandled) {
         isLevelUpHandled = true
         // Hitung ulang target berdasarkan kuota baru minus progres yang SUDAH didapat
         const currentEarnedPoints = Math.max(0, Number(this.bot.userData.currentPoints ?? 0) - Number(this.bot.userData.initialPoints ?? 0))
         newMissingPointsTotal = Math.max(0, newMissingPoints.totalPoints - currentEarnedPoints)
     ```
2. **Koreksi Data Fallback DAPI pada `BrowserFunc.ts`**:
   - Di `mapAppDataToDashboard` (baris 91):
     Jangan mengunci `pointProgress: 0` secara statis jika `this.cachedCounters` sudah memiliki progres pencarian valid. Gunakan progres riil dari cache atau biarkan bernilai sesuai progres sesi berjalan.

---

### Proposal 2: Remediasi Freeze 36 Menit & Timeout Guard (`Search.ts` & `index.ts`)

1. **Pembungkusan Timeout Eksplisit pada Operasi DOM `Search.ts`**:
   - Bungkus setiap pemanggilan `searchPage.evaluate()` dengan batasan `Promise.race`:
     ```typescript
     const inPageBalance = await Promise.race([
         searchPage.evaluate(() => { ... }),
         new Promise<null>((_, reject) => setTimeout(() => reject(new Error('EVAL_TIMEOUT')), 5000))
     ]).catch(() => null)
     ```
   - Pasang `await searchPage.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {})` tepat setelah `keyboard.press('Enter')`.
2. **Penerapan Deadline Barrier Universal pada Mode Sequential (`src/index.ts`)**:
   - Pindahkan logika `calculateDynamicDeadline` agar membungkus loop eksekusi mode `sequential` di baris 1572:
     ```typescript
     const dynamicDeadlineMs = calculateDynamicDeadline(100, 2 * 60 * 1000)
     const workerPromise = this.runAccountWorkflow(account)
     const timeoutPromise = new Promise<{ kind: 'timeout' }>(resolve => 
         setTimeout(() => resolve({ kind: 'timeout' }), dynamicDeadlineMs)
     )
     const raceResult = await Promise.race([
         workerPromise.then(val => ({ kind: 'completed' as const, val })),
         timeoutPromise
     ])
     if (raceResult.kind === 'timeout') {
         this.logger.error('main', 'ACCOUNT-DEADLINE', `[ACCOUNT-DEADLINE-EXCEEDED] Eksekusi akun ${account.email} melebihi batas waktu adaptif ${(dynamicDeadlineMs / 60000).toFixed(0)} menit!`)
         await this.cleanupBrowserResources()
     }
     ```

---

### Proposal 3: Remediasi Jalur Daily Set (`UrlReward.ts` & `Workers.ts`)

1. **Normalisasi Rute Dashboard ke `/earn`**:
   - Di `UrlReward.ts` baris 260, ubah target rute Daily Set dari `/dashboard` menjadi `/earn`:
     ```typescript
     let targetDashboard = 'https://rewards.bing.com/earn'
     ```
2. **Koreksi URL pada Helper `ensureOnRewardsDashboard` (`Workers.ts:28`)**:
   - Arahkan URL validasi dan fallback navigasi ke `https://rewards.bing.com/earn`:
     ```typescript
     export async function ensureOnRewardsDashboard(page: Page): Promise<void> {
         if (!page || (typeof page.isClosed === 'function' && page.isClosed())) return
         try {
             const currentUrl = typeof page.url === 'function' ? page.url() : ''
             if (currentUrl.includes('/about') || !currentUrl.includes('rewards.bing.com/earn')) {
                 await page.goto('https://rewards.bing.com/earn', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
                 await page.waitForSelector('#daily-sets, [data-bi-area*="DailySet"], .c-card, [class*="card"]', { timeout: 4000 }).catch(() => {})
             }
         } catch {}
     }
     ```
   Dengan perbaikan ini, browser tidak akan pernah terlempar ke landing page `/about`, dan semua kartu Daily Set dapat diverifikasi secara normal.

---

### Proposal 4: Remediasi Isolasi Kueri & Sinkronisasi Paritas

1. **Pembersihan `sessionUsedQueries` Antar Akun (`QueryEngine.ts`)**:
   - Tambahkan metode reset eksplisit:
     ```typescript
     public static resetSessionQueries(): void {
         QueryCore.sessionUsedQueries.clear()
     }
     ```
   - Panggil `QueryCore.resetSessionQueries()` pada siklus pembersihan akun di `src/index.ts` (`finally` block baris 1579).
2. **Sinkronisasi Terjadwal Modul Manual Action Windows**:
   - Rencanakan cherry-pick atau selective merge untuk submodul `ManualActionStore` dan `ObserverLock` dari `origin/v3` setelah stabilitas engine inti Linux dipulihkan.

---

**Laporan Audit Selesai**. Menunggu instruksi dan persetujuan pengguna sebelum melakukan perubahan file kode program.
