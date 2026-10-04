import type { Page } from 'patchright'
import { randomBytes } from 'crypto'
import type { Counters, DashboardData } from '../../../interface/DashboardData'

import { QueryCore } from '../../QueryEngine'
import { Workers } from '../../Workers'
import { Database } from '../../../util/Database'
import { OrganicEngine } from './OrganicEngine'
import { TopicalChainer } from './TopicalChainer'

import type { QueryEngine } from '../../../interface/Config'

export class Search extends Workers {
    private bingHome = 'https://bing.com'
    private organicEngine: OrganicEngine = new OrganicEngine(this.bot)
    private topicalChainer: TopicalChainer = new TopicalChainer(this.bot)

    public async doSearch(data: DashboardData, page: Page, isMobile: boolean): Promise<number> {
        if (!page || page.isClosed()) {
            this.bot.logger.warn(
                isMobile,
                'SEARCH-BING',
                'Target page tidak tersedia atau telah ditutup. Menghentikan proses pencarian.'
            )
            return 0
        }

        if (
            this.bot.abortController?.signal?.aborted ||
            this.bot.accountScope?.abortController?.signal?.aborted
        ) {
            this.bot.logger.warn(
                isMobile,
                'SEARCH-BING',
                '🚨 Sinyal abort/timeout terdeteksi sebelum proses pencarian dimulai. Menghentikan eksekusi seketika.'
            )
            return 0
        }

        const startBalance = Number(this.bot.userData.currentPoints ?? 0)
        let searchCount = 0

        this.bot.logger.info(isMobile, 'SEARCH-BING', `Starting Bing searches (${isMobile ? 'Mobile' : 'Desktop'}) | currentPoints=${startBalance}`)

        let totalGainedPoints = 0

        try {
            let searchCounters: Counters = await this.bot.browser.func.getSearchPoints()
            const missingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
            let missingPointsTotal = missingPoints.totalPoints

            this.bot.logger.debug(
                isMobile,
                'SEARCH-BING',
                `Initial search counters | mobile=${missingPoints.mobilePoints} | desktop=${missingPoints.desktopPoints} | edge=${missingPoints.edgePoints}`
            )

            this.bot.logger.info(
                isMobile,
                'SEARCH-BING',
                `Search points remaining (${isMobile ? 'Mobile' : 'Desktop'}) | Edge=${missingPoints.edgePoints} | Desktop=${missingPoints.desktopPoints} | Mobile=${missingPoints.mobilePoints}`
            )

            if (missingPointsTotal <= 0) {
                this.bot.logger.info(
                    isMobile,
                    'SEARCH-BING',
                    `Tidak ada sisa kuota pencarian (${isMobile ? 'Mobile' : 'Desktop'}) yang perlu dikerjakan. Melewati pencarian.`
                )
                return 0
            }

            if (
                this.bot.abortController?.signal?.aborted ||
                this.bot.accountScope?.abortController?.signal?.aborted
            ) {
                this.bot.logger.warn(
                    isMobile,
                    'SEARCH-BING',
                    '🚨 Sinyal abort/timeout terdeteksi saat evaluasi kuota awal. Menghentikan eksekusi.'
                )
                return 0
            }

            const queryCore = new QueryCore(this.bot)
            const locale = (this.bot.userData.geoLocale ?? 'US').toUpperCase()
            const langCode = (this.bot.userData.langCode ?? 'en').toLowerCase()

            // Partisi sumber pencarian agar Mobile & Desktop tidak pernah bertabrakan kata kunci
            const sources: QueryEngine[] = isMobile
                ? ['google', 'reddit', 'local', 'wikipedia']
                : ['wikipedia', 'local', 'google', 'reddit']

            this.bot.logger.debug(
                isMobile,
                'SEARCH-BING',
                `Resolving search queries via QueryCore | locale=${locale} | lang=${langCode} | sources=${sources.join(',')}`
            )

            let queries = await queryCore.queryManager({
                shuffle: true,
                related: false,
                langCode,
                geoLocale: locale,
                sourceOrder: sources
            })

            queries = [...new Set(queries.map(q => q.trim()).filter(Boolean))]

            this.bot.logger.info(isMobile, 'SEARCH-BING', `Search query pool ready | count=${queries.length}`)

            const organicConfig = this.bot.config.searchSettings.organicSearch
            const isOrganicEnabled = Boolean(organicConfig?.enabled)

            if (isOrganicEnabled) {
                const ctrPercent = (Number(organicConfig?.ctrRate ?? 0.35) * 100).toFixed(0)
                this.bot.logger.info(
                    isMobile,
                    'ORGANIC-SEARCH',
                    `[Star Bonus] Organic Search Engine active | ctrRate=${ctrPercent}% | topicalChaining=${Boolean(organicConfig?.enableTopicalChaining)}`,
                    'green'
                )
            }

            const isDualWorkerMode = this.bot.config?.executionMode === 'staggered-dual' || (this.bot.config?.executionMode as string) === 'dual'
            const isBatchCooldownActive = isDualWorkerMode && Boolean(this.bot.sharedBatchSignal?.isCooldownTriggered)

            if (this.bot.searchCooldownActive || isBatchCooldownActive) {
                this.bot.logger.warn(
                    isMobile,
                    'SEARCH-BING',
                    `[COOLDOWN-DETECTED] Search cooldown is active (or batch circuit breaker triggered), skipping ${isMobile ? 'Mobile' : 'Desktop'} searches.`
                )
                return totalGainedPoints
            }

            this.topicalChainer.resetChain()

            // Go to bing
            this.bot.logger.debug(isMobile, 'SEARCH-BING', `Navigating to search page | url=${this.bingHome}`)

            await page.goto(this.bingHome, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
            await this.bot.browser.utils.tryDismissAllMessages(page)

            let stagnantLoop = 0
            const stagnantLoopMax = 3
            let isCooldownDetected = false

            const isAborted = () => Boolean(
                this.bot.abortController?.signal?.aborted ||
                this.bot.accountScope?.abortController?.signal?.aborted ||
                page.isClosed()
            )

            for (let i = 0; i < queries.length; i++) {
                if (isAborted()) {
                    this.bot.logger.warn(
                        isMobile,
                        'ABORT',
                        '🚨 Pencarian dibatalkan seketika oleh sinyal abort/deadline timeout.'
                    )
                    break
                }

                if (isDualWorkerMode && this.bot.sharedBatchSignal?.isCooldownTriggered) {
                    this.bot.logger.warn(
                        isMobile,
                        'CIRCUIT-BREAKER',
                        '🚨 [DUAL-WORKER CIRCUIT BREAKER] Menghentikan pencarian: Rekan worker dalam batch ini terkena cooldown 15 menit. Melindungi IP seluler bersama.'
                    )
                    break
                }

                const query = queries[i] as string
                const trimmedQuery = query?.trim() ?? ''
                if (trimmedQuery.length < 5 || !trimmedQuery.includes(' ')) {
                    this.bot.logger.debug(
                        isMobile,
                        'SEARCH-BING',
                        `Skipping short or single-word query: "${trimmedQuery}"`
                    )
                    continue
                }

                searchCount++

                searchCounters = await this.bingSearch(page, query, isMobile, searchCount)
                if (isAborted()) {
                    this.bot.logger.warn(
                        isMobile,
                        'ABORT',
                        '🚨 Pencarian dibatalkan pasca kueri oleh sinyal abort/deadline timeout.'
                    )
                    break
                }

                const newMissingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
                let newMissingPointsTotal = newMissingPoints.totalPoints

                // Sanity Clamp & Eliminasi Poin Negatif:
                // Sisa poin TIDAK BOLEH melonjak kembali ke 90 di tengah loop pencarian
                if (newMissingPointsTotal > missingPointsTotal) {
                    this.bot.logger.warn(
                        isMobile,
                        'SEARCH-BING',
                        `[COUNTER-ANOMALY] Counter melonjak dari ${missingPointsTotal} ke ${newMissingPointsTotal}. Mengabaikan anomali counter Bing dan menggunakan baseline kueri (+3 poin).`
                    )
                    newMissingPointsTotal = Math.max(0, missingPointsTotal - 3)
                }

                const pcProg = searchCounters.pcSearch?.[0] ? `${searchCounters.pcSearch[0].pointProgress}/${searchCounters.pcSearch[0].pointProgressMax}` : '0/0'
                const edgeProg = searchCounters.pcSearch?.[1] && searchCounters.pcSearch[1].pointProgressMax > 0 ? ` (+${searchCounters.pcSearch[1].pointProgress}/${searchCounters.pcSearch[1].pointProgressMax} Edge)` : ''
                const desktopProgress = `${pcProg}${edgeProg}`
                const mobileProgress = searchCounters.mobileSearch?.[0] ? `${searchCounters.mobileSearch[0].pointProgress}/${searchCounters.mobileSearch[0].pointProgressMax}` : '0/0'

                const curPoints = Number(this.bot.userData.currentPoints ?? 0)
                const colPoints = Math.max(0, curPoints - Number(this.bot.userData.initialPoints ?? 0))

                const currentEmail = this.bot.activeAccount?.email || this.bot.userData.userName
                this.bot.updateDashboardAccount(currentEmail, {
                    collectedPoints: colPoints,
                    desktopProgress,
                    mobileProgress,
                    status: `Searching (${isMobile ? 'Mobile' : 'Desktop'})`
                })

                const rawDelta = missingPointsTotal - newMissingPointsTotal
                const gainedPoints = Math.max(0, rawDelta)

                if (gainedPoints === 0) {
                    stagnantLoop++
                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING',
                        `No points gained ${stagnantLoop}/${stagnantLoopMax} | query="${query}" | remaining=${newMissingPointsTotal}`
                    )

                    if (stagnantLoop >= stagnantLoopMax) {
                        this.bot.logger.info(
                            isMobile,
                            'SEARCH-BING',
                            `Stagnant threshold reached (${stagnantLoop}/${stagnantLoopMax}), performing server hard-verification...`
                        )
                        const verifyRes = await this.verifyPointsWithServer(page, isMobile)
                        if (verifyRes.verifiedGained && verifyRes.newBalance) {
                            const actualGained = verifyRes.gained ?? 0
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING',
                                `Hard-verification SUCCESS: Server points increased by +${actualGained} (new balance: ${verifyRes.newBalance}). Resetting stagnant loop.`,
                                'green'
                            )
                            this.bot.userData.currentPoints = verifyRes.newBalance
                            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + actualGained
                            totalGainedPoints += actualGained
                            stagnantLoop = 0
                        } else {
                            this.bot.logger.warn(
                                isMobile,
                                'SEARCH-BING',
                                `[COOLDOWN-DETECTED] Microsoft 15-Minute Search Cooldown aktif pada akun ini (Server verified points stagnant after ${stagnantLoopMax} queries). Aborting search loop for graceful hand-off.`
                            )
                            this.bot.searchCooldownActive = true
                            isCooldownDetected = true
                            if (isDualWorkerMode && this.bot.sharedBatchSignal) {
                                this.bot.sharedBatchSignal.isCooldownTriggered = true
                                this.bot.logger.warn(
                                    isMobile,
                                    'CIRCUIT-BREAKER',
                                    '🚨 [DUAL-WORKER CIRCUIT BREAKER] Cooldown 15 menit terdeteksi pada worker ini! Menyalakan sinyal abort untuk melindungi reputasi IP seluler bersama.'
                                )
                            }
                            break
                        }
                    }
                } else {
                    stagnantLoop = 0
                    void Database.getInstance().recordActivity(
                        currentEmail,
                        isMobile ? 'SEARCH_MOBILE' : 'SEARCH_DESKTOP',
                        gainedPoints
                    )

                    this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                    totalGainedPoints += gainedPoints

                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING',
                        `gainedPoints=${gainedPoints} points | query="${query}" | remaining=${newMissingPointsTotal}`,
                        'green'
                    )
                }

                missingPointsTotal = newMissingPointsTotal

                if (missingPointsTotal === 0) {
                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING',
                        `All required ${isMobile ? 'Mobile' : 'Desktop'} search points earned, stopping search loop`
                    )
                    break
                }

