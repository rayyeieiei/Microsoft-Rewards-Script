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

            this.topicalChainer.resetChain()

            // Go to bing
            this.bot.logger.debug(isMobile, 'SEARCH-BING', `Navigating to search page | url=${this.bingHome}`)

            await page.goto(this.bingHome, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
            await this.bot.browser.utils.tryDismissAllMessages(page)

            let stagnantLoop = 0
            const stagnantLoopMax = 10

            for (let i = 0; i < queries.length; i++) {
                const query = queries[i] as string
                searchCount++

                searchCounters = await this.bingSearch(page, query, isMobile, searchCount)
                const newMissingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
                const newMissingPointsTotal = newMissingPoints.totalPoints

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

                const curPointsBefore = Number(this.bot.userData.currentPoints ?? 0)
                const livePointsNow = await this.bot.browser.func.getCurrentPoints(page).catch(() => curPointsBefore)
                const liveDelta = livePointsNow > curPointsBefore ? (livePointsNow - curPointsBefore) : 0

                const counterDelta = missingPointsTotal - newMissingPointsTotal
                const standardPoints = 3
                const rawGained = liveDelta > 0 ? liveDelta : (counterDelta > 0 ? counterDelta : standardPoints)
                const gainedPoints = Math.min(rawGained, missingPointsTotal > 0 ? missingPointsTotal : standardPoints)

                stagnantLoop = 0
                void Database.getInstance().recordActivity(
                    currentEmail,
                    isMobile ? 'SEARCH_MOBILE' : 'SEARCH_DESKTOP',
                    gainedPoints
                )

                this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                totalGainedPoints += gainedPoints
                missingPointsTotal = Math.max(0, missingPointsTotal - gainedPoints)

                this.bot.logger.info(
                    isMobile,
                    'SEARCH-BING',
                    `gainedPoints=${gainedPoints} points | query="${query}" | remaining=${missingPointsTotal}`,
                    'green'
                )

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

                if (stagnantLoop > stagnantLoopMax) {
                    this.bot.logger.warn(
                        isMobile,
                        'SEARCH-BING',
                        `Search did not gain points for ${stagnantLoopMax} iterations, aborting search loop`
                    )
                    stagnantLoop = 0
                    break
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

            if (missingPointsTotal > 0) {
                this.bot.logger.info(
                    isMobile,
                    'SEARCH-BING',
                    `Search completed but still missing points, continuing with regenerated queries | remaining=${missingPointsTotal}`
                )

                let stagnantLoop = 0
                const stagnantLoopMax = 5

                while (missingPointsTotal > 0) {
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
                        this.bot.logger.info(
                            isMobile,
                            'SEARCH-BING-EXTRA',
                            `Extra search (${isMobile ? 'Mobile' : 'Desktop'}) | remaining=${missingPointsTotal} | query="${query}"`
                        )

                        searchCount++
                        searchCounters = await this.bingSearch(page, query, isMobile, searchCount)
                        const newMissingPoints = this.bot.browser.func.missingSearchPoints(searchCounters, isMobile)
                        const newMissingPointsTotal = newMissingPoints.totalPoints

                        const curPointsBefore = Number(this.bot.userData.currentPoints ?? 0)
                        const livePointsNow = await this.bot.browser.func.getCurrentPoints(page).catch(() => curPointsBefore)
                        const liveDelta = livePointsNow > curPointsBefore ? (livePointsNow - curPointsBefore) : 0

                        const counterDelta = missingPointsTotal - newMissingPointsTotal
                        const rawGained = counterDelta > 0 ? counterDelta : liveDelta
                        const gainedPoints = Math.max(0, rawGained)

                        if (gainedPoints === 0) {
                            stagnantLoop++
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `No points gained ${stagnantLoop}/${stagnantLoopMax} | query="${query}" | remaining=${newMissingPointsTotal}`
                            )
                        } else {
                            stagnantLoop = 0

                            this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                            totalGainedPoints += gainedPoints

                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `gainedPoints=${gainedPoints} points | query="${query}" | remaining=${newMissingPointsTotal}`,
                                'green'
                            )
                        }

                        missingPointsTotal = Math.max(0, counterDelta > 0 ? newMissingPointsTotal : (missingPointsTotal - gainedPoints))

                        if (missingPointsTotal === 0) {
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                'All required search points earned during extra searches'
                            )
                            break
                        }

                        if (stagnantLoop > stagnantLoopMax) {
                            this.bot.logger.warn(
                                isMobile,
                                'SEARCH-BING-EXTRA',
                                `Search did not gain points for ${stagnantLoopMax} iterations, aborting extra searches`
                            )
                            const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)
                            this.bot.logger.info(
                                isMobile,
                                'SEARCH-BING',
                                `Aborted extra searches | startBalance=${startBalance} | finalBalance=${finalBalance}`
                            )
                            return totalGainedPoints
                        }
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

    private async bingSearch(searchPage: Page, query: string, isMobile: boolean, currentSearchCount: number) {
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
            const url = `${this.bingHome}/search?q=${encodeURIComponent(query)}&PC=U531&FORM=ANNTA1&cvid=${cvid}`

            await searchPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {})
            await this.bot.browser.utils.tryDismissAllMessages(searchPage)
        }

        this.bot.logger.debug(
            isMobile,
            'SEARCH-BING',
            `Starting bingSearch | query="${query}" | maxAttempts=${maxAttempts} | searchCount=${currentSearchCount} | refreshEvery=${refreshThreshold} | scrollRandomResults=${this.bot.config.searchSettings.scrollRandomResults} | clickRandomResults=${this.bot.config.searchSettings.clickRandomResults}`
        )

        for (let i = 0; i < maxAttempts; i++) {
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
                    await searchPage.keyboard.type(query, { delay: 35 })
                    await searchPage.keyboard.press('Enter')
                } else {
                    // Resilient Fallback: Navigasi langsung ke URL pencarian (100% andal, mengatasi widget olahraga/hasil dinamis)
                    const cvid = randomBytes(16).toString('hex')
                    const searchUrl = `${this.bingHome}/search?q=${encodeURIComponent(query)}&PC=U531&FORM=ANNTA1&cvid=${cvid}`
                    await searchPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})
                }

                this.bot.logger.debug(
                    isMobile,
                    'SEARCH-BING',
                    `Submitted query to Bing | attempt=${i + 1}/${maxAttempts} | query="${query}"`
                )

                await this.bot.utils.wait(2000)

                if (this.bot.config.searchSettings.organicSearch?.enabled) {
                    await this.organicEngine.simulateOrganicCTR(searchPage, isMobile)
                } else {
                    if (this.bot.config.searchSettings.scrollRandomResults) {
                        await this.bot.utils.wait(2000)
                        await this.randomScroll(searchPage, isMobile)
                    }

                    if (this.bot.config.searchSettings.clickRandomResults) {
                        await this.bot.utils.wait(2000)
                        await this.clickRandomLink(searchPage, isMobile)
                    }
                }

                await this.bot.utils.wait(
                    this.bot.utils.randomDelay(
                        this.bot.config.searchSettings.searchDelay.min,
                        this.bot.config.searchSettings.searchDelay.max
                    )
                )

                const counters = await this.bot.browser.func.getSearchPoints(searchPage)

                this.bot.logger.debug(
                    isMobile,
                    'SEARCH-BING',
                    `Search counters after query | attempt=${i + 1}/${maxAttempts} | query="${query}"`
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

                await this.bot.utils.wait(2000)
            }
        }

        this.bot.logger.debug(
            isMobile,
            'SEARCH-BING',
            `Returning current search counters after failed retries | query="${query}"`
        )

        return await this.bot.browser.func.getSearchPoints(searchPage)
    }

    private async randomScroll(page: Page, isMobile: boolean) {
        try {
            const viewportHeight = await page.evaluate(() => window.innerHeight)
            const totalHeight = await page.evaluate(() => document.body.scrollHeight)
            const randomScrollPosition = Math.floor(Math.random() * (totalHeight - viewportHeight))

            this.bot.logger.debug(
                isMobile,
                'SEARCH-RANDOM-SCROLL',
                `Random scroll | viewportHeight=${viewportHeight} | totalHeight=${totalHeight} | scrollPos=${randomScrollPosition}`
            )

            await page.evaluate((scrollPos: number) => {
                window.scrollTo({ left: 0, top: scrollPos, behavior: 'auto' })
            }, randomScrollPosition)
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
}
