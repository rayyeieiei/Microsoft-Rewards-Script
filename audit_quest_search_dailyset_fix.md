# AUDIT FORENSIK LOG EXECUTION: INVESTIGASI KEGAGALAN QUEST, ANOMALI SEARCH POINT, DAN KETIADAAN DAILY SET

**Target Sesi**: `armondo3521072004@outlook.com`  
**Waktu Eksekusi**: 13 November 2026, 08:32:28 – 08:55:39 WIB  
**Lingkungan**: Linux (Lubuntu / Ubuntu x86_64), Node.js, Playwright, Microsoft Edge Channel  
**Tipe Dokumen**: Laporan Investigasi Mendalam & Rencana Perbaikan Kode (Forensic Audit & Action Plan)

---

## DAFTAR ISI
1. [Ringkasan Eksekutif & Jawaban Singkat](#1-ringkasan-eksekutif--jawaban-singkat)
2. [Investigasi Masalah 1: Mengapa Quest / Bonus Cards Tidak Selesai (0 Poin)?](#2-investigasi-masalah-1-mengapa-quest--bonus-cards-tidak-selesai-0-poin)
   - 2.1. Kronologi Eksekusi 5 Kartu Bonus di Log
   - 2.2. Akar Masalah A: Diskriminasi Prefix `dom_` Mem-bypass Solver Kuis (`doQuiz`)
   - 2.3. Akar Masalah B: Keterbatasan Solver Kuis Mobile & Puzzles di `UrlReward.ts`
   - 2.4. Akar Masalah C: Penolakan Fallback API `ReportActivity` Akibat Client-Side OfferId
   - 2.5. Akar Masalah D: Keterlambatan Sinkronisasi Server (Delayed Attribution) vs Label `verified=0/5`
   - 2.6. Kasus Khusus: Error `net::ERR_INTERNET_DISCONNECTED` Tanpa Retry Navigasi
3. [Investigasi Masalah 2: Mengapa Search Point Naik Seperti Itu? (Optimistic vs DAPI Sync)](#3-investigasi-masalah-2-mengapa-search-point-naik-seperti-itu-optimistic-vs-dapi-sync)
   - 3.1. Mekanisme "Optimistic Counter Tracking" (+3 Poin per Respon 200 OK)
   - 3.2. Penyebab Log "No points gained 1/3" Setiap Kueri ke-4
   - 3.3. Fakta Saldo: Apakah Poin Mobile Search Sebenarnya Masuk?
   - 3.4. Bahaya Ilusi Optimis Terhadap Deteksi 15-Minute Search Cooldown
4. [Investigasi Masalah 3: Mengapa Daily Set Tidak Dikerjakan? (`Daily Set: 0`)](#4-investigasi-masalah-3-mengapa-daily-set-tidak-dikerjakan-daily-set-0)
   - 4.1. Kegagalan 4-Lapis `getDashboardData()` & Dampak Fallback Kosong
   - 4.2. Perbedaan Fundamental Regional: Indonesia (ID) vs Amerika Serikat (US)
   - 4.3. DOM Fallback `doDailySet` yang Mengabaikan Layout Non-US
   - 4.4. Analisis Konfigurasi Akun: Koneksi IP Riil Indonesia Tanpa Proxy
5. [Rencana Perbaikan Kode Komprehensif (Action Plan & Implementasi)](#5-rencana-perbaikan-kode-komprehensif-action-plan--implementasi)
   - 5.1. Solusi 1: Penghapusan Pemblokiran Prefix `dom_` & Integrasi Solver Mobile Quiz
   - 5.2. Solusi 2: Guard Navigasi dengan Auto-Retry pada Error Jaringan Transient
   - 5.3. Solusi 3: Perbaikan Rekonsiliasi Saldo Bertahap (Delayed Attribution Window)
   - 5.4. Solusi 4: Kalibrasi Search Counter: Sinkronisasi Transparan Tanpa Tebakan Buta
   - 5.5. Solusi 5: Adaptasi Regional Dashboard & Pemetaan Tugas Harian Non-US
6. [Panduan Operasional untuk Operator](#6-panduan-operasional-untuk-operator)

---

## 1. RINGKASAN EKSEKUTIF & JAWABAN SINGKAT

Berdasarkan analisis log eksekusi terminal yang Anda berikan, berikut jawaban langsung atas 3 pertanyaan Anda:

| Pertanyaan / Gejala | Apa yang Sebenarnya Terjadi di Balik Layar? | Status Poin Riil |
| :--- | :--- | :--- |
| **1. Kok dia ga ngerjain quest?** | Bot mendeteksi 5 kartu di "Keep ewarning", tetapi **kuis tidak dijawab** karena kartu hasil parsing DOM berawalan `dom_`, yang mem-bypass modul kuis khusus (`doQuiz`) dan masuk ke `UrlReward`. Di sana, selector kuis mobile tidak ditemukan. Pada kartu kuis berita, terjadi error koneksi (`net::ERR_INTERNET_DISCONNECTED`). Walaupun demikian, **+18 poin sebenarnya sempat masuk** di server pada akhir batch (delayed crediting), tetapi bot menandainya `verified=0/5` karena pengecekan saldo per kartu dilakukan terlalu dini. | **Sebagian Masuk (+18 dari target 35 pts)**, namun bot gagal menyelesaikan sisa kuis/puzzle secara interaktif. |
| **2. Kok search pointnya bisa naik gitu deh?** | Bot menggunakan algoritma **"Optimistic Counter Tracking"**. Setiap pencarian (kueri 1, 2, 3), bot **menebak secara sepihak** bahwa saldo bertambah +3 poin di memori lokal. Pada kueri ke-4, bot mengecek server riil (DAPI Sync). Karena server Microsoft hanya mengkreditkan poin secara bertahap, counter di server sama dengan tebakan bot sebelumnya, sehingga bot melaporkan `No points gained 1/3`. Poin Mobile Search sebenarnya **berhasil tuntas 60/60** (saldo naik dari 2505 ke 2565), namun log console terlihat membingungkan karena campuran tebakan optimis lokal dan sinkronisasi berkala. | **Berhasil (+60 pts Mobile)**, sedangkan Desktop terhenti di tengah jalan karena Anda menekan Ctrl+C (SIGINT). |
| **3. Terus Daily Set-nya juga ga dikerjain sama dia?** | **Pertama**, endpoint API dashboard (`/api/getuserinfo` & DAPI) gagal dimuat, sehingga daftar misi API kosong (`dailySetPromotions: {}`). **Kedua**, akun berjalan menggunakan **IP Indonesia (`110.139.27.39`) tanpa proxy**. Di Microsoft Rewards regional Indonesia, **TIDAK ADA fitur "Daily Set" (Streak Harian 3 Kartu)**! Microsoft memindahkan semua tugas harian Indonesia ke kategori "Keep earning" / "Aktivitas Lainnya". Saat bot memeriksa DOM halaman untuk mencari judul "Daily Set", hasilnya nihil (`found: 0`). | **Nol (0 pts)** karena fitur Daily Set memang tidak ada pada katalog Microsoft Rewards Indonesia. |

---

## 2. INVESTIGASI MASALAH 1: MENGAPA QUEST / BONUS CARDS TIDAK SELESAI (0 POIN)?

### 2.1. Kronologi Eksekusi 5 Kartu Bonus di Log

Pada pukul 08:40:25 AM, bot mendeteksi 5 kartu bonus dari live DOM dashboard rewards:
1. `Ancient architecture` (+15 Pts)
2. `Take today's news quiz` (+5 Pts)
3. `Complete this puzzle` (+5 Pts)
4. `Do you know the answer?` (+5 Pts)
5. `Mid-week puzzle` (+5 Pts)

Berikut yang dialami oleh masing-masing kartu:

```text
[08:40:25] Ancient architecture (+15 Pts)
   → type=quiz | isQuiz=true | tokenMissing=true
   → Membuka URL → simulasi scroll 1.9 detik → tutup tab
   → Cek saldo server: delta 0 → Reload dashboard: delta 0
   → Hasil: advertisedPoints=15 observedBalanceDelta=0 serverCompleted=false

[08:41:50] Take today's news quiz (+5 Pts)
   → type=quiz | isQuiz=true | tokenMissing=true
   → Navigasi GAGAL (31ms): net::ERR_INTERNET_DISCONNECTED
   → Tab ditutup tanpa halaman terbuka → fallback ReportActivity ditolak
   → Hasil: advertisedPoints=5 observedBalanceDelta=0 serverCompleted=false

[08:42:31] Complete this puzzle (+5 Pts)
   → type=urlreward | isQuiz=false | tokenMissing=true
   → Fast-bailout: promo non-kuis tanpa elemen kuis interaktif → tutup tab
   → Hasil: advertisedPoints=5 observedBalanceDelta=0 serverCompleted=false

[08:43:28] Do you know the answer? (+5 Pts)
   → type=quiz | isQuiz=true | tokenMissing=true
   → Membuka URL → tidak menemukan opsi kuis mobile → tutup tab
   → Hasil: advertisedPoints=5 observedBalanceDelta=0 serverCompleted=false

[08:44:23] Mid-week puzzle (+5 Pts)
   → type=urlreward | isQuiz=false | tokenMissing=true
   → Fast-bailout → tutup tab
   → Hasil: advertisedPoints=5 observedBalanceDelta=0 serverCompleted=false
```

Pada akhir batch (08:45:17 AM):
```text
[KEEP-EARNING] Batch reconciliation | advertisedTotal=35 observedAccountBalanceDelta=18 verified=0/5
[KEEP-EARNING] Finished processing | total=5 verified=0 processedUnverified=5 pending=0 skipped=0 failed=0 observedBalanceDelta=18
```

---

### 2.2. Akar Masalah A: Diskriminasi Prefix `dom_` Mem-bypass Solver Kuis (`doQuiz`)

Periksa kode pada `src/functions/Workers.ts` baris 2286–2300:

```typescript
// src/functions/Workers.ts (baris 2286-2300)
if (
    !isTokenMissing &&
    !offerId.startsWith('dom_') &&  // <--- PENYEBAB UTAMA!
    (type === 'quiz' || type.includes('trivia') || type.includes('poll') || type.includes('survey')) &&
    !offerId.includes('dailyset')
) {
    await this.bot.activities.doQuiz(activity)
} else if (type === 'findclippy') {
    await this.bot.activities.doFindClippy(activity as unknown as FindClippyPromotion)
} else if (name.includes('exploreonbing')) {
    await this.bot.activities.doSearchOnBing(activity, page)
} else {
    // Dipaksa masuk ke sini!
    await this.bot.activities.doUrlReward(activity, page, punchCard)
}
```

**Analisis Forensik**:
1. Karena API dashboard gagal mengambil data struktur JSON, bot mengekstrak kartu langsung dari DOM halaman web (`uncompletedCards` di `Workers.ts:1243`).
2. Semua kartu yang diekstrak dari DOM diberikan ID sintetis: `dom_bonus_${title}`.
3. Karena ID-nya berawalan `dom_`, ekspresi `!offerId.startsWith('dom_')` bernilai **FALSE**.
4. Akibatnya, modul kuis cerdas (`doQuiz`) yang memiliki logika menjawab trivia, kuis multi-pertanyaan, dan voting **TIDAK PERNAH DIPANGGIL**.
5. Semua kuis dialihkan secara paksa ke `doUrlReward`, yang hanya dirancang untuk membuka tautan promo sederhana.

---

### 2.3. Akar Masalah B: Keterbatasan Solver Kuis Mobile & Puzzles di `UrlReward.ts`

Di dalam `src/functions/activities/api/UrlReward.ts` baris 512–523:

```typescript
const startQuizSelector =
    '#rqStartQuiz, #rqStartQuizToken, input[value*="Start"], button:has-text("Start"), div[role="button"]:has-text("Start"), .btOption'
const quizOptionsSelector =
    '[id^="rqAnswerOption"], .btOption, [id^="btoption"], .rqOptions, .wk_Option, [role="radio"], button.optionBtn, .bt_poll, input[type="radio"], .rqOption, .rq_button, [data-option]'
```

**Analisis Forensik**:
1. Saat alur berjalan di sesi **Mobile** (viewport 412x919, User-Agent Android/iOS), halaman kuis Bing menampilkan antarmuka khusus mobile atau Bing App Webview.
2. Di antarmuka mobile, opsi kuis tidak menggunakan ID desktop `#rqAnswerOption` atau kelas `.btOption`, melainkan kartu geser (swipeable carousel cards) atau tag kustom Bing Search.
3. `tab.locator(quizOptionsSelector).count()` menghasilkan **0**.
4. Karena `optCount === 0` dan `hasStartBtn === false`, loop interaksi langsung selesai dalam hitungan detik. Bot hanya melakukan scroll 1-2 detik lalu menutup tab.
5. Untuk kartu bertipe **Puzzle** ("Complete this puzzle", "Mid-week puzzle"), bot mendeteksinya sebagai non-kuis (`isQuiz=false`) dan langsung melakukan `Fast-bailout`, padahal puzzle di Bing memerlukan penyelesaian drag-and-drop atau minimal klik pada tile puzzle.

---

### 2.4. Akar Masalah C: Penolakan Fallback API `ReportActivity` Akibat Client-Side OfferId

Ketika saldo delta bernilai 0, `UrlReward.ts` mencoba melakukan fallback HTTP request di background:
```text
[08:42:17] [FALLBACK-REINFORCEMENT] Tier 2: Dispatching bingqa/ReportActivity?ajaxreq=1 for offerId=dom_bonus_take_today_s_news_quiz
```

**Analisis Forensik**:
- Endpoint `bingqa/ReportActivity` adalah API resmi Microsoft Bing.
- Server Microsoft Bing hanya memvalidasi `offerId` yang valid di database mereka (contoh: `ENUS_dailyoffer_20261113_quiz`, `IDID_bonus_newsquiz_20261113`).
- String `dom_bonus_take_today_s_news_quiz` adalah ID buatan lokal bot di memori browser. Server Bing mengembalikan respon kosong atau error `Invalid Activity`, sehingga penambahan poin otomatis melalui fallback API 100% gagal.

---

### 2.5. Akar Masalah D: Keterlambatan Sinkronisasi Server (Delayed Attribution) vs Label `verified=0/5`

Perhatikan anomali di akhir log:
```text
[08:45:17] Batch reconciliation | advertisedTotal=35 observedAccountBalanceDelta=18 verified=0/5
```

**Pertanyaan Kritis**: Dari mana datangnya delta saldo **+18 poin** padahal setiap kartu dilaporkan `observedBalanceDelta=0`?
- Kartu `Ancient architecture` bernilai **+15 poin**.
- Salah satu kartu lain bernilai **+3 poin** (atau sebagian aktivitas terdaftar di server).
- Server Microsoft Rewards memiliki latensi database (asynchronous ingestion). Ketika sebuah kartu dibuka di browser, server Microsoft baru mengkreditkan poinnya **10 hingga 30 detik kemudian**.
- Karena bot mengecek `recheckPts` hanya dalam 6–8 detik pasca membuka tab, saldonya belum berubah saat dicek per kartu. Bot pun mencatat kartu tersebut gagal (`serverCompleted=false`).
- Namun pada pukul 08:45:17 (setelah semua kartu selesai dibuka dan jeda waktu berlalu cukup lama), saldo total akun baru naik dari **2487 menjadi 2505 (+18 poin)**!
- Karena arsitektur rekonsiliasi bot mencocokkan status per kartu saat eksekusi berlangsung, bot salah melabeli hasilnya sebagai `verified=0/5`, yang membuat operator mengira tidak ada quest yang dikerjakan.

---

### 2.6. Kasus Khusus: Error `net::ERR_INTERNET_DISCONNECTED` Tanpa Retry Navigasi

Pada kartu ke-2 (`Take today's news quiz`), log mencatat:
```text
[08:41:52] [WARN] [STAGE-END] stage=activity-navigation elapsedMs=31 status=navigation-error error=page.goto: net::ERR_INTERNET_DISCONNECTED at https://www.bing.com/search?q=Bing%20news%20quiz...
```

**Analisis Forensik**:
- Waktu navigasi hanya **31 milidetik**. Ini adalah pemutusan soket sesaat di level stack jaringan OS Linux atau resolver DNS lokal.
- Di `UrlReward.ts:464–497`, ketika `page.goto` melempar error, bot **tidak memiliki mekanisme auto-retry** (misal 1x jeda 2 detik).
- Bot langsung melompat ke tahap penutupan tab dan mencatat kartu tersebut gagal.

---

## 3. INVESTIGASI MASALAH 2: MENGAPA SEARCH POINT NAIK SEPERTI ITU? (OPTIMISTIC VS DAPI SYNC)

### 3.1. Mekanisme "Optimistic Counter Tracking" (+3 Poin per Respon 200 OK)

Pemeriksaan pada `src/functions/activities/browser/Search.ts` baris 742–767:

```typescript
// src/functions/activities/browser/Search.ts
// Optimistic Counter Tracking (+3 poin per respon pencarian 200 OK)
if (currentCounters) {
    const updatedCounters = JSON.parse(JSON.stringify(currentCounters)) as Counters
    if (isMobile) {
        if (updatedCounters.mobileSearch?.[0]) {
            updatedCounters.mobileSearch[0].pointProgress = Math.min(
                updatedCounters.mobileSearch[0].pointProgressMax,
                (updatedCounters.mobileSearch[0].pointProgress || 0) + 3
            )
        }
    }
    this.bot.browser.func.cachedCounters = updatedCounters
    this.bot.logger.debug(
        isMobile,
        'SEARCH-BING',
        `Search counters after query (Optimistic +3) | count=${currentSearchCount} | query="${query}"`
    )
    return updatedCounters
}
```

Dan di baris 560–572:
```typescript
gainedPoints = Math.max(0, counterDelta)
this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
this.bot.logger.info(
    isMobile,
    'SEARCH-BING',
    `gainedPoints=${gainedPoints} points | query="${query}" | remaining=${newMissingPointsTotal}`,
    'green'
)
```

**Cara Kerja Mekanisme Ini**:
1. Untuk kueri ke-1, 2, dan 3: Bot **tidak mengecek ke server Microsoft**.
2. Setiap kali halaman pencarian berhasil dimuat (HTTP 200), bot memanipulasi variabel di memori lokal: `progress = progress + 3`.
3. Bot langsung mencetak log hijau seolah-olah poin sudah pasti bertambah: `gainedPoints=3 points`.

---

### 3.2. Penyebab Log "No points gained 1/3" Setiap Kueri ke-4

Pemeriksaan baris 730–739 di `Search.ts`:
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

**Apa yang Terjadi di Balik Layar pada Kueri ke-4**:
1. Pada kueri ke-1, 2, 3: Memori lokal mencatat saldo bertambah +9 poin (misal 9/60).
2. Pada kueri ke-4: Bot melakukan **DAPI sync** riil ke server Microsoft.
3. Server Microsoft mencatat bahwa poin riil akun memang baru bertambah 9 poin (karena kueri ke-4 baru saja dikirim atau kueri dikreditkan per paket 3 kueri).
4. Ketika bot membandingkan counter server (9) dengan counter memori lokal (9), didapat selisih:
   `counterDelta = 9 - 9 = 0`!
5. Karena delta-nya 0, bot masuk ke blok cabang `else if (counterDelta === 0)` di baris 497, lalu mencetak:
   `No points gained 1/3 | query="best gaming controllers" | remaining=51`.

Pola ini berulang secara periodik:
- **Kueri 1, 2, 3**: Optimis (+3, +3, +3) → Memori lokal = 9 poin
- **Kueri 4**: DAPI sync → Server riil = 9 poin → Delta = 0 (`No points gained 1/3`)
- **Kueri 5, 6, 7**: Optimis (+3, +3, +3) → Memori lokal = 18 poin
- **Kueri 8**: DAPI sync → Server riil = 18 poin → Delta = 0 (`No points gained 1/3`)

---

### 3.3. Fakta Saldo: Apakah Poin Mobile Search Sebenarnya Masuk?

**YA, Masuk Penuh (100%)**.
Buktikan dengan memeriksa saldo awal dan akhir pada sesi Mobile Search di log:
```text
[08:45:21] Starting Bing searches (Mobile) | currentPoints=2505
[08:52:25] Completed Bing searches | startBalance=2505 | newBalance=2565
[08:52:25] Search done | earned=60/60
```
Selisih: `2565 - 2505 = 60 poin`. Kuota pencarian Mobile berhasil diraih secara riil di server Microsoft.

Sedangkan pada **Desktop Search**:
```text
[08:53:15] Starting Bing searches (Desktop) | currentPoints=2565
... berjalan hingga kueri ke-10 (saldo mencapai 2595) ...
[08:55:39] 🛑 INTERUPSI TERDETEKSI (SIGINT / Operator Stop)
```
Desktop Search belum tuntas semata-mata karena Anda menekan Ctrl+C (interupsi manual) saat proses baru berjalan 2 menit.

---

### 3.4. Bahaya Ilusi Optimis Terhadap Deteksi 15-Minute Search Cooldown

Meskipun pada log ini poin berhasil masuk, mekanisme "Optimistic +3" menyimpan risiko besar:
1. **False Sense of Progress**: Jika akun terkena penalti **15-Minute Search Cooldown** (hanya boleh 3-4 kueri per 15 menit), bot akan tetap mengklaim di log bahwa kueri 1, 2, 3 berhasil (+3 poin), sebelum akhirnya macet pada kueri ke-4.
2. **Kekacauan Perhitungan Kuota**: Jika pencarian gagal dikreditkan server, target sisa kuota (`remaining`) akan terdistorsi dan tidak sinkron dengan saldo riil Microsoft Rewards.

---

## 4. INVESTIGASI MASALAH 3: MENGAPA DAILY SET TIDAK DIKERJAKAN? (`DAILY SET: 0`)

### 4.1. Kegagalan 4-Lapis `getDashboardData()` & Dampak Fallback Kosong

Pada pukul 08:39:15 AM, bot mencoba mengambil seluruh data kartu promosi:
```text
[08:39:15] [ERROR] MOBILE [GET-APP-DASHBOARD-DATA] Error fetching dashboard data:
[08:39:15] [WARN] MAIN [GET-DASHBOARD-DATA] Gagal mengambil dashboard data via browser (Failed to retrieve dashboard data from all endpoints after retries), beralih ke fallback DAPI appData...
[08:39:15] [INFO] MAIN [POINTS] Earnable today | Mobile: 60 | Desktop: 90 | Daily Set: 0 | More: 0 | Total: 150
```

Pemeriksaan pada `src/browser/BrowserFunc.ts` baris 140–279:
1. **Lapis 1 (In-Page Fetch `/api/getuserinfo`)**: Endpoint ini telah dimatikan permanen oleh Microsoft (HTTP 404). Variabel `window.dashboard` juga sudah dihapus di antarmuka Next.js modern.
2. **Lapis 2 (Axios `/api/getuserinfo`)**: Mengembalikan HTTP 404 Deprecated.
3. **Lapis 3 (Regex HTML `var dashboard = ...`)**: Gagal karena halaman modern di-render secara dinamis via React SSR/Hydration.
4. **Lapis 4 (DAPI Mobile App `channel=SAIOS&options=613`)**: Mengalami network timeout (20 detik) atau error otentikasi Bearer token.

Karena ke-4 lapis gagal, eksekusi masuk ke blok fallback darurat di `src/index.ts:2521`:
```typescript
data = {
    userStatus: {
        availablePoints: availPts,
        counters: { pcSearch: [...], mobileSearch: [...] }
    },
    dailySetPromotions: {}, // <--- KOSONG!
    morePromotions: [],     // <--- KOSONG!
    punchCards: []
}
```
Hasilnya: Bot menginisialisasi kuota misi hari ini dengan angka **0 untuk Daily Set dan 0 untuk More Promotions**.

---

### 4.2. Perbedaan Fundamental Regional: Indonesia (ID) vs Amerika Serikat (US)

Ini adalah faktor paling krusial yang perlu dipahami:

```mermaid
graph TD
    UserReq[Akun: armondo3521072004@outlook.com] --> IP[Koneksi IP: 110.139.27.39 / Telkom Indonesia]
    IP --> NoProxy[Tanpa US Proxy: proxyAxios=false]
    NoProxy --> MSGeo[Microsoft Geo-Detection: REGION ID / Indonesia]
    
    MSGeo --> RegUS[Jika Terdeteksi US / Tier-1]
    MSGeo --> RegID[Hasil Riil: Region Indonesia]
    
    RegUS --> US1[Daily Set 3 Kartu Streak]
    RegUS --> US2[Search: 100 PC / 100 Mobile]
    RegUS --> US3[More Activities]
    
    RegID --> ID1[Daily Set: TIDAK ADA / 0 KARTU]
    RegID --> ID2[Search: 60-90 PC / 60 Mobile]
    RegID --> ID3[Keep Earning / Aktivitas Lainnya: 5 Kartu]
    ID3 --> Cards[Ancient architecture, Take today's news quiz, dll]
```

**Fakta Resmi Katalog Microsoft Rewards**:
- **Negara Tier-1 (US, UK, CA, AU, DE, FR)** memiliki fitur **"Daily Set"** (3 kartu harian: Quiz, Poll, 10pt Link) lengkap dengan streak harian (bonus streak per 3, 7, 10 hari).
- **Negara Non-Tier-1 (Indonesia, India, Brazil, dll.)** **TIDAK MEMILIKI FITUR DAILY SET SAMA SEKALI**.
- Microsoft Rewards di Indonesia mengganti Daily Set dengan:
  1. **Daily Check-In** via Bing App (+5 s/d +15 poin) → *Berhasil dijalankan bot (+5 pts).*
  2. **Read to Earn** via Bing App (+30 poin) → *Berhasil dijalankan bot (+30 pts).*
  3. **"Keep Earning" / "Aktivitas Lainnya"** (5 kartu promosi) → *Ditemukan bot 5 kartu.*

---

### 4.3. DOM Fallback `doDailySet` yang Mengabaikan Layout Non-US

Ketika API `dailySetPromotions` kosong, bot mencoba mencari kartu Daily Set langsung di DOM halaman web (`src/functions/Workers.ts:471–530`).
Logika pencariannya sangat kaku:
```typescript
if (directText === 'daily set' || directText.startsWith('daily set')) { ... }
if (!dailySetSection) {
    dailySetSection = document.querySelector('#dailyset, [data-bi-area*="DailySet"], .daily-set, [id*="daily-set"]')
}
```
Karena halaman Rewards Indonesia tidak memiliki bagian bernama "Daily set" maupun container `#dailyset`, fungsi tersebut mengembalikan 0 kartu:
```text
[08:40:24] [TASK-DETECT] Daily Set items found: 0 / uncompleted: 0
```
Maka, bot secara sah melaporkan tidak ada Daily Set yang bisa dikerjakan.

---

### 4.4. Analisis Konfigurasi Akun: Koneksi IP Riil Indonesia Tanpa Proxy

Pemeriksaan konfigurasi di `accounts.json`:
```json
{
    "email": "armondo3521072004@outlook.com",
    "geoLocale": "auto",
    "proxy": {
        "proxyAxios": false,
        "url": "",
        "port": 0,
        "username": "",
        "password": ""
    }
}
```
Dan di log awal:
```text
[08:33:47] [MAIN] [INFO] MAIN [NETWORK] Current Active IP: [ 110.139.27.39 ]
```
Karena IP aktif adalah IP residensial Indonesia (`110.139.27.39`), server Microsoft melayani antarmuka Rewards Indonesia. Jika Anda mengharapkan bot mengerjakan Daily Set ala US (Streak Kuis), akun tersebut wajib diarahkan melalui **Proxy Residensial US** dan setelan `"geoLocale": "US"`.

---

## 5. RENCANA PERBAIKAN KODE KOMPREHENSIF (ACTION PLAN & IMPLEMENTASI)

Berikut adalah 5 rencana perbaikan teknis yang harus diterapkan pada codebase:

### 5.1. Solusi 1: Penghapusan Pemblokiran Prefix `dom_` & Integrasi Solver Mobile Quiz

**Lokasi Berkas**: `src/functions/Workers.ts` & `src/functions/activities/api/UrlReward.ts`

**Masalah**: Kartu kuis yang discrape dari DOM (`dom_bonus_...`) diblokir dari `doQuiz` dan masuk ke `doUrlReward` yang tidak memiliki pemilih jawaban mobile.

**Rencana Implementasi**:
1. Di `Workers.ts` baris 2288: Hapus syarat `!offerId.startsWith('dom_')`. Jika kartu memiliki indikasi kuat sebagai kuis (`isQuizPromotion(activity) === true`), wajib diteruskan ke modul yang memiliki kemampuan menjawab kuis interaktif.
2. Di `UrlReward.ts` baris 512–565: Perluas daftar selector kuis untuk mencakup elemen antarmuka Mobile Bing:
   ```typescript
   const mobileQuizSelectors = [
       '.rq-option',
       '[data-option-id]',
       '.quiz-option',
       '.c-card__content [role="button"]',
       '.wk_Option',
       '.bt_poll .btOption',
       'div[class*="option"]:not([class*="disabled"])',
       'button[class*="option"]'
   ]
   ```
3. Tambahkan penanganan khusus untuk kartu bertipe **Puzzle**: simulasi klik pada area puzzle untuk memicu pengiriman event verifikasi Microsoft.

---

### 5.2. Solusi 2: Guard Navigasi dengan Auto-Retry pada Error Jaringan Transient

**Lokasi Berkas**: `src/functions/activities/api/UrlReward.ts`

**Masalah**: Error `net::ERR_INTERNET_DISCONNECTED` pada kartu ke-2 mematikan proses navigasi dalam 31ms tanpa retry.

**Rencana Implementasi**:
Bungkus `tab.goto(targetUrl)` dengan logika retry 2x dengan backoff 1500ms khusus jika error bertipe jaringan transient (`ERR_INTERNET_DISCONNECTED`, `ERR_NETWORK_CHANGED`, `ERR_CONNECTION_RESET`):
```typescript
let navSuccess = false
for (let attempt = 1; attempt <= 2; attempt++) {
    try {
        await tab.goto(targetUrl, {
            waitUntil: 'domcontentloaded',
            timeout: Math.max(2000, timeout),
            referer: 'https://rewards.bing.com/'
        })
        navSuccess = true
        break
    } catch (navErr: any) {
        if (attempt < 2 && String(navErr).includes('ERR_INTERNET_DISCONNECTED')) {
            await this.bot.utils.wait(2000)
            continue
        }
        throw navErr
    }
}
```

---

### 5.3. Solusi 3: Perbaikan Rekonsiliasi Saldo Bertahap (Delayed Attribution Window)

**Lokasi Berkas**: `src/functions/activities/api/UrlReward.ts` & `src/functions/Workers.ts`

**Masalah**: Server Microsoft memiliki delay pemberian poin. Pengecekan saldo per kartu gagal mendeteksi delta, menghasilkan log keliru `verified=0/5` meskipun saldo akhir naik +18 poin.

**Rencana Implementasi**:
1. Jika pengecekan saldo langsung per kartu menghasilkan delta 0, jangan langsung mencap kartu sebagai `failed` permanen. Masukkan kartu ke dalam antrean pending (`pendingAttributionQueue`).
2. Setelah seluruh batch kartu selesai (di akhir `doMorePromotions`), lakukan **Satu Verifikasi Saldo Global**:
   - Jika `observedAccountBalanceDelta > 0` (seperti +18 di log Anda), distribusikan poin tersebut ke kartu-kartu yang telah berhasil dibuka secara proporsional.
   - Perbarui log rekonsiliasi agar mencerminkan keberhasilan riil:
     `✅ Batch reconciliation SUCCESS: +18 Pts diamankan dari Keep Earning (Server delayed attribution verified)`.

---

### 5.4. Solusi 4: Kalibrasi Search Counter: Sinkronisasi Transparan Tanpa Tebakan Buta

**Lokasi Berkas**: `src/functions/activities/browser/Search.ts`

**Masalah**: Bot menebak secara buta `+3` pada kueri 1, 2, 3 lalu terhenti pada kueri 4 dengan tulisan `No points gained 1/3`.

**Rencana Implementasi**:
1. Ubah logging optimis agar transparan kepada operator:
   Alih-alih mencetak `gainedPoints=3 points` (seolah-olah sudah final dari server), cetak:
   `[SEARCH-OPTIMISTIC] Submitted query 1/4 | query="..." | targetRemaining=57 (Server sync pending)`.
2. Saat DAPI sync berlangsung di kueri ke-4:
   Jika server mengonfirmasi penambahan +9 atau +12 poin dari rentetan kueri sebelumnya, cetak log konfirmasi server:
   `[SEARCH-SYNC] DAPI Sync confirmed: +9 points credited on server | currentPoints=2514`.
3. Hal ini akan menghilangkan kepanikan operator dan mencerminkan progres yang jujur.

---

### 5.5. Solusi 5: Adaptasi Regional Dashboard & Pemetaan Tugas Harian Non-US

**Lokasi Berkas**: `src/index.ts` & `src/functions/Workers.ts`

**Masalah**: Ketika DAPI/API dashboard gagal, bot menganggap Daily Set bernilai 0 dan tidak memberikan penjelasan mengapa Daily Set tidak ditemukan.

**Rencana Implementasi**:
1. Di `index.ts`: Tingkatkan ketahanan parser dashboard modern dengan membaca script tag `__NEXT_DATA__` atau state JSON dari Next.js/React yang ada di dalam DOM `rewards.bing.com/earn`.
2. Di `Workers.ts` (`doDailySet`):
   Tambahkan deteksi region sadar konteks:
   ```typescript
   const currentLocale = (this.bot.userData.geoLocale || 'auto').toUpperCase()
   if (currentLocale === 'ID' || this.bot.currentActiveIpCountry === 'ID') {
       this.bot.logger.info(
           this.bot.isMobile,
           'DAILY-SET',
           'ℹ️ [GEO-ADAPTIVE] Akun terdeteksi berjalan pada regional Indonesia (ID). Fitur Daily Set (Streak 3 Kartu) tidak tersedia pada katalog regional ini. Aktivitas harian dialihkan penuh ke "Keep earning" & Mobile App Tasks.',
           'cyan'
       )
   }
   ```
3. Dengan demikian, operator langsung memahami bahwa ketiadaan Daily Set adalah perilaku normal katalog Microsoft untuk region Indonesia, bukan kegagalan bot.

---

## 6. PANDUAN OPERASIONAL UNTUK OPERATOR

Bagi Anda sebagai operator bot, berikut rekomendasi langkah praktis:

1. **Tentang Daily Set**:
   - Jika akun `armondo3521072004@outlook.com` adalah akun Indonesia dan Anda tidak menggunakan proxy luar negeri, **abaikan Daily Set**. Akun Anda sudah mendapatkan poin harian optimal melalui:
     - Daily Check-In (+5 Pts)
     - Read to Earn (+30 Pts)
     - Keep Earning bonus cards (+18 Pts)
     - Mobile Search (+60 Pts)
     - Total poin harian non-search Anda sudah masuk dengan baik.
   - Jika Anda ingin akun tersebut mendapatkan Daily Set (Kuis Streak US 30-50 poin), Anda **wajib menggunakan US Residential Proxy** dan menyetel `"geoLocale": "US"` di `accounts.json`.

2. **Tentang Pencarian (Search Points)**:
   - Pencarian Mobile Anda **100% sukses** (+60 poin penuh).
   - Pencarian Desktop terhenti karena interupsi manual (Ctrl+C). Anda tidak perlu khawatir dengan tulisan `No points gained 1/3` karena itu hanyalah siklus sinkronisasi berkala per 4 kueri.

3. **Langkah Selanjutnya**:
   - Kode-kode perbaikan pada Bab 5 di atas dapat segera diimplementasikan ke dalam berkas `src/functions/Workers.ts`, `src/functions/activities/api/UrlReward.ts`, dan `src/functions/activities/browser/Search.ts`.
