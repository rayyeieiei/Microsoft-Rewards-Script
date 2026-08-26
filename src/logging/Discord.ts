import axios, { AxiosRequestConfig } from 'axios'
import PQueue from 'p-queue'
import type { LogLevel } from './Logger'

const DISCORD_LIMIT = 2000

// ================= AREA SETTING DISCORD LU =================
// GANTI PAKE ID DISCORD LU BRE (Klik kanan profil Discord lu -> Copy User ID)
const MY_DISCORD_ID = '877734448685260820'
// ===========================================================

export interface DiscordConfig {
    enabled?: boolean
    url: string
}

const discordQueue = new PQueue({
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

function truncate(text: string) {
    return text.length <= DISCORD_LIMIT ? text : text.slice(0, DISCORD_LIMIT - 14) + ' …(truncated)'
}

// ================= SINKRONISASI LOG DISCORD TERBARU =================
function translateLog(content: string): { text: string; isImportant: boolean; shouldSend: boolean } {
    let text = content

    // Filter Noise / Log teknis internal yang bikin spam channel Discord
    const spamPatterns = [
        'Waiting between',
        'Simulating safe scroll',
        'cluster expanded',
        'clusters flattened',
        'clusters shuffled',
        'baseTopics',
        'finalQueries',
        'Ghost-Click',
        'Bezier curve',
        'Saving ',
        'cookies.',
        'All browser resources closed',
        'State check iteration',
        'verifyBingSession',
        'BROWSER-FINGERPRINT',
        'Starting bingSearch',
        'Submitted query to Bing',
        'Search counters after query',
        'Resolving search queries',
        'Returning to home page',
        'empty suggestions',
        'empty related terms',
        'Activating Request Interceptor',
        'Browser ready',
        'Calling login handler',
        'Login completed',
        'Desktop session ready',
        'Init desktop session'
    ]

    if (spamPatterns.some(p => content.includes(p))) {
        return { text: '', isImportant: false, shouldSend: false }
    }

    // 1. REKAP TOTAL PETERNAKAN (FINAL RUN ALL ACCOUNTS)
    const runEndMatch = content.match(/Completed all accounts \| Accounts processed: (\d+) \| Total points collected: \+(\d+) \| Old total: (\d+) → New total: (\d+) \| Total runtime: (.*)/)
    if (runEndMatch) {
        const [, accCount, totalCollected, oldTotal, newTotal, runtime] = runEndMatch
        text = `🏆 **REKAP TOTAL PETERNAKAN SEMALAM** 🏆\n===============================\n👥 **Akun Selesai:** ${accCount} Akun\n🔥 **Panen Hari Ini:** **+${totalCollected} Poin**\n💎 **GRAND TOTAL SALDO: ${newTotal} POIN** 💎\n*(Naik dari sebelumnya ${oldTotal} poin)*\n⏱️ **Total Runtime:** ${runtime}\n===============================`
        return { text, isImportant: true, shouldSend: true }
    }

    // 2. LAPORAN PER AKUN SELESAI
    const accountEndMatch = content.match(/Completed account: (.*?) \| Total: \+(\d+) \| Old: (\d+) → New: (\d+) \| Duration: (.*)/)
    if (accountEndMatch) {
        const [, email, gained, oldPts, newPts, duration] = accountEndMatch
        const durMin = (parseFloat(duration || '0') / 60).toFixed(1)
        text = `🎉 **LAPORAN AKUN SELESAI!**\n👤 **Akun:** \`${email}\`\n📈 **Cuan Didapat:** **+${gained} Poin**\n💰 **Saldo:** ${oldPts} → **${newPts} Poin**\n⏱️ **Durasi:** ${durMin} menit\n───────────────────────`
        return { text, isImportant: true, shouldSend: true }
    }

    // 3. MULAI AKUN BARU
    const accountStartMatch = content.match(/Starting account: (.*?) \| geoLocale: (.*)/)
    if (accountStartMatch) {
        const [, email, geo] = accountStartMatch
        const geoText = geo ? geo.toUpperCase() : 'AUTO'
        text = `🚀 **MEMULAI AKUN BARU:** \`${email}\`\n🌍 **Geo-Locale:** \`${geoText}\` | Siap berburu poin...`
        return { text, isImportant: false, shouldSend: true }
    }

    // 4. STEALTH DELAY (ANTI-BAN)
    const stealthMatch = content.match(/Menunggu (\d+) detik sebelum buka browser biar keliatan natural/)
    if (stealthMatch) {
        const [, sec] = stealthMatch
        text = `🛡️ **Mode Siluman (Anti-Ban):** Jeda ${sec} detik agar aktivitas tampak alami...`
        return { text, isImportant: false, shouldSend: true }
    }

    // 5. ROTASI IP (ADB MODE PESAWAT & MANUAL)
    const adbRotatedMatch = content.match(/IP rotated successfully: (.*?) -> (.*)/)
    if (adbRotatedMatch) {
        const [, oldIp, newIp] = adbRotatedMatch
        text = `🔄 **ROTASI IP BERHASIL (ADB Mode Pesawat)!**\n📡 **IP Baru:** \`${newIp}\` *(dari ${oldIp})* 🛡️`
        return { text, isImportant: false, shouldSend: true }
    }
    if (content.includes('Toggling airplane mode on device')) {
        text = `✈️ **ADB Automation:** Sedang mengaktifkan & mematikan mode pesawat untuk mengganti IP...`
        return { text, isImportant: false, shouldSend: true }
    }

    // 6. SAPU BERSIH KOIN NYANGKUT (PENDING POINTS)
    const koinNyangkutMatch = content.match(/Koin nyangkut sukses diamankan! \| \+(\d+) points \| newBalance=(\d+)/i)
    if (koinNyangkutMatch) {
        const [, points, newBal] = koinNyangkutMatch
        text = `🧹 **KOIN NYANGKUT DIAMANKAN!**\nTuyul berhasil menyapu koin tertunda sebesar **+${points} Poin**! 🤑\n💰 Saldo Sekarang: **${newBal} Poin**`
        return { text, isImportant: true, shouldSend: true }
    }

    // 7. PUNCH CARD (MULTI-DAY STREAK & KLAIM AKBAR 50-100 POIN)
    const punchClaimMatch = content.match(/Attempting final reward claim \(\+(\d+)\) for: (.*)/)
    if (punchClaimMatch) {
        const [, points, title] = punchClaimMatch
        text = `🎟️ **KLAIM PUNCH CARD AKBAR (+${points} Poin)!**\nSemua syarat misi *"${title}"* terpenuhi! Mengeksekusi klaim hadiah final... 🚀`
        return { text, isImportant: true, shouldSend: true }
    }
    const punchSolvingMatch = content.match(/Solving (\d+) items for: (.*)/)
    if (punchSolvingMatch) {
        const [, count, title] = punchSolvingMatch
        text = `🎟️ **Punch Card Aktif:** Mengerjakan ${count} tugas untuk misi *"${title}"*...`
        return { text, isImportant: false, shouldSend: true }
    }
    const punchCooldownMatch = content.match(/Punch Card \[(.*?)\] is on 24h cooldown/)
    if (punchCooldownMatch) {
        const [, title] = punchCooldownMatch
        text = `⏳ **Punch Card Cooldown:** Misi *"${title}"* dalam masa jeda 24 jam dari Microsoft (dilewati dengan aman).`
        return { text, isImportant: false, shouldSend: true }
    }

    // 7b. SIDE QUEST / KARTU PROMOSI SELESAI
    const sideQuestDoneMatch = content.match(/Completed \| offerId=(.*?) \| \+(\d+) points/)
    if (sideQuestDoneMatch) {
        const [, offerId, points] = sideQuestDoneMatch
        text = `✨ **Side Quest / Kartu Promosi Tuntas (+${points} Poin)!**\n🎯 ID Misi: \`${offerId}\``
        return { text, isImportant: false, shouldSend: true }
    }

    // 8. STAR BONUS 2100 POIN
    if (content.includes('Star Bonus points claimed!')) {
        text = `🌟 **JACKPOT STAR BONUS!**\nTuyul berhasil menyedot koin akbar! Buruan cek saldo lu bre! 🚀`
        return { text, isImportant: true, shouldSend: true }
    }

    // 9. READ TO EARN (BACA BERITA)
    const readCompleteMatch = content.match(/Completed Read to Earn \| articlesRead=(\d+) \| totalGained=(\d+) \| startBalance=(\d+) \| finalBalance=(\d+)/)
    if (readCompleteMatch) {
        const [, count, gained, start, end] = readCompleteMatch
        text = `📰 **Read-to-Earn Selesai (${count}/${count} Artikel)!**\nBerhasil panen **+${gained} Poin** dari baca berita. (Saldo: ${start} → ${end})`
        return { text, isImportant: false, shouldSend: true }
    }

    // 10. DAILY CHECK-IN
    const dailyCheckinMatch = content.match(/Completed Daily Check-In .* gainedPoints=(\d+) .* newBalance=(\d+)/i)
    if (dailyCheckinMatch) {
        const [, points, newBal] = dailyCheckinMatch
        text = `📅 **Absen Harian Berhasil!** Dapet jatah harian **+${points} Poin** (Saldo: ${newBal}).`
        return { text, isImportant: false, shouldSend: true }
    }

    // 11. KUIS & POLL OTOMATIS
    const quizMatch = content.match(/Detected Real Quiz \(\+(\d+)\)\. Solving/)
    if (quizMatch) {
        const [, pts] = quizMatch
        text = `🧠 **Kuis Cerdas Terdeteksi:** Menyelesaikan pertanyaan kuis otomatis (+${pts} Poin)...`
        return { text, isImportant: false, shouldSend: true }
    }
    const pollMatch = content.match(/Detected Poll \(\+(\d+)\)\. Clicking option/)
    if (pollMatch) {
        const [, pts] = pollMatch
        text = `📊 **Poll Harian Terdeteksi:** Mengklik opsi survei (+${pts} Poin)...`
        return { text, isImportant: false, shouldSend: true }
    }

    // 12. PENCARIAN BING SELESAI
    const searchDoneMatch = content.match(/Search done \| earned=(\d+)\/(\d+)/)
    if (searchDoneMatch) {
        const [, earned, target] = searchDoneMatch
        text = `🔍 **Pencarian Bing Selesai:** Berhasil meraup **+${earned}/${target} Poin** pencarian.`
        return { text, isImportant: false, shouldSend: true }
    }

    // 13. ERROR / BANNED / SUSPENDED ALERTS
    if (content.toLowerCase().includes('suspended') || content.toLowerCase().includes('banned') || content.toLowerCase().includes('locked')) {
        text = `🚨 **PERINGATAN KRITIS: AKUN TERKUNCI / TERKENA FLAG!**\nDetail: *${content}*\nSegera cek akun lu di browser!`
        return { text, isImportant: true, shouldSend: true }
    }
    const errorMatch = content.match(/\[ERROR\].*message=(.*)/)
    if (errorMatch && !content.includes('doClaimBonusPoints')) {
        const errMsg = errorMatch[1]
        text = `⚠️ **Error Terdeteksi:** *${errMsg}*`
        return { text, isImportant: true, shouldSend: true }
    }

    // Default formatting for any other standard INFO messages
    if (content.includes('[INFO]')) {
        const clean = content.replace(/^\[.*?\]\s*\[.*?\]\s*[A-Z]+\s*\[.*?\]\s*/, '')
        if (clean.length > 5 && !clean.includes('Browser launched') && !clean.includes('Created browser')) {
            text = `🔹 ${clean}`
            return { text, isImportant: false, shouldSend: true }
        }
    }

    return { text: '', isImportant: false, shouldSend: false }
}

export async function sendDiscord(discordUrl: string, content: string, level: LogLevel): Promise<void> {
    if (!discordUrl) return

    const { text, isImportant, shouldSend } = translateLog(content)
    if (!shouldSend || !text.trim()) return

    let finalContent = text
    if (isImportant && MY_DISCORD_ID && MY_DISCORD_ID.trim() !== '') {
        finalContent = `<@${MY_DISCORD_ID}>\n` + finalContent
    }

    const request: AxiosRequestConfig = {
        method: 'POST',
        url: discordUrl,
        headers: { 'Content-Type': 'application/json' },
        data: {
            content: truncate(finalContent),
            allowed_mentions: { parse: ['users'] }
        },
        timeout: 10000
    }

    await discordQueue.add(async () => {
        try {
            await axios(request)
        } catch (err: any) {
            const status = err?.response?.status
            if (status === 429) return
        }
    })
}

export async function flushDiscordQueue(timeoutMs = 5000): Promise<void> {
    await Promise.race([
        (async () => {
            await discordQueue.onIdle()
        })(),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('discord flush timeout')), timeoutMs))
    ]).catch(() => {})
}