import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../../index'

export class TopicalChainer {
    private bot: MicrosoftRewardsBot
    private currentChainDepth: number = 0
    private readonly maxChainDepth: number

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
        this.maxChainDepth = Number(bot.config.searchSettings.organicSearch?.maxChainDepth ?? 3)
    }

    /**
     * Ekstrak kueri penelusuran terkait (Related Searches) dari SERP Bing
     * @param page Active Bing search page
     * @returns Array kueri turunan yang bersih
     */
    public async extractRelatedSearches(page: Page): Promise<string[]> {
        if (!page || page.isClosed()) return []

        const organicConfig = this.bot.config.searchSettings.organicSearch
        if (!organicConfig?.enableTopicalChaining) {
            return []
        }

        // Jika kedalaman rantai sudah mencapai batas, reset agar query beralih (pivot) ke topik baru
        if (this.currentChainDepth >= this.maxChainDepth) {
            this.currentChainDepth = 0
            return []
        }

        try {
            const rawQueries = await page.evaluate(() => {
                const results: string[] = []
                // Selector untuk Related Searches Bing (Desktop & Mobile SERP)
                const rsElements = Array.from(document.querySelectorAll('.b_rs a, #brsv3 a, .b_rsv3 a, .df_div a, [data-query], .b_ans a'))

                for (const rawEl of rsElements) {
                    const el = rawEl as HTMLElement
                    const text = (el.innerText || el.textContent || el.getAttribute('data-query') || '').trim()
                    
                    // Filter teks kueri yang valid
                    if (text && text.length > 2 && text.length < 80) {
                        const clean = text.replace(/[\r\n\t]+/g, ' ').trim()
                        if (!results.includes(clean) && !clean.toLowerCase().includes('feedback') && !clean.toLowerCase().includes('bing')) {
                            results.push(clean)
                        }
                    }
                }
                return results.slice(0, 5) // Ambil hingga 5 saran teratas
            }).catch(() => [])

            if (rawQueries.length > 0) {
                this.currentChainDepth++
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'TOPICAL-CHAIN',
                    `Extracted ${rawQueries.length} related topics | chainDepth=${this.currentChainDepth}/${this.maxChainDepth}`
                )
            }

            return rawQueries
        } catch {
            return []
        }
    }

    /**
     * Reset kedalaman rantai saat akun berganti
     */
    public resetChain() {
        this.currentChainDepth = 0
    }
}