                // Topical Chaining: Ekstrak related search keywords dari SERP Bing dan masukkan ke antrean kueri
                if (isOrganicEnabled && organicConfig?.enableTopicalChaining && queries.length < 150) {
                    const relatedTopics = await this.topicalChainer.extractRelatedSearches(page)
                    if (relatedTopics.length > 0) {
                        queries.splice(i + 1, 0, ...relatedTopics)
                    }
                }

                const remainingQueries = queries.length - (i + 1)
                const minBuffer = 20
                if (missingPointsTotal > 0 && remainingQueries < minBuffer && !isAborted()) {
                    this.bot.logger.warn(
                        isMobile,
                        'SEARCH-BING',
                        `Low query buffer while still missing points, regenerating | remainingQueries=${remainingQueries} | missing=${missingPointsTotal}`
                    )

                    const extra = await queryCore.queryManager({
                        shuffle: true,
                        related: false,
                        langCode,
                        geoLocale: locale,
                        sourceOrder: this.bot.config.searchSettings.queryEngines
                    })

                    if (!isAborted()) {
                        const merged = [...queries, ...extra].map(q => q.trim()).filter(Boolean)
                        queries = [...new Set(merged)]
                        queries = this.bot.utils.shuffleArray(queries)

                        this.bot.logger.debug(isMobile, 'SEARCH-BING', `Query pool regenerated | count=${queries.length}`)
                    }
                }
            }

            if (missingPointsTotal > 0 && !isCooldownDetected && !isAborted()) {
                this.bot.logger.info(
                    isMobile,
                    'SEARCH-BING',
                    `Search completed but still missing points, continuing with regenerated queries | remaining=${missingPointsTotal}`
                )

                let stagnantLoop = 0
                const stagnantLoopMax = 3
                let poolRefills = 0
                const maxPoolRefill = 1

                while (missingPointsTotal > 0 && !isCooldownDetected && !isAborted() && poolRefills < maxPoolRefill) {
                    poolRefills++

                    const extra = await queryCore.queryManager({
                        shuffle: true,
                        related: false,
                        langCode,
                        geoLocale: locale,
                        sourceOrder: this.bot.config.searchSettings.queryEngines
                    })

                    if (isAborted()) {
                        this.bot.logger.warn(
                            isMobile,
                            'ABORT',
                            '🚨 Extra search dibatalkan oleh sinyal abort/deadline timeout saat query generation.'
                        )
                        break
                    }

                    const merged = [...queries, ...extra].map(q => q.trim()).filter(Boolean)
                    const newPool = [...new Set(merged)]
                    queries = this.bot.utils.shuffleArray(newPool)

                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING-EXTRA',
                        `New search query pool generated | count=${queries.length} | refill=${poolRefills}/${maxPoolRefill}`
                    )

                    let pointsGainedThisPool = 0

                    for (const query of queries) {
                        if (isAborted()) {
                            this.bot.logger.warn(
                                isMobile,
                                'ABORT',
                                '🚨 Extra search dibatalkan seketika oleh sinyal abort/deadline timeout.'
                            )
                            break
                        }

                        const trimmedQuery = query?.trim() ?? ''
                        if (trimmedQuery.length < 5 || !trimmedQuery.includes(' ')) {
                            continue
                        }

                        this.bot.logger.info(
                            isMobile,
                            'SEARCH-BING-EXTRA',
                            `Extra search (${isMobile ? 'Mobile' : 'Desktop'}) | remaining=${missingPointsTotal} | query="${query}"`
                        )

                        searchCount++
                        searchCounters = await this.bingSearch(page, query, isMobile, searchCount)
                        if (isAborted()) {
                            this.bot.logger.warn(
                                isMobile,
                                'ABORT',
                                '🚨 Extra search dibatalkan pasca kueri oleh sinyal abort/deadline timeout.'
                            )
                            break
                        }

                        const newMissingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
                        let newMissingPointsTotal = newMissingPoints.totalPoints

                        // Sanity Clamp & Eliminasi Poin Negatif
                        if (newMissingPointsTotal > missingPointsTotal) {
                            this.bot.logger.warn(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `[COUNTER-ANOMALY] Counter melonjak dari ${missingPointsTotal} ke ${newMissingPointsTotal}. Mengabaikan anomali counter Bing dan menggunakan baseline kueri (+3 poin).`
                            )
                            newMissingPointsTotal = Math.max(0, missingPointsTotal - 3)
                        }

                        const rawDelta = missingPointsTotal - newMissingPointsTotal
                        const gainedPoints = Math.max(0, rawDelta)

                        if (gainedPoints === 0) {
                            stagnantLoop++
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `No points gained ${stagnantLoop}/${stagnantLoopMax} | query="${query}" | remaining=${newMissingPointsTotal}`
                            )

                            if (stagnantLoop >= stagnantLoopMax) {
                                this.bot.logger.info(
                                    isMobile,
                                    'SEARCH-BING-EXTRA',
                                    `Stagnant threshold reached (${stagnantLoop}/${stagnantLoopMax}), performing server hard-verification...`
                                )
                                const verifyRes = await this.verifyPointsWithServer(page, isMobile)
                                if (verifyRes.verifiedGained && verifyRes.newBalance) {
                                    const actualGained = verifyRes.gained ?? 0
                                    this.bot.logger.info(
                                        isMobile,
                                        'SEARCH-BING-EXTRA',
                                        `Hard-verification SUCCESS: Server points increased by +${actualGained} (new balance: ${verifyRes.newBalance}). Resetting stagnant loop.`,
                                        'green'
                                    )
                                    this.bot.userData.currentPoints = verifyRes.newBalance
                                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + actualGained
                                    totalGainedPoints += actualGained
                                    pointsGainedThisPool += actualGained
                                    stagnantLoop = 0
                                } else {
                                    this.bot.logger.warn(
                                        isMobile,
                                        'SEARCH-BING-EXTRA',
                                        `[COOLDOWN-DETECTED] Microsoft 15-Minute Search Cooldown aktif pada akun ini (Server verified points stagnant after ${stagnantLoopMax} queries). Aborting extra searches.`
                                    )
                                    this.bot.searchCooldownActive = true
                                    isCooldownDetected = true
                                    break
                                }
                            }
                        } else {
                            stagnantLoop = 0

                            this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                            totalGainedPoints += gainedPoints
                            pointsGainedThisPool += gainedPoints

                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `gainedPoints=${gainedPoints} points | query="${query}" | remaining=${newMissingPointsTotal}`,
                                'green'
                            )
                        }

                        missingPointsTotal = newMissingPointsTotal

                        if (missingPointsTotal === 0) {
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                'All required search points earned during extra searches'
                            )
                            break
                        }
                    }

                    // CRITICAL: Penghentian seketika jika abort signal aktif, cooldown aktif, atau target tercapai
                    if (isAborted() || isCooldownDetected || missingPointsTotal === 0) {
                        break
                    }

                    // Circuit Breaker: Jika dalam 1 pool refill tidak ada poin yang bertambah sama sekali, jangan re-pool lagi
                    if (pointsGainedThisPool === 0) {
                        this.bot.logger.warn(
                            isMobile,
                            'SEARCH-BING-EXTRA',
                            '[CIRCUIT-BREAKER] Pool kueri ekstra tidak menghasilkan poin baru. Menghentikan regenerasi kueri untuk mencegah loop tak terbatas.'
                        )
                        break
                    }
                }

                if (missingPointsTotal > 0 && poolRefills >= maxPoolRefill) {
                    this.bot.logger.warn(
                        isMobile,
                        'SEARCH-BING-EXTRA',
                        `[CIRCUIT-BREAKER] Batas maksimal regenerasi pool kueri (${maxPoolRefill}) tercapai dengan sisa poin ${missingPointsTotal}. Menghentikan pencarian ekstra secara elegan.`
                    )
                }
            }

            const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)

            this.bot.logger.info(
                isMobile,
                'SEARCH-BING',
                `Completed Bing searches | startBalance=${startBalance} | newBalance=${finalBalance}`
            )

            return totalGainedPoints
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'SEARCH-BING',
                `Error in doSearch | message=${error instanceof Error ? error.message : String(error)}`
            )
            await this.bot.utils.wait(1000)
            return totalGainedPoints
        }
    }

    private async bingSearch(searchPage: Page, query: string, isMobile: boolean, currentSearchCount: number) {
        const maxAttempts = 5
        const refreshThreshold = 10 // Page gets sluggish after x searches?

        const isAborted = () => {
            return Boolean(
                this.bot.abortController?.signal?.aborted ||
                this.bot.accountScope?.abortController?.signal?.aborted ||
                searchPage.isClosed()
            )
        }

        if (isAborted()) {
            this.bot.logger.warn(
                isMobile,
                'SEARCH-BING',
                '🚨 Sesi pencarian dibatalkan seketika: sinyal abort/deadline timeout aktif atau page telah ditutup.'
            )
            return await this.bot.browser.func.getSearchPoints(searchPage, false, isMobile).catch(() => ({} as Counters))
        }

        if (currentSearchCount % refreshThreshold === 0) {
            this.bot.logger.info(
                isMobile,
                'SEARCH-BING',
                `Returning to home page to clear accumulated page context | count=${currentSearchCount} | threshold=${refreshThreshold}`
            )

            this.bot.logger.debug(isMobile, 'SEARCH-BING', `Returning home to refresh state | url=${this.bingHome}`)

            const cvid = randomBytes(16).toString('hex')
            const url = `${this.bingHome}/search?q=${encodeURIComponent(query)}&cvid=${cvid}`

            await searchPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
            await this.bot.browser.utils.tryDismissAllMessages(searchPage)
        }

        this.bot.logger.debug(
            isMobile,
            'SEARCH-BING',
            `Starting search session | maxAttempts=${maxAttempts} | query="${query}"`
        )

        for (let i = 0; i < maxAttempts; i++) {
            if (isAborted()) {
                this.bot.logger.warn(
                    isMobile,
                    'SEARCH-BING',
                    '🚨 Iterasi retry dibatalkan: sinyal abort/timeout aktif atau page telah ditutup.'
                )
                break
            }

            try {
                const searchBarSelector = '#sb_form_q, input[name="q"], textarea[name="q"], input.b_searchbox, input[type="search"]'
                const searchBox = searchPage.locator(searchBarSelector).first()

                await searchPage.evaluate(() => {
                    window.scrollTo({ left: 0, top: 0, behavior: 'auto' })
                }).catch(() => {})

                await searchPage.keyboard.press('Home').catch(() => {})
                
                // Cek apakah input search bar siap digunakan dalam 2 detik
                const isReady = await searchBox.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)

                if (isReady) {
                    await searchBox.click({ timeout: 1500 }).catch(() => {})
                    await searchBox.fill('')
                    // Pengetikan terakselerasi aman: random jitter 25ms - 55ms per karakter
                    for (const char of query) {
                        const charDelay = Math.floor(Math.random() * (55 - 25 + 1)) + 25
                        await searchPage.keyboard.type(char, { delay: charDelay })
                    }
                    await searchPage.keyboard.press('Enter')
                } else {
                    // Resilient Fallback: Navigasi langsung ke URL pencarian bersih tanpa parameter statis mencurigakan
                    const cvid = randomBytes(16).toString('hex')
                    const searchUrl = `${this.bingHome}/search?q=${encodeURIComponent(query)}&cvid=${cvid}`
                    await searchPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
                }

                this.bot.logger.debug(
                    isMobile,
                    'SEARCH-BING',
                    `Submitted query to Bing | attempt=${i + 1}/${maxAttempts} | query="${query}"`
                )

                // Jeda natural navigasi SERP termuat
                await this.bot.utils.wait(800)

                if (this.bot.config.searchSettings.organicSearch?.enabled) {
                    await this.organicEngine.simulateOrganicCTR(searchPage, isMobile)
                } else {
                    if (this.bot.config.searchSettings.scrollRandomResults) {
                        await this.randomScroll(searchPage, isMobile)
                    }

                    if (this.bot.config.searchSettings.clickRandomResults) {
                        await this.clickRandomLink(searchPage, isMobile)
                    }
                }

                // Rentang aman dinamis 10 - 14 detik (rata-rata 12s, tetap aman di atas ambang batas cooldown Microsoft >6s)
                const configuredMin = this.bot.config.searchSettings.searchDelay?.min
                    ? this.bot.utils.stringToNumber(this.bot.config.searchSettings.searchDelay.min)
                    : 10000
                const configuredMax = this.bot.config.searchSettings.searchDelay?.max
                    ? this.bot.utils.stringToNumber(this.bot.config.searchSettings.searchDelay.max)
                    : 14000
                const safeMin = Math.max(10000, Math.min(configuredMin, 12000))
                const safeMax = Math.max(safeMin, Math.min(configuredMax, 14000))
                const dynamicSearchDelay = Math.floor(Math.random() * (safeMax - safeMin + 1)) + safeMin
                await this.bot.utils.wait(dynamicSearchDelay)

                const counters = await this.bot.browser.func.getSearchPoints(searchPage, false, isMobile)

                this.bot.logger.debug(
                    isMobile,
                    'SEARCH-BING',
                    `Search counters after query | attempt=${i + 1}/${maxAttempts} | query="${query}"`
                )

                return counters
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error)
                const isNavOrClosedError =
                    errMsg.includes('Target page, context or browser has been closed') ||
                    errMsg.includes('page closed') ||
                    errMsg.includes('context closed') ||
                    errMsg.includes('browser has been closed') ||
                    errMsg.includes('has been destroyed')

                if (isAborted() || isNavOrClosedError) {
                    this.bot.logger.warn(
                        isMobile,
                        'SEARCH-BING',
                        `🚨 [ABORT-DETECTED] Halaman ditutup atau timeout tercapai (${errMsg}). Menghentikan retry search seketika tanpa perulangan zombie!`
                    )
                    await this.bot.utils.wait(1000)
                    break
                }

                if (i >= maxAttempts - 1) {
                    this.bot.logger.error(
                        isMobile,
                        'SEARCH-BING',
                        `Failed after ${maxAttempts} retries | query="${query}" | message=${errMsg}`
                    )
                    break
                }

                this.bot.logger.error(
                    isMobile,
                    'SEARCH-BING',
                    `Search attempt failed | attempt=${i + 1}/${maxAttempts} | query="${query}" | message=${errMsg}`
                )

                this.bot.logger.warn(
                    isMobile,
                    'SEARCH-BING',
                    `Retrying search | attempt=${i + 1}/${maxAttempts} | query="${query}"`
                )

                await this.bot.utils.wait(1500)
            }
        }

        if (isAborted()) {
            return await this.bot.browser.func.getSearchPoints(searchPage, false, isMobile).catch(() => ({} as Counters))
        }

        this.bot.logger.debug(
            isMobile,
            'SEARCH-BING',
            `Returning current search counters after failed retries | query="${query}"`
        )

        return await this.bot.browser.func.getSearchPoints(searchPage, true, isMobile)
    }

    private async randomScroll(page: Page, isMobile: boolean) {
        try {
            if (page.isClosed()) return

            const viewportHeight = await page.evaluate(() => window.innerHeight || 800).catch(() => 800)
            const totalHeight = await page.evaluate(() => {
                const totalHeight = document.scrollingElement?.scrollHeight || document.body?.scrollHeight || window.innerHeight || 1000
                return totalHeight
            }).catch(() => 1000)

            const maxScroll = Math.max(0, totalHeight - viewportHeight)
            const randomScrollPosition = maxScroll > 0 ? Math.floor(Math.random() * maxScroll) : 0

            this.bot.logger.debug(
                isMobile,
                'SEARCH-RANDOM-SCROLL',
                `Random scroll | viewportHeight=${viewportHeight} | totalHeight=${totalHeight} | scrollPos=${randomScrollPosition}`
            )

            if (randomScrollPosition > 0) {
                await page.evaluate((scrollPos: number) => {
                    window.scrollTo({ left: 0, top: scrollPos, behavior: 'auto' })
                }, randomScrollPosition).catch(() => {})
            }
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'SEARCH-RANDOM-SCROLL',
                `An error occurred during random scroll | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async clickRandomLink(page: Page, isMobile: boolean) {
        try {
            this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', 'Attempting to click a random search result link')

            const searchPageUrl = page.url()

            await this.bot.browser.utils.ghostClick(page, '#b_results .b_algo h2')
            await this.bot.utils.wait(this.bot.config.searchSettings.searchResultVisitTime)

            if (isMobile) {
                await page.goto(searchPageUrl)
                this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', 'Navigated back to search page')
            } else {
                const newTab = await this.bot.browser.utils.getLatestTab(page)
                const newTabUrl = newTab.url()

                this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', `Visited result tab | url=${newTabUrl}`)

                await this.bot.browser.utils.closeTabs(newTab)
                this.bot.logger.debug(isMobile, 'SEARCH-RANDOM-CLICK', 'Closed result tab')
            }
        } catch (error) {
            this.bot.logger.error(
                isMobile,
                'SEARCH-RANDOM-CLICK',
                `An error occurred during random click | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async verifyPointsWithServer(
        page: Page,
        _isMobile: boolean
    ): Promise<{ verifiedGained: boolean; newBalance?: number; gained?: number }> {
        try {
            const ctx = page.context()
            if (ctx && ctx.request) {
                const cacheBuster = Date.now()
                const res = await ctx.request.get(
                    `https://rewards.bing.com/api/getuserinfo?type=1&_=${cacheBuster}`,
                    { timeout: 5000, failOnStatusCode: false }
                )
                if (res && typeof res.ok === 'function' && res.ok()) {
                    const data = await res.json().catch(() => null)
                    const availablePoints =
                        data?.dashboard?.userStatus?.availablePoints ??
                        data?.userStatus?.availablePoints
                    const currentBalance =
                        typeof availablePoints === 'number'
                            ? availablePoints
                            : Number(this.bot.userData.currentPoints ?? 0)
                    const oldRecordedPoints = Number(this.bot.userData.currentPoints ?? 0)

                    if (currentBalance > oldRecordedPoints) {
                        return {
                            verifiedGained: true,
                            newBalance: currentBalance,
                            gained: currentBalance - oldRecordedPoints
                        }
                    }
                }
            }
        } catch {}
        return { verifiedGained: false }
    }
}
