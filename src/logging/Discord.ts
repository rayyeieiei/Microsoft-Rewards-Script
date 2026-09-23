import axios, { AxiosRequestConfig } from 'axios'
import PQueue from 'p-queue'
import type { LogLevel } from './Logger'

const DISCORD_LIMIT = 2000

// ================= AREA SETTING DISCORD OPERATOR =================
// ID DISCORD Operator untuk mention peringatan kritis dan rekap batch
export const MY_DISCORD_ID = '877734448685260820'
// =================================================================

export interface DiscordConfig {
    enabled?: boolean
    url: string
}

export interface DiscordEmbedField {
    name: string
    value: string
    inline?: boolean
}

export interface DiscordEmbedFooter {
    text: string
    icon_url?: string
}

export interface DiscordEmbed {
    title?: string
    description?: string
    url?: string
    timestamp?: string
    color?: number
    fields?: DiscordEmbedField[]
    footer?: DiscordEmbedFooter
}

export interface DiscordWebhookPayload {
    content?: string
    username?: string
    avatar_url?: string
    embeds?: DiscordEmbed[]
    allowed_mentions?: {
        parse?: string[]
        users?: string[]
        roles?: string[]
    }
}

const discordQueue = new PQueue({
    interval: 1000,
    intervalCap: 2,
    carryoverConcurrencyCount: true
})

export function truncate(text: string, maxLen = DISCORD_LIMIT): string {
    return text.length <= maxLen ? text : text.slice(0, maxLen - 14) + ' …(truncated)'
}

/**
 * Membangun Discord Rich Embed Payload berdasarkan analisis event log runner.
 * Mengeliminasi 100% spam log mentah dan hanya menghasilkan embed ringkas, elegan,
 * serta informatif untuk event-event bernilai tinggi.
 */
