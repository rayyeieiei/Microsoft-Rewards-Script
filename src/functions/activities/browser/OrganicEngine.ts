import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'

export class OrganicEngine {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    /**
     * Simulasi klik organik ke link hasil pencarian Bing dengan Isolated Child Tab
     * @param page Active Bing search page
     * @param isMobile Device flag
     * @returns boolean apakah klik organik berhasil dilakukan
     */
    public async simulateOrganicCTR(page: Page, isMobile: boolean): Promise<boolean> {
        if (!page || page.isClosed()) return false

        const organicConfig = this.bot.config.searchSettings.organicSearch
        const ctrRate = Number(organicConfig?.ctrRate ?? 0.35)

        // Roll probability CTR (misal 35% kemungkinan klik)
        if (Math.random() > ctrRate) {
            return false
        }

        try {
            // 1. Ekstrak daftar URL hasil pencarian organik murni (hindari iklan .b_ad & internal bing)
            const candidateUrls = await page.evaluate(() => {
                const results: string[] = []
                const algoLinks = Array.from(document.querySelectorAll('#b_results .b_algo h2 a, #b_results .b_algo a, #b_results .b_topTitle a'))

                for (const rawEl of algoLinks) {
                    const el = rawEl as HTMLAnchorElement
                    const href = el.href || el.getAttribute('href') || ''
                    if (!href || !href.startsWith('http')) continue

                    // Filter out internal Bing, Microsoft auth, ads, and telemetry
                    const lower = href.toLowerCase()
                    const isInternal = lower.includes('bing.com') ||
                                       lower.includes('microsoft.com') ||
                                       lower.includes('live.com') ||
                                       lower.includes('msn.com') ||
                                       lower.includes('javascript:') ||
                                       lower.includes('go.microsoft.com')

                    // Filter out ad banners
                    const isAd = el.closest('.b_ad, [data-serp-clickable], .b_adTop, .b_adBottom') !== null

                    if (!isInternal && !isAd && !results.includes(href)) {
                        results.push(href)
                    }
                }
                return results.slice(0, 6) // Ambil 6 hasil teratas
            }).catch(() => [])

            if (!candidateUrls || candidateUrls.length === 0) {
                return false
            }

            // Pilih salah satu link organik (prioritas posisi 1-3)
            const targetUrl = candidateUrls[Math.floor(Math.random() * Math.min(candidateUrls.length, 3))]
            if (!targetUrl) return false

            const domain = new URL(targetUrl).hostname.replace(/^www\./, '')
            this.bot.logger.info(
                isMobile,
                'ORGANIC-CTR',
                `[Star Bonus] Organic click-through simulated | domain="${domain}" | targetRank=top3`,
                'cyan'
            )

            // 2. Buka di Isolated Child Tab agar tidak merusak posisi tab utama Bing
            const context = page.context()
            const childTab = await context.newPage()

            try {
                // Blokir resource media berat di child tab untuk menghemat RAM & CPU
                await childTab.route('**/*', route => {
                    const resourceType = route.request().resourceType()
                    if (['image', 'media', 'font', 'websocket'].includes(resourceType)) {
                        route.abort().catch(() => {})
                    } else {
                        route.continue().catch(() => {})
                    }
                })

                // Navigasi dengan timeout ketat (6 detik)
                await childTab.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 6000 }).catch(() => {})

                // Simulasi pergerakan scroll membaca (Human Reading Mimicry)
                const scrollDepth = Number(organicConfig?.maxScrollDepth ?? 0.65)
                await childTab.evaluate((depth) => {
                    const targetScroll = (document.body.scrollHeight || 1000) * depth
                    window.scrollTo({ top: Math.min(targetScroll, 1200), behavior: 'smooth' })
                }, scrollDepth).catch(() => {})

                // Dwell Time (Waktu membaca 3.5s - 7.5s)
                const dwellMin = Number(organicConfig?.dwellTimeMin ?? 3500)
                const dwellMax = Number(organicConfig?.dwellTimeMax ?? 7500)
                await this.bot.utils.wait(this.bot.utils.randomDelay(dwellMin, dwellMax))

                return true
            } finally {
                // Selalu tutup child tab dengan aman
                await childTab.close().catch(() => {})
            }

        } catch (error) {
            this.bot.logger.debug(
                isMobile,
                'ORGANIC-CTR',
                `Organic CTR skipped safely: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }
}
