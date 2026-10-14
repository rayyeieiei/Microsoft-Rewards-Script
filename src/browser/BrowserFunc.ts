import type { BrowserContext, Cookie, Page } from 'patchright'
import type { AxiosRequestConfig } from 'axios'

import type { MicrosoftRewardsBot } from '../index'
import { saveSessionData } from '../util/Load'
import { AccountSessionStore } from '../runtime/session/AccountSessionStore'

import type { Counters, DashboardData } from './../interface/DashboardData'
import type { AppUserData } from '../interface/AppUserData'
import type { XboxDashboardData } from '../interface/XboxDashboardData'
import type { AppEarnablePoints, BrowserEarnablePoints, MissingSearchPoints } from '../interface/Points'
import type { AppDashboardData } from '../interface/AppDashBoardData'

export default class BrowserFunc {
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    public lockInitialPoints(availablePoints?: number): void {
        if (
            this.bot?.abortController?.signal?.aborted ||
            this.bot?.accountScope?.abortController?.signal?.aborted
        ) {
            return
        }
        const pts = Number(availablePoints ?? 0)
        if (!isNaN(pts) && pts > 0 && this.bot?.userData) {
            if (
                !this.bot.userData.initialPoints ||
                this.bot.userData.initialPoints <= 0 ||
                (this.bot.userData.initialPoints < 50 && pts > 100)
            ) {
                this.bot.userData.initialPoints = pts
            }
            // JANGAN TIMPA jika initialPoints sudah bernilai valid dari fase awal!
            if (
                !this.bot.userData.currentPoints ||
                this.bot.userData.currentPoints <= 0 ||
                (this.bot.userData.currentPoints < 50 && pts > 100)
            ) {
                this.bot.userData.currentPoints = pts
            }
        }
    }