export function buildDiscordPayload(content: string, level: LogLevel): DiscordWebhookPayload | null {
    if (!content || typeof content !== 'string') return null

    // 1. REKAP TOTAL PETERNAKAN (FINAL RUN ALL ACCOUNTS)
    // Cocok dengan v3.1.4: "Completed all accounts | Accounts: 6 | Points: +920 | Bandwidth: 28.4 MB ... | Old: ... → New: ... | Runtime: 24.5min"
    // Serta varian cluster dan legacy
    if (content.includes('Completed all accounts')) {
        const accMatch = content.match(/Accounts:\s*(\d+)/i) || content.match(/Accounts processed:\s*(\d+)/i)
        const ptsMatch = content.match(/Points:\s*\+(\d+)/i) || content.match(/Total points collected:\s*\+(\d+)/i) || content.match(/\+(\d+)\s*points/i)
        const oldMatch = content.match(/Old:\s*(\d+)/i) || content.match(/Old total:\s*(\d+)/i)
        const newMatch = content.match(/New:\s*(\d+)/i) || content.match(/New total:\s*(\d+)/i)
        const runMatch = content.match(/Runtime:\s*([\d.]+\s*min)/i) || content.match(/Total runtime:\s*([\d.]+\s*min)/i) || content.match(/Runtime:\s*(.*?)(?:\||$)/i)
        const bwMatch = content.match(/Bandwidth:\s*([^\n|]+)/i)

        const accCount = accMatch?.[1] ?? 'Semua'
        const totalPts = ptsMatch?.[1] ?? '0'
        const oldTotal = oldMatch?.[1] ? Number(oldMatch[1]).toLocaleString('en-US') : '-'
        const newTotal = newMatch?.[1] ? Number(newMatch[1]).toLocaleString('en-US') : '-'
        const runtime = runMatch?.[1] ? runMatch[1].trim() : 'Selesai'

        const fields: DiscordEmbedField[] = [
            { name: '👥 Akun Diproses', value: `**${accCount} Akun**`, inline: true },
            { name: '🔥 Total Poin Panen', value: `**+${totalPts} Poin**`, inline: true },
            { name: '💎 Grand Total Saldo', value: `${oldTotal} → **${newTotal} Poin**`, inline: true },
            { name: '⏱️ Total Runtime', value: `**${runtime}**`, inline: true }
        ]

        if (bwMatch?.[1]) {
            fields.push({ name: '📊 Konsumsi Kuota', value: `\`${bwMatch[1].trim()}\``, inline: true })
        }

        return {
            content: MY_DISCORD_ID ? `<@${MY_DISCORD_ID}>` : undefined,
            username: 'Microsoft Rewards Bot',
            allowed_mentions: { users: MY_DISCORD_ID ? [MY_DISCORD_ID] : [] },
            embeds: [
                {
                    title: '🏆 REKAP AKHIR PETERNAKAN (SEMUA AKUN SELESAI)',
                    color: 0x9B59B6, // Purple
                    description: 'Seluruh antrean akun telah berhasil diproses oleh sistem.',
                    fields,
                    footer: { text: 'Microsoft Rewards Farm Automation • Completed' },
                    timestamp: new Date().toISOString()
                }
            ]
        }
    }

    // 2. LAPORAN PER AKUN SELESAI
    // Cocok dengan v3.1.4: "[ACCOUNT-FINISH] Completed workflow for: use***@domain.com | Total: +150 | Old: 12450 → New: 12600 | Duration: 185.4s"
    // Serta format legacy: "Completed account: ... | Total: +... | Old: ... → New: ... | Duration: ..."
    const accountEndMatch =
        content.match(/\[ACCOUNT-FINISH\]\s*Completed workflow for:\s*(.*?)\s*\|\s*Total:\s*\+(\d+)\s*\|\s*Old:\s*(\d+)\s*→\s*New:\s*(\d+)\s*\|\s*Duration:\s*([\d.]+)s?/i) ||
        content.match(/Completed account:\s*(.*?)\s*\|\s*Total:\s*\+(\d+)\s*\|\s*Old:\s*(\d+)\s*→\s*New:\s*(\d+)\s*\|\s*Duration:\s*([\d.]+)s?/i)

    if (accountEndMatch && accountEndMatch[1] && accountEndMatch[2]) {
        const email = accountEndMatch[1]
        const gained = accountEndMatch[2]
        const oldPts = accountEndMatch[3] ?? '0'
        const newPts = accountEndMatch[4] ?? '0'
        const durationRaw = accountEndMatch[5] ?? '0'
        const durSec = parseFloat(durationRaw)
        const durFormatted = durSec >= 60 ? `${(durSec / 60).toFixed(1)} menit (${durSec.toFixed(0)}s)` : `${durSec.toFixed(0)} detik`

        return {
            username: 'Microsoft Rewards Bot',
            embeds: [
                {
                    title: '✅ Laporan Akun Selesai',
                    color: 0x2ECC71, // Green
                    description: `Siklus aktivitas harian untuk akun **\`${email}\`** telah selesai.`,
                    fields: [
                        { name: '👤 Akun', value: `\`${email}\``, inline: true },
                        { name: '📈 Poin Hari Ini', value: `**+${gained} Poin**`, inline: true },
                        { name: '💰 Saldo Total', value: `${Number(oldPts).toLocaleString('en-US')} → **${Number(newPts).toLocaleString('en-US')} Poin**`, inline: true },
                        { name: '⏱️ Durasi', value: `\`${durFormatted}\``, inline: true }
                    ],
                    footer: { text: 'Microsoft Rewards Automation • v3.1.4' },
                    timestamp: new Date().toISOString()
                }
            ]
        }
    }

    // 3. PERINGATAN KRITIS: 15-MINUTE SEARCH COOLDOWN
    if (content.includes('[COOLDOWN-DETECTED]')) {
        return {
            content: MY_DISCORD_ID ? `<@${MY_DISCORD_ID}>` : undefined,
            username: 'Microsoft Rewards Bot',
            allowed_mentions: { users: MY_DISCORD_ID ? [MY_DISCORD_ID] : [] },
            embeds: [
                {
                    title: '🚨 PERINGATAN: Microsoft 15-Minute Search Cooldown',
                    color: 0xE74C3C, // Red
                    description: 'Microsoft mendeteksi pencarian kueri terlalu cepat dan membekukan perolehan poin selama 15 menit.',
                    fields: [
                        {
                            name: '🛡️ Tindakan Bot',
                            value: 'Pencarian dihentikan secara graceful untuk melindungi reputasi akun. Sesi akun ditutup secara bersih dan bot berpindah ke akun berikutnya.',
                            inline: false
                        },
                        {
                            name: '📌 Detail Log',
                            value: `\`\`\`${truncate(content, 400)}\`\`\``,
                            inline: false
                        }
                    ],
                    footer: { text: 'Anti-Abuse Protection Guard' },
                    timestamp: new Date().toISOString()
                }
            ]
        }
    }

    // 4. PERINGATAN KRITIS: AKUN TERKUNCI / BANNED / SUSPENDED
    if (
        content.includes('ACCOUNT_LOCKED') ||
        content.toLowerCase().includes('suspended') ||
        content.toLowerCase().includes('banned') ||
        content.toLowerCase().includes('account is locked')
    ) {
        return {
            content: MY_DISCORD_ID ? `<@${MY_DISCORD_ID}>` : undefined,
            username: 'Microsoft Rewards Bot',
            allowed_mentions: { users: MY_DISCORD_ID ? [MY_DISCORD_ID] : [] },
            embeds: [
                {
                    title: '🚨 PERINGATAN KRITIS: Akun Terkunci / Ditangguhkan!',
                    color: 0xE74C3C, // Red
                    description: 'Sistem Microsoft menandai akun memerlukan verifikasi manual atau sedang ditangguhkan.',
                    fields: [
                        { name: '📌 Detail Pesan', value: `\`\`\`${truncate(content, 400)}\`\`\``, inline: false },
                        { name: '👉 Tindakan Operator', value: 'Buka browser manual untuk menyelesaikan challenge / status akun.', inline: false }
                    ],
                    footer: { text: 'Security Sentinel' },
                    timestamp: new Date().toISOString()
                }
            ]
        }
    }

    // 5. PERINGATAN VERIFIKASI: PASSKEY / 2FA / RECOVERY EMAIL
    if (
        content.includes('PASSKEY_ERROR') ||
        content.includes('RECOVERY_EMAIL_INPUT') ||
        content.includes('OTP_CODE_ENTRY') ||
        content.includes('2FA_TOTP')
    ) {
        return {
            content: MY_DISCORD_ID ? `<@${MY_DISCORD_ID}>` : undefined,
            username: 'Microsoft Rewards Bot',
            allowed_mentions: { users: MY_DISCORD_ID ? [MY_DISCORD_ID] : [] },
            embeds: [
                {
                    title: '⚠️ PERINGATAN: Verifikasi Keamanan Diperlukan',
                    color: 0xE67E22, // Orange
                    description: 'Login Microsoft meminta verifikasi tambahan (Passkey / 2FA TOTP / Recovery Code).',
                    fields: [
                        { name: '📌 Status Login', value: `\`\`\`${truncate(content, 400)}\`\`\``, inline: false }
                    ],
                    footer: { text: 'Login Verification Challenge' },
                    timestamp: new Date().toISOString()
                }
            ]
        }
    }

    // 6. PERINGATAN ROTASI IP: ADB ATAU MANUAL GLITCH
    if (content.includes('IP masih kembar') || content.includes('Device ADB Tidak Terdeteksi')) {
        return {
            content: MY_DISCORD_ID ? `<@${MY_DISCORD_ID}>` : undefined,
            username: 'Microsoft Rewards Bot',
            allowed_mentions: { users: MY_DISCORD_ID ? [MY_DISCORD_ID] : [] },
            embeds: [
                {
                    title: '⚠️ PERINGATAN: Rotasi IP Terhambat',
                    color: 0xE67E22, // Orange
                    description: 'Pergantian IP publik via ADB Mode Pesawat atau Hotspot gagal mendapatkan IP baru.',
                    fields: [
                        { name: '📌 Detail Log', value: `\`\`\`${truncate(content, 400)}\`\`\``, inline: false }
                    ],
                    footer: { text: 'Network Interceptor' },
                    timestamp: new Date().toISOString()
                }
            ]
        }
    }

    // 7. JACKPOT / HIGH-VALUE EVENTS
    // 7a. Star Bonus (2100 Poin)
    if (content.includes('Star Bonus points claimed!')) {
        return {
            content: MY_DISCORD_ID ? `<@${MY_DISCORD_ID}>` : undefined,
            username: 'Microsoft Rewards Bot',
            allowed_mentions: { users: MY_DISCORD_ID ? [MY_DISCORD_ID] : [] },
            embeds: [
                {
                    title: '🌟 JACKPOT: Star Bonus 2100 Poin Berhasil Diklaim!',
                    color: 0xF1C40F, // Gold
                    description: 'Bonus bintang rewards berhasil disedot masuk ke saldo akun!',
                    footer: { text: 'Jackpot Collector' },
                    timestamp: new Date().toISOString()
                }
            ]
        }
    }

    // 7b. Klaim Koin Nyangkut
    const koinMatch = content.match(/Koin nyangkut sukses diamankan! \| \+(\d+) points \| newBalance=(\d+)/i)
    if (koinMatch && koinMatch[1] && koinMatch[2]) {
        return {
            username: 'Microsoft Rewards Bot',
            embeds: [
                {
                    title: '🧹 Koin Nyangkut Berhasil Diamankan!',
                    color: 0x1ABC9C, // Teal
                    fields: [
                        { name: '📈 Poin Diamankan', value: `**+${koinMatch[1]} Poin**`, inline: true },
                        { name: '💰 Saldo Sekarang', value: `**${Number(koinMatch[2]).toLocaleString('en-US')} Poin**`, inline: true }
                    ],
                    footer: { text: 'Pending Points Recovery' },
                    timestamp: new Date().toISOString()
                }
            ]
        }
    }

    // 7c. Klaim Punch Card Akbar
    const punchMatch = content.match(/Attempting final reward claim \(\+(\d+)\) for: (.*)/i)
    if (punchMatch && punchMatch[1] && punchMatch[2]) {
        return {
            username: 'Microsoft Rewards Bot',
            embeds: [
                {
                    title: `🎟️ Klaim Punch Card Akbar (+${punchMatch[1]} Poin)!`,
                    color: 0x3498DB, // Blue
                    description: `Semua syarat misi *"${punchMatch[2]}"* terpenuhi! Klaim hadiah final dieksekusi.`,
                    footer: { text: 'Punch Card Master' },
                    timestamp: new Date().toISOString()
                }
            ]
        }
    }

    // 8. ERROR KRITIS LAINNYA
    if (level === 'error' && !content.includes('doClaimBonusPoints')) {
        const errorMsg = content.replace(/^\[.*?\]\s*/, '')
        return {
            username: 'Microsoft Rewards Bot',
            embeds: [
                {
                    title: '⚠️ Error Eksekusi Terdeteksi',
                    color: 0xE74C3C, // Red
                    description: `\`\`\`${truncate(errorMsg, 500)}\`\`\``,
                    footer: { text: 'Error Logger' },
                    timestamp: new Date().toISOString()
                }
            ]
        }
    }

    // Seluruh log rutin lainnya (pencarian, safe-scroll, cookie save, hover, trace biasa) diabaikan 100%
    return null
}

