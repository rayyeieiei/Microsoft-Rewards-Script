import type { Page } from 'patchright'
import { randomBytes } from 'crypto'
import type { Counters, DashboardData } from '../../../interface/DashboardData'

import { QueryCore } from '../../QueryEngine'
import { Workers } from '../../Workers'
import { Database } from '../../../util/Database'
import { OrganicEngine } from './OrganicEngine'
import { TopicalChainer } from './TopicalChainer'
import { interruptibleWait } from '../../../runtime/BrowserOperationGuard'

import type { QueryEngine } from '../../../interface/Config'

export class Search extends Workers {
    private bingHome = 'https://bing.com'
    private organicEngine: OrganicEngine = new OrganicEngine(this.bot)
    private topicalChainer: TopicalChainer = new TopicalChainer(this.bot)

    public async doSearch(data: DashboardData, page: Page, isMobile: boolean, abortSignal?: AbortSignal): Promise<number> {
        const signal = abortSignal || this.bot.accountScope?.abortController.signal
        const startBalance = Number(this.bot.userData.currentPoints ?? 0)
        let searchCount = 0

        this.bot.logger.info(isMobile, 'SEARCH-BING', `Starting Bing searches (${isMobile ? 'Mobile' : 'Desktop'}) | currentPoints=${startBalance}`)

        let totalGainedPoints = 0

        try {
            if (data?.userStatus?.counters) {
                this.bot.browser.func.cachedCounters = JSON.parse(JSON.stringify(data.userStatus.counters))
            }
            let searchCounters: Counters = await this.bot.browser.func.getSearchPoints(page, false, isMobile, false)
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

            const isDualMode = this.bot.config?.executionMode === 'dual'
            if (this.bot.searchCooldownActive || (isDualMode && typeof (this.bot as any).isCircuitBreakerTriggered === 'function' && (this.bot as any).isCircuitBreakerTriggered())) {
                this.bot.logger.warn(
                    isMobile,
                    'SEARCH-BING',
                    `[COOLDOWN-DETECTED] Search cooldown or circuit breaker active for this batch, skipping ${isMobile ? 'Mobile' : 'Desktop'} searches.`
                )
                return totalGainedPoints
            }

            this.topicalChainer.resetChain()

            // Pasang dedicated page-level route blocker untuk mematikan render gambar, media, font, dan elemen berat selama pencarian
            await page.route('**/*', route => {
                const req = route.request()
                const resourceType = req.resourceType()
                const url = req.url().toLowerCase()

                // Whitelist telemetri penting & verifikasi poin: JANGAN PERNAH dibatalkan
                const isRewardsTelemetry =
                    url.includes('/fd/ls/') ||
                    url.includes('/rewards/api/') ||
                    url.includes('c.bing.com') ||
                    url.includes('rewards.bing.com') ||
                    url.includes('activityid=') ||
                    url.includes('/rewards/log') ||
                    url.includes('/fd/ls/lsp.aspx') ||
                    url.includes('rewardsapp/reportactivity')

                if (['image', 'media', 'font', 'websocket'].includes(resourceType)) {
                    if (resourceType === 'image' && (url.includes('/fd/ls/lsp.aspx') || url.includes('/fd/ls/'))) {
                        return route.continue().catch(() => {})
                    }
                    this.bot.trackBlockedRequest()
                    return route.abort().catch(() => {})
                }

                if (isRewardsTelemetry) {
                    return route.continue().catch(() => {})
                }

                // Blokir tracker & domain berat (JANGAN blokir bing.com/rp/ karena memuat JS inti Bing)
                if (
                    url.includes('copilot.microsoft.com') ||
                    url.includes('sydney.bing.com') ||
                    url.includes('adnxs.com') ||
                    url.includes('clarity.ms') ||
                    url.includes('/as/api/') ||
                    url.includes('msn.com/api/news') ||
                    url.includes('bing.com/overlay') ||
                    url.includes('bing.net/th') ||
                    url.includes('mm.bing.net') ||
                    url.includes('th.bing.com') ||
                    url.includes('bing.com/sa/simg')
                ) {
                    this.bot.trackBlockedRequest()
                    return route.abort().catch(() => {})
                }

                return route.continue().catch(() => {})
            }).catch(() => {})

            // Go to bing
            this.bot.logger.debug(isMobile, 'SEARCH-BING', `Navigating to search page | url=${this.bingHome}`)

            await page.goto(this.bingHome, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
            await this.bot.browser.utils.tryDismissAllMessages(page)

            let stagnantLoop = 0
            const stagnantLoopMax = 3
            let isCooldownDetected = false
            let isLevelUpHandled = false
            let currentMax = isMobile
                ? (searchCounters.mobileSearch?.[0]?.pointProgressMax ?? 60)
                : ((searchCounters.pcSearch?.[0]?.pointProgressMax ?? 0) + (searchCounters.pcSearch?.[1]?.pointProgressMax ?? 0))
            if (currentMax === 0) currentMax = isMobile ? 60 : 90
            let lastSyncedPoints = Number(this.bot.userData.currentPoints ?? 0)
            let lastSyncedProgress = isMobile
                ? (searchCounters.mobileSearch?.[0]?.pointProgress ?? 0)
                : ((searchCounters.pcSearch?.[0]?.pointProgress ?? 0) + (searchCounters.pcSearch?.[1]?.pointProgress ?? 0))
            const initialSessionTarget = missingPointsTotal

            for (let i = 0; i < queries.length; i++) {
                if (signal?.aborted) {
                    this.bot.logger.warn(
                        isMobile,
                        'SEARCH-BING',
                        '[ABORT] Search aborted by signal.'
                    )
                    break
                }

                if (isDualMode && typeof (this.bot as any).isCircuitBreakerTriggered === 'function' && (this.bot as any).isCircuitBreakerTriggered()) {
                    this.bot.logger.warn(
                        isMobile,
                        'SEARCH-BING',
                        `[CIRCUIT-BREAKER] Circuit breaker active on this batch. Gracefully aborting search loop to protect account.`
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

                const normalizedQ = trimmedQuery.replace(/\s+/g, ' ').toLowerCase()
                if (QueryCore.sessionUsedQueries.has(normalizedQ)) {
                    this.bot.logger.debug(
                        isMobile,
                        'SEARCH-BING',
                        `Skipping query already used in session: "${trimmedQuery}"`
                    )
                    continue
                }
                QueryCore.sessionUsedQueries.add(normalizedQ)

                searchCount++

                searchCounters = await this.bingSearch(page, query, isMobile, searchCount, searchCounters, signal)
                const newMissingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
                let newMissingPointsTotal = newMissingPoints.totalPoints

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

                const newMax = isMobile
                    ? (searchCounters.mobileSearch?.[0]?.pointProgressMax ?? currentMax)
                    : ((searchCounters.pcSearch?.[0]?.pointProgressMax ?? 0) + (searchCounters.pcSearch?.[1]?.pointProgressMax ?? 0))

                const counterDelta = missingPointsTotal - newMissingPointsTotal
                const currentServerProgress = isMobile
                    ? (searchCounters.mobileSearch?.[0]?.pointProgress ?? 0)
                    : ((searchCounters.pcSearch?.[0]?.pointProgress ?? 0) + (searchCounters.pcSearch?.[1]?.pointProgress ?? 0))
                const currentServerBalance = Number(this.bot.userData.currentPoints ?? 0)

                // Verifikasi riil saldo server dan header bing
                const verifyRes = await this.verifyPointsWithServer(page, isMobile)
                const confirmedServerBalance = verifyRes.newBalance ?? currentServerBalance
                const serverBalanceDelta = confirmedServerBalance - lastSyncedPoints
                const progressDelta = currentServerProgress - lastSyncedProgress
                const serverPointsGained = Math.max(
                    verifyRes.gained ?? 0,
                    serverBalanceDelta > 0 ? serverBalanceDelta : 0,
                    progressDelta > 0 ? progressDelta : 0,
                    counterDelta > 0 ? counterDelta : 0
                )

                if (counterDelta < 0 || (newMax > currentMax && !isLevelUpHandled)) {
                    if (newMax > currentMax && !isLevelUpHandled) {
                        isLevelUpHandled = true
                        const previousMax = currentMax
                        currentMax = newMax
                        const sessionRemaining = Math.max(0, initialSessionTarget - totalGainedPoints)
                        newMissingPointsTotal = Math.min(newMissingPointsTotal, sessionRemaining)

                        this.bot.logger.info(
                            isMobile,
                            'SEARCH-BING',
                            `[LEVEL-UP] Search quota expanded mid-session (Level 1 -> Level 2 detected: max ${previousMax} -> ${newMax}). Locking session target to initial budget (${newMissingPointsTotal} pts remaining) to prevent abnormal activity surge.`,
                            'green'
                        )
                    }
                }

                let gainedPoints = Math.max(0, counterDelta)
                if (serverPointsGained > 0) {
                    gainedPoints = Math.min(3, Math.max(gainedPoints, serverPointsGained))
                    stagnantLoop = 0

                    const decrementedRemaining = Math.max(0, missingPointsTotal - gainedPoints)
                    newMissingPointsTotal = decrementedRemaining

                    void Database.getInstance().recordActivity(
                        currentEmail,
                        isMobile ? 'SEARCH_MOBILE' : 'SEARCH_DESKTOP',
                        gainedPoints
                    )

                    this.bot.userData.currentPoints = confirmedServerBalance > curPoints ? confirmedServerBalance : curPoints + gainedPoints
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                    totalGainedPoints += gainedPoints
                    lastSyncedPoints = Number(this.bot.userData.currentPoints ?? 0)
                    lastSyncedProgress = currentServerProgress

                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING',
                        `[SEARCH-VERIFIED] Server confirmed +${gainedPoints} points | query="${query}" | remaining=${newMissingPointsTotal} | balance=${this.bot.userData.currentPoints}`,
                        'green'
                    )
                } else {
                    stagnantLoop++
                    newMissingPointsTotal = missingPointsTotal
                    this.bot.logger.warn(
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
                        const hardRes = await this.verifyPointsWithServer(page, isMobile)
                        if (hardRes.verifiedGained && hardRes.newBalance && hardRes.gained) {
                            const actualGained = Math.max(0, hardRes.gained)
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING',
                                `Hard-verification SUCCESS: Server points increased by +${actualGained} (new balance: ${hardRes.newBalance}). Resetting stagnant loop.`,
                                'green'
                            )
                            this.bot.userData.currentPoints = hardRes.newBalance
                            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + actualGained
                            totalGainedPoints += actualGained
                            lastSyncedPoints = hardRes.newBalance
                            lastSyncedProgress = isMobile
                                ? (searchCounters.mobileSearch?.[0]?.pointProgress ?? 0)
                                : ((searchCounters.pcSearch?.[0]?.pointProgress ?? 0) + (searchCounters.pcSearch?.[1]?.pointProgress ?? 0))
                            stagnantLoop = 0
                            newMissingPointsTotal = Math.max(0, missingPointsTotal - actualGained)
                        } else {
                            this.bot.logger.warn(
                                isMobile,
                                'SEARCH-BING',
                                `[COOLDOWN-DETECTED] Microsoft 15-Minute Search Cooldown aktif pada akun ini (Server verified points stagnant after ${stagnantLoopMax} queries). Aborting search loop for graceful hand-off.`
                            )
                            this.bot.searchCooldownActive = true
                            const isDualMode = this.bot.config?.executionMode === 'dual'
                            if (isDualMode && typeof (this.bot as any).triggerCircuitBreaker === 'function') {
                                (this.bot as any).triggerCircuitBreaker(`15-Minute Search Cooldown aktif pada ${currentEmail}`)
                            }
                            isCooldownDetected = true
                            break
                        }
                    }
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
                if (missingPointsTotal > 0 && remainingQueries < minBuffer) {
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

                    const merged = [...queries, ...extra].map(q => q.trim()).filter(Boolean)
                    queries = [...new Set(merged)]
                    queries = this.bot.utils.shuffleArray(queries)

                    this.bot.logger.debug(isMobile, 'SEARCH-BING', `Query pool regenerated | count=${queries.length}`)
                }
            }

            if (missingPointsTotal > 0 && !isCooldownDetected) {
                this.bot.logger.info(
                    isMobile,
                    'SEARCH-BING',
                    `Search completed but still missing points, continuing with regenerated queries | remaining=${missingPointsTotal}`
                )

                let stagnantLoop = 0
                const stagnantLoopMax = 3
                let lastExtraSyncedPoints = Number(this.bot.userData.currentPoints ?? 0)
                let lastExtraSyncedProgress = isMobile
                    ? (searchCounters.mobileSearch?.[0]?.pointProgress ?? 0)
                    : ((searchCounters.pcSearch?.[0]?.pointProgress ?? 0) + (searchCounters.pcSearch?.[1]?.pointProgress ?? 0))

                while (missingPointsTotal > 0 && !isCooldownDetected) {
                    const extra = await queryCore.queryManager({
                        shuffle: true,
                        related: false,
                        langCode,
                        geoLocale: locale,
                        sourceOrder: this.bot.config.searchSettings.queryEngines
                    })

                    const merged = [...queries, ...extra].map(q => q.trim()).filter(Boolean)
                    const newPool = [...new Set(merged)]
                    queries = this.bot.utils.shuffleArray(newPool)

                    this.bot.logger.info(
                        isMobile,
                        'SEARCH-BING-EXTRA',
                        `New search query pool generated | count=${queries.length}`
                    )

                    for (const query of queries) {
                        if (signal?.aborted) {
                            this.bot.logger.warn(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                '[ABORT] Extra search aborted by signal.'
                            )
                            break
                        }

                        const trimmedQuery = query?.trim() ?? ''
                        if (trimmedQuery.length < 5 || !trimmedQuery.includes(' ')) {
                            continue
                        }

                        const normalizedQ = trimmedQuery.replace(/\s+/g, ' ').toLowerCase()
                        if (QueryCore.sessionUsedQueries.has(normalizedQ)) {
                            this.bot.logger.debug(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `Skipping query already used in session: "${trimmedQuery}"`
                            )
                            continue
                        }
                        QueryCore.sessionUsedQueries.add(normalizedQ)

                        this.bot.logger.info(
                            isMobile,
                            'SEARCH-BING-EXTRA',
                            `Extra search (${isMobile ? 'Mobile' : 'Desktop'}) | remaining=${missingPointsTotal} | query="${query}"`
                        )

                        searchCount++
                        searchCounters = await this.bingSearch(page, query, isMobile, searchCount, searchCounters, signal)
                        const newMissingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
                        let newMissingPointsTotal = newMissingPoints.totalPoints

                        const counterDelta = missingPointsTotal - newMissingPointsTotal
                        const currentServerProgress = isMobile
                            ? (searchCounters.mobileSearch?.[0]?.pointProgress ?? 0)
                            : ((searchCounters.pcSearch?.[0]?.pointProgress ?? 0) + (searchCounters.pcSearch?.[1]?.pointProgress ?? 0))
                        const currentServerBalance = Number(this.bot.userData.currentPoints ?? 0)

                        // Verifikasi riil saldo server dan header bing
                        const verifyRes = await this.verifyPointsWithServer(page, isMobile)
                        const confirmedServerBalance = verifyRes.newBalance ?? currentServerBalance
                        const serverBalanceDelta = confirmedServerBalance - lastExtraSyncedPoints
                        const progressDelta = currentServerProgress - lastExtraSyncedProgress
                        const serverPointsGained = Math.max(
                            verifyRes.gained ?? 0,
                            serverBalanceDelta > 0 ? serverBalanceDelta : 0,
                            progressDelta > 0 ? progressDelta : 0,
                            counterDelta > 0 ? counterDelta : 0
                        )

                        let gainedPoints = 0
                        if (serverPointsGained > 0) {
                            gainedPoints = Math.min(3, serverPointsGained)
                            stagnantLoop = 0

                            const decrementedRemaining = Math.max(0, missingPointsTotal - gainedPoints)
                            newMissingPointsTotal = decrementedRemaining

                            const currentEmail = this.bot.activeAccount?.email || this.bot.userData.userName
                            void Database.getInstance().recordActivity(
                                currentEmail,
                                isMobile ? 'SEARCH_MOBILE' : 'SEARCH_DESKTOP',
                                gainedPoints
                            )

                            this.bot.userData.currentPoints = confirmedServerBalance > currentServerBalance ? confirmedServerBalance : currentServerBalance + gainedPoints
                            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                            totalGainedPoints += gainedPoints
                            lastExtraSyncedPoints = Number(this.bot.userData.currentPoints ?? 0)
                            lastExtraSyncedProgress = currentServerProgress

                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `[SEARCH-VERIFIED] Extra server confirmed +${gainedPoints} points | query="${query}" | remaining=${newMissingPointsTotal} | balance=${this.bot.userData.currentPoints}`,
                                'green'
                            )
                        } else {
                            stagnantLoop++
                            newMissingPointsTotal = missingPointsTotal
                            this.bot.logger.warn(
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
                                const hardRes = await this.verifyPointsWithServer(page, isMobile)
                                if (hardRes.verifiedGained && hardRes.newBalance && hardRes.gained) {
                                    const actualGained = Math.max(0, hardRes.gained)
                                    this.bot.logger.info(
                                        isMobile,
                                        'SEARCH-BING-EXTRA',
                                        `Hard-verification SUCCESS: Server points increased by +${actualGained} (new balance: ${hardRes.newBalance}). Resetting stagnant loop.`,
                                        'green'
                                    )
                                    this.bot.userData.currentPoints = hardRes.newBalance
                                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + actualGained
                                    totalGainedPoints += actualGained
                                    lastExtraSyncedPoints = hardRes.newBalance
                                    lastExtraSyncedProgress = isMobile
                                        ? (searchCounters.mobileSearch?.[0]?.pointProgress ?? 0)
                                        : ((searchCounters.pcSearch?.[0]?.pointProgress ?? 0) + (searchCounters.pcSearch?.[1]?.pointProgress ?? 0))
                                    stagnantLoop = 0
                                    newMissingPointsTotal = Math.max(0, missingPointsTotal - actualGained)
                                } else {
                                    this.bot.logger.warn(
                                        isMobile,
                                        'SEARCH-BING-EXTRA',
                                        `[COOLDOWN-DETECTED] Microsoft 15-Minute Search Cooldown aktif pada akun ini (Server verified points stagnant after ${stagnantLoopMax} queries). Aborting extra searches.`
                                    )
                                    this.bot.searchCooldownActive = true
                                    const isDualMode = this.bot.config?.executionMode === 'dual'
                                    if (isDualMode && typeof (this.bot as any).triggerCircuitBreaker === 'function') {
                                        const targetAcc = this.bot.activeAccount?.email || this.bot.userData.userName
                                        ;(this.bot as any).triggerCircuitBreaker(`15-Minute Search Cooldown aktif pada ${targetAcc}`)
                                    }
                                    isCooldownDetected = true
                                    break
                                }
                            }
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

                    if (isCooldownDetected) {
                        break
                    }
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
            return totalGainedPoints
        }
    }

    private async bingSearch(
        searchPage: Page,
        query: string,
        isMobile: boolean,
        currentSearchCount: number,
        currentCounters?: Counters,
        signal?: AbortSignal
    ): Promise<Counters> {
        const maxAttempts = 5
        const refreshThreshold = 10 // Page gets sluggish after x searches?

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
            try {
                const searchBarSelector = '#sb_form_q, input[name="q"], textarea[name="q"], input.b_searchbox, input[type="search"]'
                const searchBox = searchPage.locator(searchBarSelector).first()

                await Promise.race([
                    searchPage.evaluate(() => {
                        window.scrollTo({ left: 0, top: 0, behavior: 'auto' })
                    }),
                    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('EVAL_TIMEOUT')), 5000))
                ]).catch(() => {})

                await searchPage.keyboard.press('Home').catch(() => {})
                
                // Cek apakah input search bar siap digunakan dalam 2 detik
                const isReady = await searchBox.waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false)

                if (isReady) {
                    await searchBox.click({ timeout: 1500 }).catch(() => {})
                    await searchBox.fill('')
                    // Pengetikan realistis dengan random jitter 25ms - 55ms per karakter
                    for (const char of query) {
                        const charDelay = Math.floor(Math.random() * (55 - 25 + 1)) + 25
                        await searchPage.keyboard.type(char, { delay: charDelay })
                    }

                    const searchNavPromise = searchPage.waitForURL(
                        url => url.pathname.includes('/search') && (url.searchParams.has('q') || url.href.includes('q=')),
                        { timeout: 7000 }
                    ).catch(() => null)

                    const searchBtn = searchPage.locator('#sb_form_go, input[type="submit"], button[type="submit"], label[for="sb_form_go"]').first()
                    const btnVisible = await searchBtn.isVisible().catch(() => false)
                    if (btnVisible) {
                        await searchBtn.click({ timeout: 2000 }).catch(() => {})
                    } else {
                        await searchPage.keyboard.press('Enter').catch(() => {})
                    }

                    const navigated = await searchNavPromise
                    if (!navigated) {
                        const cvid = randomBytes(16).toString('hex').toUpperCase()
                        const formParam = isMobile ? 'QBLH' : 'QBRE'
                        const searchUrl = `${this.bingHome}/search?q=${encodeURIComponent(query)}&form=${formParam}&cvid=${cvid}`
                        await searchPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {})
                    }
                } else {
                    // Resilient Fallback: Navigasi langsung ke URL pencarian dengan form & cvid valid
                    const cvid = randomBytes(16).toString('hex').toUpperCase()
                    const formParam = isMobile ? 'QBLH' : 'QBRE'
                    const searchUrl = `${this.bingHome}/search?q=${encodeURIComponent(query)}&form=${formParam}&cvid=${cvid}`
                    await searchPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {})
                }

                this.bot.logger.debug(
                    isMobile,
                    'SEARCH-BING',
                    `Submitted query to Bing | attempt=${i + 1}/${maxAttempts} | query="${query}"`
                )

                // Hapus jeda ganda redundan, satukan menjadi satu jeda natural 800–1200ms
                const postSubmitDwell = Math.floor(Math.random() * (1200 - 800 + 1)) + 800
                await interruptibleWait(postSubmitDwell, signal)

                if (this.bot.config.searchSettings.organicSearch?.enabled) {
                    await this.organicEngine.simulateOrganicCTR(searchPage, isMobile)
                } else {
                    if (this.bot.config.searchSettings.scrollRandomResults) {
                        await this.randomScroll(searchPage, isMobile)
                    }

                    if (this.bot.config.searchSettings.clickRandomResults) {
                        await interruptibleWait(postSubmitDwell, signal)
                        await this.clickRandomLink(searchPage, isMobile)
                    }
                }

                // Rentang searchDelay aman 10–14 detik (rata-rata 12 detik)
                const rawMinDelay = this.bot.config.searchSettings.searchDelay?.min
                    ? this.bot.utils.stringToNumber(this.bot.config.searchSettings.searchDelay.min)
                    : 10000
                const rawMaxDelay = this.bot.config.searchSettings.searchDelay?.max
                    ? this.bot.utils.stringToNumber(this.bot.config.searchSettings.searchDelay.max)
                    : 14000
                const minDelay = Math.max(10000, Math.min(14000, rawMinDelay))
                const maxDelay = Math.max(minDelay, Math.min(14000, rawMaxDelay))
                await interruptibleWait(this.bot.utils.randomDelay(minDelay, maxDelay), signal)

                // In-page balance tracking (#id_rc atau #rh_meter) dengan timeout terikat 8000ms
                const inPageBalance = await Promise.race([
                    searchPage.evaluate(() => {
                        const rc = document.getElementById('id_rc')?.innerText?.replace(/[^0-9]/g, '')
                        if (rc && !isNaN(Number(rc)) && Number(rc) > 0) return Number(rc)
                        const flyout = document.querySelector('#rh_meter .rh_meter_points, .id_rh_pts, #id_rh')?.textContent?.replace(/[^0-9]/g, '')
                        if (flyout && !isNaN(Number(flyout)) && Number(flyout) > 0) return Number(flyout)
                        return null
                    }),
                    new Promise<null>((_, reject) => setTimeout(() => reject(new Error('EVAL_TIMEOUT')), 8000))
                ]).catch(() => null)

                if (inPageBalance && inPageBalance > Number(this.bot.userData.currentPoints ?? 0)) {
                    this.bot.userData.currentPoints = inPageBalance
                }

                // Verifikasi counter riil server (tanpa faking optimis lokal)
                const forceSync = (currentSearchCount % 4 === 0)
                const counters = await this.bot.browser.func.getSearchPoints(searchPage, forceSync, isMobile)
                this.bot.browser.func.cachedCounters = counters
                this.bot.logger.debug(
                    isMobile,
                    'SEARCH-BING',
                    `Search counters after query (Server verified) | count=${currentSearchCount} | query="${query}"`
                )
                return counters
            } catch (error) {
                if (i >= 5) {
                    this.bot.logger.error(
                        isMobile,
                        'SEARCH-BING',
                        `Failed after 5 retries | query="${query}" | message=${error instanceof Error ? error.message : String(error)}`
                    )
                    break
                }

                this.bot.logger.error(
                    isMobile,
                    'SEARCH-BING',
                    `Search attempt failed | attempt=${i + 1}/${maxAttempts} | query="${query}" | message=${error instanceof Error ? error.message : String(error)}`
                )

                this.bot.logger.warn(
                    isMobile,
                    'SEARCH-BING',
                    `Retrying search | attempt=${i + 1}/${maxAttempts} | query="${query}"`
                )

                await interruptibleWait(2000, signal)
            }
        }

        this.bot.logger.debug(
            isMobile,
            'SEARCH-BING',
            `Returning current search counters after failed retries | query="${query}"`
        )

        return await this.bot.browser.func.getSearchPoints(searchPage, false, isMobile)
    }

    private async randomScroll(page: Page, isMobile: boolean) {
        try {
            const viewportHeight = await Promise.race([
                page.evaluate(() => window.innerHeight),
                new Promise<number>((_, reject) => setTimeout(() => reject(new Error('EVAL_TIMEOUT')), 5000))
            ]).catch(() => 800)

            const totalHeight = await Promise.race([
                page.evaluate(() => document.body.scrollHeight),
                new Promise<number>((_, reject) => setTimeout(() => reject(new Error('EVAL_TIMEOUT')), 5000))
            ]).catch(() => 1200)

            const randomScrollPosition = Math.floor(Math.random() * (totalHeight - viewportHeight))

            this.bot.logger.debug(
                isMobile,
                'SEARCH-RANDOM-SCROLL',
                `Random scroll | viewportHeight=${viewportHeight} | totalHeight=${totalHeight} | scrollPos=${randomScrollPosition}`
            )

            await Promise.race([
                page.evaluate((scrollPos: number) => {
                    window.scrollTo({ left: 0, top: scrollPos, behavior: 'auto' })
                }, randomScrollPosition),
                new Promise<void>((_, reject) => setTimeout(() => reject(new Error('EVAL_TIMEOUT')), 5000))
            ]).catch(() => {})
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
        isMobile: boolean
    ): Promise<{ verifiedGained: boolean; newBalance?: number; gained?: number }> {
        const oldRecordedPoints = Number(this.bot.userData.currentPoints ?? 0)

        // 1. Verifikasi utama: DAPI real-time via getAppDashboardData (tersedia untuk desktop & mobile jika token aktif)
        if (this.bot.accessToken) {
            try {
                const appData = await this.bot.browser.func.getAppDashboardData()
                const serverBalance = appData?.response?.balance
                if (typeof serverBalance === 'number' && serverBalance > oldRecordedPoints) {
                    return {
                        verifiedGained: true,
                        newBalance: serverBalance,
                        gained: serverBalance - oldRecordedPoints
                    }
                }
            } catch {}
        }

        // 2. Verifikasi live DOM: Ekstraksi saldo dari elemen header bing (#id_rc atau #rh_meter)
        try {
            if (page && !page.isClosed()) {
                const inPagePoints = await page.evaluate(() => {
                    const rc = document.getElementById('id_rc')?.innerText?.replace(/[^0-9]/g, '')
                    if (rc && !isNaN(Number(rc)) && Number(rc) > 0) return Number(rc)
                    const rh = document.querySelector('#rh_meter .rh_meter_points, .id_rh_pts')?.textContent?.replace(/[^0-9]/g, '')
                    if (rh && !isNaN(Number(rh)) && Number(rh) > 0) return Number(rh)
                    return null
                }).catch(() => null)

                if (inPagePoints && inPagePoints > oldRecordedPoints) {
                    return {
                        verifiedGained: true,
                        newBalance: inPagePoints,
                        gained: inPagePoints - oldRecordedPoints
                    }
                }
            }
        } catch {}

        // 3. Fallback request context getuserinfo
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
                    if (typeof availablePoints === 'number' && availablePoints > oldRecordedPoints) {
                        return {
                            verifiedGained: true,
                            newBalance: availablePoints,
                            gained: availablePoints - oldRecordedPoints
                        }
                    }
                }
            }
        } catch {}

        return { verifiedGained: false }
    }
}