    /**
     * Fetch user desktop dashboard data
     * @returns {DashboardData} Object of user bing rewards dashboard data
     */
    async getDashboardData(): Promise<DashboardData> {
        const maxAttempts = 2
        const hardCapMs = 28000
        const startMs = Date.now()
        const isExpired = () => Date.now() - startMs >= hardCapMs

        const createFallbackSnapshot = (): DashboardData => ({
            userStatus: {
                availablePoints: Number(this.bot.userData?.currentPoints ?? this.bot.userData?.initialPoints ?? 0),
                counters: {
                    pcSearch: [{ pointProgress: 0, pointProgressMax: 90 }],
                    mobileSearch: [{ pointProgress: 0, pointProgressMax: 60 }]
                }
            },
            dailySetPromotions: {
                [new Date().toISOString().split('T')[0] as string]: []
            },
            morePromotions: [],
            promotionalItems: [],
            punchCards: []
        } as unknown as DashboardData)

        const executeFetch = async (): Promise<DashboardData> => {
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                if (isExpired()) break

                const activePage = this.bot.mainMobilePage || this.bot.mainDesktopPage
                let liveCookies: Cookie[] = []
                if (activePage && !activePage.isClosed()) {
                    liveCookies = await Promise.race([
                        activePage.context().cookies().catch(() => []),
                        new Promise<Cookie[]>(resolve => setTimeout(() => resolve([]), 3000))
                    ])
                }
                const activeCookies =
                    liveCookies.length > 0
                        ? liveCookies
                        : (this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop) || []

                // 1. Coba via In-Page Fetch Playwright JIKA halaman sedang berada di rewards.bing.com (Prioritas utama)
                if (activePage && !activePage.isClosed() && activePage.url().includes('rewards.bing.com')) {
                    try {
                        // Tunggu hidrasi DOM singkat jika bukan di sub-halaman envelope
                        if (!activePage.url().includes('/dashboard/envelope')) {
                            await activePage
                                .waitForSelector('section#dailyset, [data-bi-area*="DailySet"], .c-card, [class*="card"]', {
                                    timeout: 2000
                                })
                                .catch(() => {})
                        }

                        const inPageData = await Promise.race([
                            activePage
                                .evaluate(async () => {
                                    const winDash = (window as any).dashboard || null
                                    const fetchWithTimeout = async (url: string, timeoutMs: number) => {
                                        const controller = new AbortController()
                                        const timer = setTimeout(() => controller.abort(), timeoutMs)
                                        try {
                                            return await fetch(url, {
                                                credentials: 'include',
                                                signal: controller.signal
                                            })
                                        } finally {
                                            clearTimeout(timer)
                                        }
                                    }
                                    try {
                                        const res = await fetchWithTimeout('/api/getuserinfo?type=1', 8000)
                                        if (res && res.ok) {
                                            const json = await res.json()
                                            if (json?.dashboard?.userStatus) {
                                                return json.dashboard
                                            }
                                        }
                                        return winDash
                                    } catch {
                                        return winDash
                                    }
                                })
                                .catch(() => null),
                            new Promise<null>(resolve => setTimeout(() => resolve(null), 9500))
                        ])

                        const hasAppOnlyInPage = (inPageData?.morePromotions || []).some(
                            (p: any) =>
                                (p.title || '').toLowerCase().includes('rewards app only') ||
                                (p.offerId || '').toLowerCase().includes('rewardsapp_offer')
                        )

                        if (
                            inPageData &&
                            inPageData.userStatus &&
                            (inPageData.dailySetPromotions ||
                                inPageData.morePromotions ||
                                inPageData.punchCards ||
                                hasAppOnlyInPage)
                        ) {
                            this.lockInitialPoints(inPageData.userStatus.availablePoints)
                            return inPageData as DashboardData
                        }

                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'GET-DASHBOARD-DATA',
                            `[GET-DASHBOARD-DATA] In-page fetch returned incomplete/null data on attempt ${attempt}/${maxAttempts}; falling back to Axios.`
                        )
                    } catch (err) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'GET-DASHBOARD-DATA',
                            `[GET-DASHBOARD-DATA] In-page fetch error on attempt ${attempt}/${maxAttempts}: ${err instanceof Error ? err.message : String(err)}`
                        )
                    }
                }

                if (isExpired()) break

                // 2. Coba via Axios API request dengan Desktop User-Agent agar tidak ter-strip oleh backend Microsoft
                const apiEndpoints = [
                    'https://rewards.bing.com/api/getuserinfo?type=1',
                    'https://rewards.bing.com/api/getuserinfo'
                ]

                for (const endpoint of apiEndpoints) {
                    if (isExpired()) break
                    try {
                        const request: AxiosRequestConfig = {
                            url: endpoint,
                            method: 'GET',
                            timeout: 10000,
                            ...({ 'axios-retry': { retries: 0 } } as any),
                            headers: {
                                ...(this.bot.fingerprint?.headers ?? {}),
                                'User-Agent':
                                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
                                'sec-ch-ua-mobile': '?0',
                                'sec-ch-ua-platform': '"Windows"',
                                Cookie: this.buildCookieHeader(activeCookies, [
                                    'bing.com',
                                    'live.com',
                                    'microsoftonline.com'
                                ]),
                                Referer: 'https://rewards.bing.com/',
                                Origin: 'https://rewards.bing.com'
                            }
                        }

                        const response = await this.bot.axios.request(request)

                        if (response.data?.dashboard && response.data.dashboard.userStatus) {
                            this.lockInitialPoints(response.data.dashboard.userStatus.availablePoints)
                            return response.data.dashboard as DashboardData
                        }
                    } catch (error) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'GET-DASHBOARD-DATA',
                            `[GET-DASHBOARD-DATA] Direct API fallback (${endpoint}) failed on attempt ${attempt}/${maxAttempts}: ${error instanceof Error ? error.message : String(error)}`
                        )
                    }
                }

                if (isExpired()) break

                // 3. Coba parsing script tag dari HTML dashboard
                try {
                    const request: AxiosRequestConfig = {
                        url: this.bot.config.baseURL,
                        method: 'GET',
                        timeout: 10000,
                        ...({ 'axios-retry': { retries: 0 } } as any),
                        headers: {
                            ...(this.bot.fingerprint?.headers ?? {}),
                            Cookie: this.buildCookieHeader(activeCookies),
                            Referer: 'https://rewards.bing.com/',
                            Origin: 'https://rewards.bing.com'
                        }
                    }

                    const response = await this.bot.axios.request(request)
                    const match =
                        typeof response.data === 'string'
                            ? response.data.match(/var\s+dashboard\s*=\s*({.*?});/s)
                            : null

                    if (match?.[1]) {
                        const parsed = JSON.parse(match[1]) as DashboardData
                        if (parsed?.userStatus) {
                            this.lockInitialPoints(parsed.userStatus.availablePoints)
                            return parsed
                        }
                    }
                } catch (err) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'GET-DASHBOARD-DATA',
                        `[GET-DASHBOARD-DATA] HTML script fallback failed on attempt ${attempt}/${maxAttempts}: ${err instanceof Error ? err.message : String(err)}`
                    )
                }

                if (isExpired()) break

                // 4. Fallback Terakhir: Adaptasi dari Mobile App API (dengan pemetaan promosi lengkap)
                if (this.bot.accessToken) {
                    try {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'GET-DASHBOARD-DATA',
                            `[GET-DASHBOARD-DATA] Attempting DAPI mobile fallback on attempt ${attempt}/${maxAttempts}...`
                        )
                        const appData = await this.getAppDashboardData()
                        const mapped = this.mapAppDashboardToBrowserDashboard(appData)
                        if (mapped) {
                            return mapped
                        }
                    } catch (err) {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'GET-DASHBOARD-DATA',
                            `[GET-DASHBOARD-DATA] DAPI fallback failed on attempt ${attempt}/${maxAttempts}: ${err instanceof Error ? err.message : String(err)}`
                        )
                    }
                }

                if (attempt < maxAttempts && !isExpired()) {
                    await this.bot.utils.wait(1000)
                }
            }

            // Fallback aman: jika semua endpoint web gagal, kembalikan DAPI atau snapshot dasar tanpa throw fatal
            if (this.bot.accessToken) {
                try {
                    const appData = await this.getAppDashboardData().catch(() => null)
                    const mapped = this.mapAppDashboardToBrowserDashboard(appData)
                    if (mapped) return mapped
                } catch {}
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-DASHBOARD-DATA',
                '[GET-DASHBOARD-DATA] All endpoints exhausted; returning safe minimal dashboard snapshot.'
            )
            return createFallbackSnapshot()
        }

        let hardCapTimer: ReturnType<typeof setTimeout> | undefined
        try {
            return await Promise.race([
                executeFetch(),
                new Promise<DashboardData>(resolve => {
                    hardCapTimer = setTimeout(async () => {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'GET-DASHBOARD-DATA',
                            `[GET-DASHBOARD-DATA] Hard-cap timeout (${hardCapMs}ms) reached; recovering with DAPI / fallback dashboard snapshot.`
                        )
                        if (this.bot.accessToken) {
                            try {
                                const appData = await this.getAppDashboardData().catch(() => null)
                                const mapped = this.mapAppDashboardToBrowserDashboard(appData)
                                if (mapped) return resolve(mapped)
                            } catch {}
                        }
                        resolve(createFallbackSnapshot())
                    }, hardCapMs)
                })
            ])
        } finally {
            if (hardCapTimer) clearTimeout(hardCapTimer)
        }
    }

    public mapAppDashboardToBrowserDashboard(appData?: AppDashboardData | null): DashboardData | null {
        if (!appData?.response) return null
        const balance = appData.response.balance ?? 0
        this.lockInitialPoints(balance)
        const rawPromos = appData.response.promotions ?? []

        const dailySetItems: any[] = []
        const morePromos: any[] = []

        for (const p of rawPromos) {
            const attrs = p.attributes || {}
            const offerId = (attrs.offerid || p.name || '').toLowerCase()
            const title = attrs.title || p.name || ''
            const rawPointMax = attrs.pointmax || attrs.points
            const rawPointProgress = attrs.pointprogress

            const isInternalInfo =
                offerId.endsWith('_info') ||
                offerId.includes('user_') ||
                offerId.includes('redeem_') ||
                offerId.includes('level_') ||
                offerId.includes('streak') ||
                offerId.includes('checkin') ||
                offerId.includes('readarticle') ||
                offerId.includes('appinstall') ||
                offerId.includes('appmigration') ||
                offerId.includes('trialuser') ||
                offerId.includes('activation') ||
                offerId.includes('exempt')

            if (isInternalInfo || !rawPointMax) {
                continue
            }

            const pointProgress = parseInt(rawPointProgress || '0', 10)
            const pointProgressMax = parseInt(rawPointMax, 10)
            if (isNaN(pointProgressMax) || pointProgressMax <= 0) continue

            const complete =
                attrs.complete === 'True' ||
                attrs.complete === 'true' ||
                pointProgress >= pointProgressMax
            const destinationUrl =
                attrs.destination_url || attrs.url || 'https://rewards.bing.com'
            const promotionType = attrs.type || 'urlreward'

            const promoObj = {
                title,
                destinationUrl,
                pointProgressMax,
                pointProgress,
                complete,
                offerId: attrs.offerid || p.name,
                promotionType
            }

            if (
                offerId.includes('dailyset') ||
                offerId.includes('daily_set') ||
                offerId.includes('child_offer')
            ) {
                dailySetItems.push(promoObj)
            } else {
                morePromos.push(promoObj)
            }
        }

        if (dailySetItems.length > 0 || morePromos.length > 0 || balance > 0) {
            return {
                userStatus: {
                    availablePoints: balance,
                    counters: {
                        pcSearch: [{ pointProgress: 0, pointProgressMax: 90 }],
                        mobileSearch: [{ pointProgress: 0, pointProgressMax: 60 }]
                    }
                },
                dailySetPromotions: {
                    [new Date().toISOString().split('T')[0] as string]: dailySetItems
                },
                morePromotions: morePromos,
                promotionalItems: [],
                punchCards: []
            } as unknown as DashboardData
        }
        return null
    }

    /**
     * Fetch user app dashboard data
     * @returns {AppDashboardData} Object of user bing rewards dashboard data
     */
    async getAppDashboardData(): Promise<AppDashboardData> {
        try {
            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAIOS&options=613',
                method: 'GET',
                timeout: 6000,
                ...({ 'axios-retry': { retries: 1 } } as any),
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'User-Agent':
                        'Bing/32.5.431027001 (com.microsoft.bing; build:431027001; iOS 17.6.1) Alamofire/5.10.2'
                },
                validateStatus: (status) => status < 500
            }

            let response = await this.bot.axios.request(request)
            if (response.status === 401) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'DAPI-AUTH',
                    '⚠️ [DAPI-AUTH] Token kedaluwarsa (401) saat getAppDashboardData. Mencoba refresh token seluler 1x...'
                )
                const refreshed = await this.bot.refreshMobileAccessToken()
                if (refreshed) {
                    request.headers = {
                        ...request.headers,
                        Authorization: `Bearer ${refreshed}`
                    }
                    response = await this.bot.axios.request(request)
                }
            }

            if (response.status !== 200) {
                throw new Error(`DAPI dashboard returned status ${response.status}`)
            }

            const appData = response.data as AppDashboardData
            this.lockInitialPoints(appData?.response?.balance)
            return appData
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'GET-APP-DASHBOARD-DATA',
                `Non-fatal error fetching dashboard data: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    /**
     * Fetch user xbox dashboard data
     * @returns {XboxDashboardData} Object of user bing rewards dashboard data
     */
    async getXBoxDashboardData(): Promise<XboxDashboardData> {
        try {
            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=xboxapp&options=6',
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Xbox; Xbox One X) AppleWebKit/537.36 (KHTML, like Gecko) Edge/18.19041'
                }
            }

            const response = await this.bot.axios.request(request)
            return response.data as XboxDashboardData
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-XBOX-DASHBOARD-DATA',
                `Error fetching dashboard data: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    private cachedCounters: Counters | null = null
    private syncCounter: number = 0

    public resetCounters(): void {
        this.cachedCounters = null
        this.syncCounter = 0
    }

    /**
     * Get search point counters
     * @param {Page} [page] Optional active page to extract fast in-page counters from
     * @param {boolean} [forceNetwork] Force network sync with dashboard API
     * @param {boolean} [isMobile] Current search mode for optimistic counter progression
     */
    async getSearchPoints(page?: Page, forceNetwork: boolean = false, isMobile?: boolean): Promise<Counters> {
        // 1. Fast in-page evaluation if on rewards.bing.com
        if (page && !page.isClosed() && page.url().includes('rewards.bing.com')) {
            const inPageCounters = await page.evaluate(() => {
                const dash = (window as any).dashboard
                if (dash?.userStatus?.counters) return dash.userStatus.counters
                return null
            }).catch(() => null)

            if (inPageCounters) {
                this.cachedCounters = inPageCounters
                this.syncCounter = 0
                return inPageCounters
            }
        }

        // 2. Fast in-page evaluation on Bing SERP (reads in-page rewards data or header counter)
        if (page && !page.isClosed() && page.url().includes('bing.com')) {
            const inPageData = await page.evaluate(() => {
                const dash = (window as any).dashboard || (window as any).rewardsUser
                if (dash?.userStatus?.counters) return { counters: dash.userStatus.counters }

                // Check Bing rewards header counter in DOM (#id_rc, .points-container, #rh_meter, etc.)
                const selectors = [
                    '#id_rc',
                    '.points-container',
                    '#rh_meter',
                    '#b_id_rc',
                    'a#id_rh span',
                    '.rh_count',
                    '[data-tag="rewards-counter"]'
                ]
                for (const sel of selectors) {
                    const el = document.querySelector(sel)
                    if (el) {
                        const txt = (el.textContent || '').trim().replace(/,/g, '')
                        const m = txt.match(/\d+/)
                        if (m) {
                            const pts = parseInt(m[0], 10)
                            if (!isNaN(pts) && pts > 0) {
                                return { domPoints: pts }
                            }
                        }
                    }
                }
                return null
            }).catch(() => null)

            if (inPageData?.counters) {
                this.cachedCounters = inPageData.counters
                this.syncCounter = 0
                return inPageData.counters
            }

            if (inPageData?.domPoints && this.cachedCounters) {
                const newBalance = inPageData.domPoints
                const oldBalance = Number(this.bot.userData.currentPoints ?? 0)
                if (newBalance > oldBalance) {
                    const gained = newBalance - oldBalance
                    const targetList = isMobile ? this.cachedCounters.mobileSearch : this.cachedCounters.pcSearch
                    if (targetList && targetList[0]) {
                        targetList[0].pointProgress = Math.min(
                            targetList[0].pointProgressMax,
                            (targetList[0].pointProgress || 0) + gained
                        )
                    }
                    this.bot.userData.currentPoints = newBalance
                }
                return this.cachedCounters
            }
        }

        // 3. Responsive Optimistic Delta Counter:
        // Avoid heavy cascading HTTP fallback (getDashboardData) on every single query
        this.syncCounter++
        if (!forceNetwork && this.cachedCounters && this.syncCounter < 4) {
            if (typeof isMobile === 'boolean') {
                const targetList = isMobile ? this.cachedCounters.mobileSearch : this.cachedCounters.pcSearch
                if (targetList && targetList.length > 0 && targetList[0]) {
                    const currentProgress = targetList[0].pointProgress || 0
                    const maxProgress = targetList[0].pointProgressMax || 0
                    if (currentProgress < maxProgress) {
                        targetList[0].pointProgress = Math.min(maxProgress, currentProgress + 3)
                    }
                }
            }
            return this.cachedCounters
        }

        // 4. CRITICAL GUARD FOR DESKTOP SEARCH:
        // Never call getDashboardData() (which attempts Axios /api/getuserinfo and mobile DAPI)
        // during Desktop search (isMobile === false) or while active page is on bing.com!
        if (isMobile === false || (page && !page.isClosed() && page.url().includes('bing.com'))) {
            if (this.cachedCounters) {
                const targetList = isMobile ? this.cachedCounters.mobileSearch : this.cachedCounters.pcSearch
                if (targetList && targetList[0]) {
                    const currentProgress = targetList[0].pointProgress || 0
                    const maxProgress = targetList[0].pointProgressMax || (isMobile ? 60 : 90)
                    if (currentProgress < maxProgress) {
                        targetList[0].pointProgress = Math.min(maxProgress, currentProgress + 3)
                    }
                }
                return this.cachedCounters
            }

            const fallbackCounters = {
                pcSearch: [{ pointProgress: 3, pointProgressMax: 90 }],
                mobileSearch: []
            } as unknown as Counters
            this.cachedCounters = fallbackCounters
            return fallbackCounters
        }

        // 5. Periodic or forced network sync via getDashboardData (Mobile on rewards.bing.com only)
        try {
            const dashboardData = await this.getDashboardData()
            const counters = dashboardData?.userStatus?.counters
            if (counters && (counters.pcSearch?.length || counters.mobileSearch?.length)) {
                const pcMax = counters.pcSearch?.[0]?.pointProgressMax ?? 0
                if (pcMax === 0 && (!counters.mobileSearch || counters.mobileSearch.length === 0)) {
                    // Level 1 or uninitialized counters: enforce sensible lower-bound quota of 30 PC points
                    const prevProg = this.cachedCounters?.pcSearch?.[0]?.pointProgress ?? 0
                    counters.pcSearch = [{ pointProgress: Math.min(30, prevProg), pointProgressMax: 30 }] as any
                }
                this.cachedCounters = counters
                this.syncCounter = 0
                return counters
            }
            const dailySearchPts = Number(dashboardData?.userStatus?.levelInfo?.bingSearchDailyPoints || 0)
            if (dailySearchPts > 0) {
                const prevProg = this.cachedCounters?.pcSearch?.[0]?.pointProgress ?? 0
                const fallbackCounters = {
                    pcSearch: [{ pointProgress: Math.min(dailySearchPts, prevProg), pointProgressMax: dailySearchPts }],
                    mobileSearch: []
                } as unknown as Counters
                this.cachedCounters = fallbackCounters
                this.syncCounter = 0
                return fallbackCounters
            }
            const prevProg = this.cachedCounters?.pcSearch?.[0]?.pointProgress ?? 0
            const defaultLevel1Counters = {
                pcSearch: [{ pointProgress: Math.min(30, prevProg), pointProgressMax: 30 }],
                mobileSearch: []
            } as unknown as Counters
            this.cachedCounters = defaultLevel1Counters
            this.syncCounter = 0
            return defaultLevel1Counters
        } catch {
            return this.cachedCounters || ({
                pcSearch: [{ pointProgress: 0, pointProgressMax: 30 }],
                mobileSearch: []
            } as unknown as Counters)
        }
    }

    missingSearchPoints(counters: Counters, isMobile?: boolean): MissingSearchPoints {
        const mobileData = counters.mobileSearch?.[0]
        const desktopData = counters.pcSearch?.[0]
        const edgeData = counters.pcSearch?.[1]

        const mobilePoints = mobileData ? Math.max(0, mobileData.pointProgressMax - mobileData.pointProgress) : 0
        const pcPoints = desktopData ? Math.max(0, desktopData.pointProgressMax - desktopData.pointProgress) : 0
        const edgePoints = edgeData ? Math.max(0, edgeData.pointProgressMax - edgeData.pointProgress) : 0
        const desktopPoints = pcPoints + edgePoints

        const totalPoints = typeof isMobile === 'boolean'
            ? (isMobile ? mobilePoints : desktopPoints)
            : (mobilePoints + desktopPoints)

        return { mobilePoints, desktopPoints, edgePoints, totalPoints }
    }

    /**
     * Get total earnable points with web browser
     */
    async getBrowserEarnablePoints(preloadedData?: DashboardData): Promise<BrowserEarnablePoints> {
        try {
            const data = preloadedData ?? (await this.getDashboardData())

            const desktopSearchPoints =
                data.userStatus.counters.pcSearch?.reduce(
                    (sum, x) => sum + Math.max(0, x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const mobileSearchPoints =
                data.userStatus.counters.mobileSearch?.reduce(
                    (sum, x) => sum + Math.max(0, x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const todayDate = this.bot.utils.getFormattedDate()
            const dailySetPoints =
                data.dailySetPromotions[todayDate]?.reduce(
                    (sum, x) => sum + (x.pointProgressMax - x.pointProgress),
                    0
                ) ?? 0

            const morePromotionsPoints =
                data.morePromotions?.reduce((sum, x) => {
                    if (
                        ['quiz', 'urlreward'].includes(x.promotionType) &&
                        x.exclusiveLockedFeatureStatus !== 'locked'
                    ) {
                        return sum + (x.pointProgressMax - x.pointProgress)
                    }
                    return sum
                }, 0) ?? 0

            const totalEarnablePoints = desktopSearchPoints + mobileSearchPoints + dailySetPoints + morePromotionsPoints

            return {
                dailySetPoints,
                morePromotionsPoints,
                desktopSearchPoints,
                mobileSearchPoints,
                totalEarnablePoints
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-BROWSER-EARNABLE-POINTS',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }

    /**
     * Get total earnable points with mobile app
     */
    async getAppEarnablePoints(): Promise<AppEarnablePoints> {
        try {
            const eligibleOffers = ['ENUS_readarticle3_30points', 'Gamification_Sapphire_DailyCheckIn']
            const accountGeo = (this.bot.activeAccount?.geoLocale || '').trim()
            const userGeo = (this.bot.userData?.geoLocale || '').trim()
            const country = (
                accountGeo && accountGeo.toLowerCase() !== 'auto'
                    ? accountGeo
                    : userGeo && userGeo.toLowerCase() !== 'auto' && userGeo.toUpperCase() !== 'US'
                      ? userGeo
                      : 'ID'
            ).toUpperCase()

            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'X-Rewards-Country': country,
                    'X-Rewards-Language': 'en',
                    'X-Rewards-ismobile': 'true'
                }
            }

            const response = await this.bot.axios.request(request)
            const userData: AppUserData = response.data
            const appBalance = Number(userData?.response?.balance ?? 0)
            this.lockInitialPoints(appBalance)
            if (!isNaN(appBalance) && appBalance > 0 && this.bot?.userData) {
                this.bot.userData.currentPoints = Math.max(this.bot.userData.currentPoints ?? 0, appBalance)
            }
            const promotions = userData?.response?.promotions || []
            const eligibleActivities = promotions.filter(
                x =>
                    eligibleOffers.includes(x?.attributes?.offerid ?? '') ||
                    x?.attributes?.type === 'msnreadearn' ||
                    x?.attributes?.type === 'checkin'
            )

            // Jika objek aktivitas tidak ditemukan (undefined/null), set currentProgress = 0 & maxProgress = 30 (readToEarn = 30)
            let readToEarn = 30
            let readToEarnProgress = 0
            let readToEarnMax = 30
            let readToEarnCompleted = false
            let readToEarnActivity: any = undefined
            let checkIn = 0

            for (const item of eligibleActivities) {
                const attrs = item.attributes

                if (attrs.type === 'msnreadearn' || attrs.offerid === 'ENUS_readarticle3_30points') {
                    readToEarnActivity = item
                    const rawMax = parseInt(attrs.pointmax ?? (attrs as any).max ?? '30', 10)
                    const pointMax = !isNaN(rawMax) && rawMax > 0 ? rawMax : 30
                    const rawProgress = parseInt(attrs.pointprogress ?? (attrs as any).progress ?? '0', 10)
                    const pointProgress = !isNaN(rawProgress) && rawProgress >= 0 ? rawProgress : 0

                    readToEarnMax = pointMax
                    readToEarnProgress = pointProgress
                    readToEarn = Math.max(0, pointMax - pointProgress)
                    readToEarnCompleted = pointMax > 0 && pointProgress >= pointMax
                } else if (attrs.type === 'checkin' || attrs.offerid === 'Gamification_Sapphire_DailyCheckIn') {
                    const progress = parseInt(attrs.progress ?? '0')
                    const checkInDay = (progress % 7) + 1 // Hari ke-1 s/d Hari ke-7
                    const nextDayKey = `day_${checkInDay}_points`
                    const possiblePoints = parseInt(attrs[nextDayKey] ?? '10') || 10

                    // Periksa apakah sudah check-in hari ini berdasarkan UTC dan waktu lokal
                    const lastUpdated = attrs.last_updated ? new Date(attrs.last_updated) : null
                    const now = new Date()
                    const isClaimedToday = lastUpdated && (
                        (lastUpdated.getUTCFullYear() === now.getUTCFullYear() &&
                         lastUpdated.getUTCMonth() === now.getUTCMonth() &&
                         lastUpdated.getUTCDate() === now.getUTCDate()) ||
                        (lastUpdated.getFullYear() === now.getFullYear() &&
                         lastUpdated.getMonth() === now.getMonth() &&
                         lastUpdated.getDate() === now.getDate())
                    )

                    if (!isClaimedToday) {
                        checkIn = possiblePoints
                    }
                }
            }

            const totalEarnablePoints = readToEarn + checkIn

            return {
                readToEarn,
                checkIn,
                totalEarnablePoints,
                readToEarnProgress,
                readToEarnMax,
                readToEarnCompleted,
                readToEarnActivity
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-APP-EARNABLE-POINTS',
                `An error occurred: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
    /**
     * Get current point amount
     * @param {Page} [page] Optional active page to extract points from
     * @returns {number} Current total point amount
     */
    async getCurrentPoints(page?: Page): Promise<number> {
        try {
            const activePage = page || this.bot.mainMobilePage || this.bot.mainDesktopPage
            if (activePage && !activePage.isClosed()) {
                let requestContextRejected = false
                // 1. Direct Request Context (fastest, no DOM/eval stall risk, shares context cookies)
                try {
                    const ctx = activePage.context()
                    if (ctx && ctx.request) {
                        const res = await ctx.request.get('https://rewards.bing.com/api/getuserinfo?type=1', {
                            timeout: 2500,
                            failOnStatusCode: false
                        })
                        if (res && typeof res.ok === 'function' && res.ok()) {
                            const data = await res.json().catch(() => null)
                            const pts = data?.dashboard?.userStatus?.availablePoints
                            if (typeof pts === 'number' && pts > 0) {
                                this.lockInitialPoints(pts)
                                this.bot.userData.currentPoints = pts
                                return pts
                            }
                        } else if (res && typeof res.status === 'function' && res.status() >= 400) {
                            requestContextRejected = true
                        }
                    }
                } catch {
                    // Fallback to in-page evaluate if request context fails
                }

                // 2. Fallback: in-page fetch dengan AbortController & Node-level timeout (3500ms) jika request context belum menolak 400
                if (!requestContextRejected) {
                    const apiPoints = await Promise.race([
                        activePage.evaluate(async () => {
                            let timeoutId: any
                            try {
                                const controller = new AbortController()
                                timeoutId = setTimeout(() => controller.abort(), 2500)
                                const url = window.location.href.toLowerCase()
                                if (url.includes('rewards.bing.com') || url.includes('bing.com')) {
                                    const res = await fetch('https://rewards.bing.com/api/getuserinfo?type=1', {
                                        credentials: 'include',
                                        signal: controller.signal
                                    })
                                    if (res.ok) {
                                        const data = await res.json()
                                        const pts = data?.dashboard?.userStatus?.availablePoints
                                        if (typeof pts === 'number' && pts > 0) return pts
                                    }
                                }
                            } catch {} finally {
                                if (timeoutId) clearTimeout(timeoutId)
                            }
                            return null
                        }),
                        new Promise<null>(resolve => setTimeout(() => resolve(null), 3500))
                    ]).catch(() => null)

                    if (typeof apiPoints === 'number' && apiPoints > 0) {
                        this.lockInitialPoints(apiPoints)
                        this.bot.userData.currentPoints = apiPoints
                        return apiPoints
                    }
                }

                // 3. Ekstrak langsung dari DOM dengan Node-level timeout (3000ms)
                const domPoints = await Promise.race([
                    activePage.evaluate(() => {
                        const cleanPointString = (raw?: string | null): number | null => {
                            if (!raw) return null
                            const trimmed = raw.trim()
                            if (trimmed.startsWith('+')) return null
                            const num = parseInt(trimmed.replace(/[^0-9]/g, ''), 10)
                            return isNaN(num) || num <= 0 ? null : num
                        }

                        const dashPoints = (window as any).dashboard?.userStatus?.availablePoints

                        // 1. Kartu dashboard resmi dengan teks 'Available points' / 'Poin yang tersedia'
                        const allCards = Array.from(document.querySelectorAll('div, section, .card, .p-card, .c-card, [class*="card"]'))
                        for (const el of allCards) {
                            const txt = (el.textContent || '').trim()
                            if ((txt.includes('Available points') || txt.includes('Poin yang tersedia')) && !txt.includes('Ready to claim') && txt.length < 150) {
                                if (txt.startsWith('+')) continue
                                const normalizedTxt = txt.replace(/(\d)[,.](?=\d{3}\b)/g, '$1')
                                const numbers = normalizedTxt
                                    .replace(/Available points|Poin yang tersedia|Redeem|>/gi, ' ')
                                    .match(/\b(\d+)\b/g)
                                if (numbers && numbers.length > 0) {
                                    const val = parseInt(numbers[0], 10)
                                    if (val > 0) {
                                        if (val < 50 && typeof dashPoints === 'number' && dashPoints > 100) {
                                            return dashPoints
                                        }
                                        return val
                                    }
                                }
                            }
                        }

                        // 2. Badge koin header Bing search (#id_rc atau #rh_meter)
                        const rcEl = document.getElementById('id_rc')
                        if (rcEl && !rcEl.innerText.trim().startsWith('+')) {
                            const rc = cleanPointString(rcEl.innerText)
                            if (rc) return rc
                        }

                        const flyoutEl = document.querySelector('#rh_meter .rh_meter_points, .id_rh_pts, #id_rh span, #id_h')
                        if (flyoutEl && !flyoutEl.textContent?.trim().startsWith('+')) {
                            const flyout = cleanPointString(flyoutEl.textContent)
                            if (flyout) return flyout
                        }

                        // Profile header badge (strictly header / profile, NO generic promo card selectors)
                        const headerEl = document.querySelector('header #userPoints, header .user-points, header .points-number, div.m-points-badge .points-number')
                        if (headerEl && !headerEl.textContent?.trim().startsWith('+')) {
                            const hp = cleanPointString(headerEl.textContent)
                            if (hp) return hp
                        }

                        // 3. Fallback ke window.dashboard jika di SSR awal
                        if (typeof dashPoints === 'number' && dashPoints > 0) return dashPoints

                        return null
                    }),
                    new Promise<null>(resolve => setTimeout(() => resolve(null), 3000))
                ]).catch(() => null)

                if (typeof domPoints === 'number' && domPoints > 0) {
                    const prevPoints = Number(this.bot.userData.currentPoints ?? 0)
                    if (prevPoints > 200 && domPoints < 50) {
                        return prevPoints
                    }
                    this.lockInitialPoints(domPoints)
                    this.bot.userData.currentPoints = domPoints
                    return domPoints
                }
            }

            return Number(this.bot.userData.currentPoints ?? 0)
        } catch (error) {
            return Number(this.bot.userData.currentPoints ?? 0)
        }
    }

    async closeBrowser(browser: BrowserContext, email: string) {
        const rootBrowser = (browser as any).browser?.() || null
        const isAborted = Boolean(
            this.bot.abortController?.signal?.aborted ||
            this.bot.accountScope?.abortController?.signal?.aborted ||
            this.bot.accountScope?.isDisposed
        )

        try {
            if (!isAborted) {
                if (this.bot.accountScope) {
                    const saveResult = await AccountSessionStore.saveContextSession(
                        browser,
                        this.bot.accountScope,
                        this.bot.isMobile ? 'mobile' : 'desktop'
                    )
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'CLOSE-BROWSER',
                        `Unified session persistence completed (${saveResult.status})`
                    )
                } else {
                    // Fallback for legacy standalone invocation without scope
                    const cookies = await browser.cookies()
                    this.bot.logger.debug(this.bot.isMobile, 'CLOSE-BROWSER', `Saving ${cookies.length} cookies.`)
                    await saveSessionData(this.bot.config.sessionPath, cookies, email, this.bot.isMobile)
                }
            }
        } catch (error) {
            if (!isAborted) {
                this.bot.logger.error(this.bot.isMobile, 'CLOSE-BROWSER', `Failed to save session: ${error}`)
            }
        } finally {
            try {
                await browser.close()

                if (rootBrowser) {
                    await rootBrowser.close().catch(() => {})
                }

                this.bot.logger.info(this.bot.isMobile, 'CLOSE-BROWSER', 'All browser resources closed.')
            } catch (closeError) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'CLOSE-BROWSER',
                    'Shutdown encountered an error, but process exiting.'
                )
            }
        }
    }

    buildCookieHeader(cookies: Cookie[], allowedDomains?: string[]): string {
        return [
            ...new Map(
                cookies
                    .filter(c => {
                        if (!allowedDomains || allowedDomains.length === 0) return true
                        return (
                            typeof c.domain === 'string' &&
                            allowedDomains.some(d => c.domain.toLowerCase().endsWith(d.toLowerCase()))
                        )
                    })
                    .map(c => [c.name, c])
            ).values()
        ]
            .map(c => `${c.name}=${c.value}`)
            .join('; ')
    }
}