/**
 * Kompatibilitas fungsi legacy translateLog bagi modul yang membutuhkannya.
 */
export function translateLog(content: string): { text: string; isImportant: boolean; shouldSend: boolean } {
    const payload = buildDiscordPayload(content, 'info')
    if (!payload || !payload.embeds || payload.embeds.length === 0) {
        return { text: '', isImportant: false, shouldSend: false }
    }
    const embed = payload.embeds[0]!
    const text = `${embed.title || ''}\n${embed.description || ''}`
    const isImportant = !!payload.content?.includes('<@')
    return { text, isImportant, shouldSend: true }
}

/**
 * Mengirimkan notifikasi embed ke Discord Webhook dengan manajemen antrean (P-Queue)
 * dan logging error defensif serta backoff HTTP 429.
 */
export async function sendDiscord(discordUrl: string, content: string, level: LogLevel): Promise<void> {
    if (!discordUrl) return

    const payload = buildDiscordPayload(content, level)
    if (!payload) return

    const request: AxiosRequestConfig = {
        method: 'POST',
        url: discordUrl,
        headers: { 'Content-Type': 'application/json' },
        data: payload,
        timeout: 10000
    }

    await discordQueue.add(async () => {
        try {
            await axios(request)
        } catch (err: any) {
            const status = err?.response?.status
            if (status === 429) {
                const retryAfter = Number(err?.response?.headers?.['retry-after']) || 5
                console.warn(`[DISCORD] Rate limited (HTTP 429). Menunggu ${retryAfter} detik...`)
                await new Promise(r => setTimeout(r, retryAfter * 1000))
                try {
                    await axios(request)
                } catch (retryErr: any) {
                    const retryStatus = retryErr?.response?.status
                    console.error(`[DISCORD-WEBHOOK-ERROR] Pengiriman ulang gagal (${retryStatus || 'Network'}): ${retryErr?.message}`)
                }
                return
            }

            const errMsg = err?.response?.data?.message || err?.message || String(err)
            console.error(`[DISCORD-WEBHOOK-ERROR] Gagal mengirim embed ke Discord (${status || 'Network'}): ${errMsg}`)
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