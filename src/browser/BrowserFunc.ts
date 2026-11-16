import type { BrowserContext, Cookie, Page } from 'patchright'
import type { AxiosRequestConfig } from 'axios'

import type { MicrosoftRewardsBot } from '../index'
import { saveSessionData } from '../util/Load'
import { AccountSessionStore } from '../runtime/session/AccountSessionStore'
import { AccountSuspendedError, checkPageSuspension, isSuspensionContent } from './auth/SuspensionDetector'

export { AccountSuspendedError }

import type { Counters, DashboardData } from './../interface/DashboardData'
import type { AppUserData } from '../interface/AppUserData'
import type { XboxDashboardData } from '../interface/XboxDashboardData'
import type { AppEarnablePoints, BrowserEarnablePoints, MissingSearchPoints } from '../interface/Points'
import type { AppDashboardData } from '../interface/AppDashBoardData'

export default class BrowserFunc {
    public static isGetUserInfoDeprecated: boolean = false
    public cachedCounters?: Counters
    private bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    /**
     * Map AppDashboardData from DAPI to DashboardData
     */
    public mapAppDataToDashboard(appData: AppDashboardData): DashboardData | null {
        if (!appData?.response) return null
        const balance = appData.response.balance ?? 0
        const rawPromos = appData.response.promotions ?? []
        
        const dailySetItems: any[] = []
        const morePromos: any[] = []

        for (const p of rawPromos) {
            const attrs = p.attributes || {}
            const offerId = (attrs.offerid || p.name || '').toLowerCase()
            const title = attrs.title || p.name || ''
            const rawPointMax = attrs.pointmax || attrs.points
            const rawPointProgress = attrs.pointprogress
            
            const isInternalInfo = offerId.endsWith('_info') ||
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

            const complete = attrs.complete === 'True' || attrs.complete === 'true' || pointProgress >= pointProgressMax
            const destinationUrl = attrs.destination_url || attrs.url || 'https://rewards.bing.com'
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

            if (offerId.includes('dailyset') || offerId.includes('daily_set') || offerId.includes('child_offer')) {
                dailySetItems.push(promoObj)
            } else {
                morePromos.push(promoObj)
            }
        }

        if (dailySetItems.length > 0 || morePromos.length > 0 || balance > 0) {
            const cachedPcProgress = this.cachedCounters?.pcSearch?.[0]?.pointProgress ?? 0
            const cachedMobileProgress = this.cachedCounters?.mobileSearch?.[0]?.pointProgress ?? 0
            return {
                userStatus: {
                    availablePoints: balance,
                    counters: {
                        pcSearch: [{ pointProgress: cachedPcProgress, pointProgressMax: 90 }],
                        mobileSearch: [{ pointProgress: cachedMobileProgress, pointProgressMax: 60 }]
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
     * Fetch user desktop dashboard data
     * @returns {DashboardData} Object of user bing rewards dashboard data
     */
    async getDashboardData(): Promise<DashboardData> {
        const maxAttempts = 2
        const startTime = Date.now()
        const hardCapMs = 28000

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (Date.now() - startTime >= hardCapMs) break

            const activePage = this.bot.mainMobilePage || this.bot.mainDesktopPage

            if (activePage && !activePage.isClosed()) {
                const suspension = await checkPageSuspension(activePage)
                if (suspension.isSuspended) {
                    const accountEmail = this.bot.activeAccount?.email || 'unknown'
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'ACCOUNT-SUSPENDED',
                        `🚨 [ACCOUNT-SUSPENDED] Akun ${accountEmail} TERBUKTI DITANGGUHKAN (BANNED) oleh Microsoft!`
                    )
                    throw new AccountSuspendedError(accountEmail, suspension.reason)
                }
            }

            let liveCookies: Cookie[] = []
            if (activePage && !activePage.isClosed()) {
                liveCookies = await activePage.context().cookies().catch(() => [])
            }
            const activeCookies = liveCookies.length > 0 ? liveCookies : (this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop) || []

            // 1. Coba via In-Page Fetch Playwright JIKA halaman sedang berada di rewards.bing.com (Prioritas utama)
            if (activePage && !activePage.isClosed() && activePage.url().includes('rewards.bing.com')) {
                try {
                    // Tunggu hidrasi DOM jika kartu belum muncul
                    await activePage.waitForSelector('section#dailyset, [data-bi-area*="DailySet"], .c-card, [class*="card"]', { timeout: 3000 }).catch(() => {})

                    const inPageData = await activePage.evaluate(async () => {
                        let timeoutId: any
                        try {
                            const controller = new AbortController()
                            timeoutId = setTimeout(() => controller.abort(), 8000)
                            const res = await fetch('/api/getuserinfo?type=1', {
                                credentials: 'include',
                                signal: controller.signal
                            }).catch(() => fetch('/api/getuserinfo', {
                                credentials: 'include',
                                signal: controller.signal
                            }))
                            const json = await res.json()
                            if (json?.dashboard && json.dashboard.userStatus) {
                                return json.dashboard
                            }
                            if ((window as any).dashboard && (window as any).dashboard.userStatus) {
                                return (window as any).dashboard
                            }
                        } catch {} finally {
                            if (timeoutId) clearTimeout(timeoutId)
                        }

                        // Modern DOM State Extraction: Cek __NEXT_DATA__ atau React Hydration di rewards.bing.com/earn
                        try {
                            const nextScript = document.getElementById('__NEXT_DATA__') || document.querySelector('script[id="__NEXT_DATA__"]')
                            if (nextScript?.textContent) {
                                const nextJson = JSON.parse(nextScript.textContent)
                                const pageProps = nextJson?.props?.pageProps
                                if (pageProps?.dashboard && pageProps.dashboard.userStatus) return pageProps.dashboard
                                if (pageProps?.userStatus) return pageProps
                                if (pageProps?.state?.dashboard?.userStatus) return pageProps.state.dashboard
                            }
                        } catch {}

                        const win = window as any
                        if (win.__NEXT_DATA__?.props?.pageProps?.dashboard?.userStatus) {
                            return win.__NEXT_DATA__.props.pageProps.dashboard
                        }
                        if (win.__INITIAL_STATE__?.dashboard?.userStatus) {
                            return win.__INITIAL_STATE__.dashboard
                        }

                        return (window as any).dashboard || null
                    }).catch(() => null)

                    if (inPageData && inPageData.userStatus) {
                        return inPageData as DashboardData
                    }
                } catch {}
            }

            // 2. Coba via Axios API request dengan Desktop User-Agent (hanya jika endpoint belum terdeteksi 404 deprecated)
            if (!BrowserFunc.isGetUserInfoDeprecated && (Date.now() - startTime < hardCapMs)) {
                const apiEndpoints = [
                    'https://rewards.bing.com/api/getuserinfo?type=1',
                    'https://rewards.bing.com/api/getuserinfo'
                ]

                // Sinkronkan cookie terbaru dari activePage jika ada
                if (activePage && !activePage.isClosed()) {
                    const freshCookies = await activePage.context().cookies().catch(() => [])
                    if (freshCookies.length > 0) {
                        liveCookies = freshCookies
                    }
                }
                const reqCookies = liveCookies.length > 0 ? liveCookies : activeCookies

                for (const endpoint of apiEndpoints) {
                    if (Date.now() - startTime >= hardCapMs) break

                    try {
                        const request: AxiosRequestConfig = {
                            url: endpoint,
                            method: 'GET',
                            timeout: 10000,
                            'axios-retry': {
                                retries: 1
                            },
                            headers: {
                                ...(this.bot.fingerprint?.headers ?? {}),
                                'User-Agent':
                                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
                                'sec-ch-ua-mobile': '?0',
                                'sec-ch-ua-platform': '"Windows"',
                                Cookie: this.buildCookieHeader(reqCookies, [
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
                            return response.data.dashboard as DashboardData
                        }
                    } catch (error: any) {
                        if (error?.response?.status === 404) {
                            BrowserFunc.isGetUserInfoDeprecated = true
                            break
                        }
                    }
                }
            }

            // 3. Coba parsing script tag dari HTML dashboard
            if (Date.now() - startTime < hardCapMs) {
                try {
                    const request: AxiosRequestConfig = {
                        url: this.bot.config.baseURL,
                        method: 'GET',
                        timeout: 5000,
                        headers: {
                            ...(this.bot.fingerprint?.headers ?? {}),
                            Cookie: this.buildCookieHeader(activeCookies),
                            Referer: 'https://rewards.bing.com/',
                            Origin: 'https://rewards.bing.com'
                        }
                    }

                    const response = await this.bot.axios.request(request)
                    const match = response.data.match(/var\s+dashboard\s*=\s*({.*?});/s)

                    if (match?.[1]) {
                        const parsed = JSON.parse(match[1]) as DashboardData
                        if (parsed?.userStatus) {
                            return parsed
                        }
                    }

                    // Modern Next.js DOM Parser: Ekstraksi <script id="__NEXT_DATA__" type="application/json">
                    const nextMatch = response.data.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/)
                    if (nextMatch?.[1]) {
                        try {
                            const nextData = JSON.parse(nextMatch[1])
                            const pageProps = nextData?.props?.pageProps
                            const modernDash = pageProps?.dashboard?.userStatus ? pageProps.dashboard : (pageProps?.userStatus ? pageProps : null)
                            if (modernDash) {
                                return modernDash as DashboardData
                            }
                        } catch {}
                    }
                } catch {}
            }

            // 4. Fallback Terakhir: Adaptasi dari Mobile App API (dengan pemetaan promosi lengkap)
            if (this.bot.accessToken) {
                try {
                    const appData = await this.getAppDashboardData()
                    const mapped = this.mapAppDataToDashboard(appData)
                    if (mapped) {
                        return mapped
                    }
                } catch (err: any) {
                    if (err instanceof AccountSuspendedError || err?.name === 'AccountSuspendedError') {
                        throw err
                    }
                }
            }

            if (attempt < maxAttempts && Date.now() - startTime < hardCapMs) {
                await this.bot.utils.wait(1500)
            }
        }

        throw new Error('Failed to retrieve dashboard data from all endpoints after retries')
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
                timeout: 10000,
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'User-Agent':
                        'Bing/32.5.431027001 (com.microsoft.bing; build:431027001; iOS 17.6.1) Alamofire/5.10.2'
                }
            }

            const response = await this.bot.axios.request(request)
            return response.data as AppDashboardData
        } catch (error: any) {
            const status = error?.response?.status
            if (status === 403 || status === 401) {
                const activePage = this.bot.mainMobilePage || this.bot.mainDesktopPage
                const accountEmail = this.bot.activeAccount?.email || 'unknown'
                if (activePage && !activePage.isClosed()) {
                    const pageContent = await activePage.content().catch(() => '')
                    const currentUrl = activePage.url() || ''
                    if (isSuspensionContent(pageContent, currentUrl)) {
                        this.bot.logger.error(
                            this.bot.isMobile,
                            'ACCOUNT-SUSPENDED',
                            `🚨 [ACCOUNT-SUSPENDED] Akun ${accountEmail} TERBUKTI DITANGGUHKAN (BANNED) oleh Microsoft!`
                        )
                        throw new AccountSuspendedError(accountEmail, 'DAPI returned 401/403 and page confirmed suspension')
                    }
                }
            }

            this.bot.logger.error(
                this.bot.isMobile,
                'GET-APP-DASHBOARD-DATA',
                `Error fetching dashboard data: ${error?.message || (error?.response?.status ? `HTTP ${error.response.status}` : String(error))}`
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

    /**
     * Get search point counters
     * @param {Page} [page] Optional active page to extract fast in-page counters from
     * @param {boolean} [forceDapi=false] If true, bypasses in-memory cached counters
     * @param {boolean} [isMobile] Context indicator
     * @param {boolean} [allowOptimisticIncrement=false] Allow optimistic counter increment (+3)
     */
    async getSearchPoints(
        page?: Page,
        forceDapi: boolean = false,
        isMobile?: boolean,
        allowOptimisticIncrement: boolean = false
    ): Promise<Counters> {
        let counters: Counters | null = null

        if (!forceDapi && this.cachedCounters) {
            counters = this.cachedCounters
        }

        if (!counters && page && !page.isClosed()) {
            const inPageData = await page.evaluate(() => {
                const dash = (window as any).dashboard
                if (dash?.userStatus?.counters) return { counters: dash.userStatus.counters }
                const rc = document.getElementById('id_rc')?.innerText?.replace(/[^0-9]/g, '')
                if (rc && !isNaN(Number(rc)) && Number(rc) > 0) return { rcPoints: Number(rc) }
                return null
            }).catch(() => null)

            if (inPageData?.counters) {
                this.cachedCounters = inPageData.counters
                counters = inPageData.counters
            }
            if (inPageData?.rcPoints) {
                this.bot.userData.currentPoints = inPageData.rcPoints
            }
        }

        if (!counters) {
            try {
                const dashboardData = await this.getDashboardData()
                const dCounters = dashboardData?.userStatus?.counters
                if (dCounters && (dCounters.pcSearch?.length || dCounters.mobileSearch?.length)) {
                    this.cachedCounters = dCounters
                    counters = dCounters
                } else {
                    const dailySearchPts = Number(dashboardData?.userStatus?.levelInfo?.bingSearchDailyPoints || 0)
                    const userLevel = Number(dashboardData?.userStatus?.levelInfo?.activeLevel || 1)
                    const isLevel2 = userLevel >= 2 || (dashboardData?.userStatus?.availablePoints ?? 0) >= 500
                    const pcQuota = dailySearchPts > 0 ? dailySearchPts : (isLevel2 ? 90 : 30)
                    const mobileQuota = isLevel2 ? 60 : (this.bot.config?.workers?.doMobileSearch ? 60 : 0)
                    const res = {
                        pcSearch: [{ pointProgress: 0, pointProgressMax: pcQuota }],
                        mobileSearch: mobileQuota > 0 ? [{ pointProgress: 0, pointProgressMax: mobileQuota }] : []
                    } as unknown as Counters
                    this.cachedCounters = res
                    counters = res
                }
            } catch {
                const isMobileEnabled = this.bot.config?.workers?.doMobileSearch !== false
                counters = {
                    pcSearch: [{ pointProgress: 0, pointProgressMax: 90 }],
                    mobileSearch: isMobileEnabled ? [{ pointProgress: 0, pointProgressMax: 60 }] : []
                } as unknown as Counters
            }
        }

        // Jangan menimpa pointProgress menjadi 0 jika di sesi sudah ada progres pencarian yang valid dan counters yang baru adalah 0 akibat fallback kosong
        if (!forceDapi && counters && this.cachedCounters) {
            if (!isMobile && counters.pcSearch?.[0] && this.cachedCounters.pcSearch?.[0]) {
                const prevPcProgress = this.cachedCounters.pcSearch[0].pointProgress ?? 0
                if ((counters.pcSearch[0].pointProgress ?? 0) === 0 && prevPcProgress > 0) {
                    counters.pcSearch[0].pointProgress = prevPcProgress
                }
            } else if (isMobile && counters.mobileSearch?.[0] && this.cachedCounters.mobileSearch?.[0]) {
                const prevMobileProgress = this.cachedCounters.mobileSearch[0].pointProgress ?? 0
                if ((counters.mobileSearch[0].pointProgress ?? 0) === 0 && prevMobileProgress > 0) {
                    counters.mobileSearch[0].pointProgress = prevMobileProgress
                }
            }
        }

        if (allowOptimisticIncrement && counters) {
            if (isMobile && counters.mobileSearch?.[0]) {
                counters.mobileSearch[0].pointProgress = Math.min(
                    counters.mobileSearch[0].pointProgressMax,
                    (counters.mobileSearch[0].pointProgress || 0) + 3
                )
            } else if (!isMobile && counters.pcSearch?.[0]) {
                counters.pcSearch[0].pointProgress = Math.min(
                    counters.pcSearch[0].pointProgressMax,
                    (counters.pcSearch[0].pointProgress || 0) + 3
                )
            }
            this.cachedCounters = counters
        }

        return counters
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
            const data = preloadedData ?? await this.getDashboardData()

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
            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'X-Rewards-Country': this.bot.userData.geoLocale || 'US',
                    'X-Rewards-Language': 'en',
                    'X-Rewards-ismobile': 'true'
                }
            }

            const response = await this.bot.axios.request(request)
            const userData: AppUserData = response.data
            const allPromotions = userData?.response?.promotions || []

            let readToEarn = 0
            let readToEarnCompleted = false
            let readOfferFound = false
            let checkIn = 0

            for (const item of allPromotions) {
                const attrs = item.attributes || {}
                const offerId = (attrs.offerid ?? '').toLowerCase()
                const isReadOffer =
                    attrs.type === 'msnreadearn' ||
                    offerId.includes('readarticle') ||
                    (item.name ?? '').toLowerCase().includes('readarticle')

                if (isReadOffer) {
                    readOfferFound = true
                    const pointMax = parseInt(attrs.pointmax ?? '30', 10) || 30
                    const pointProgress = parseInt(attrs.pointprogress ?? '0', 10) || 0

                    const lastUpdated = attrs.last_updated ? new Date(attrs.last_updated) : null
                    const now = new Date()
                    const isUpdatedToday = lastUpdated && (
                        (lastUpdated.getUTCFullYear() === now.getUTCFullYear() &&
                         lastUpdated.getUTCMonth() === now.getUTCMonth() &&
                         lastUpdated.getUTCDate() === now.getUTCDate()) ||
                        (lastUpdated.getFullYear() === now.getFullYear() &&
                         lastUpdated.getMonth() === now.getMonth() &&
                         lastUpdated.getDate() === now.getDate())
                    )

                    if (pointProgress >= pointMax) {
                        if (lastUpdated && !isUpdatedToday) {
                            // Data lama kemarin yang belum di-reset oleh server DAPI
                            readToEarn = pointMax
                            readToEarnCompleted = false
                        } else if (!lastUpdated) {
                            // Tanpa timestamp: jangan berasumsi selesai, tetap berikan kuota
                            readToEarn = pointMax
                            readToEarnCompleted = false
                        } else {
                            readToEarn = 0
                            readToEarnCompleted = true
                        }
                    } else {
                        readToEarn = Math.max(0, pointMax - pointProgress)
                        readToEarnCompleted = false
                    }
                    if (attrs.offerid) {
                        ;(this.bot as any).detectedReadArticleOfferId = attrs.offerid
                    }
                } else if (attrs.type === 'checkin' || offerId.includes('dailycheckin')) {
                    const progress = parseInt(attrs.progress ?? '0', 10) || 0
                    const checkInDay = (progress % 7) + 1 // Hari ke-1 s/d Hari ke-7
                    const nextDayKey = `day_${checkInDay}_points`
                    const possiblePoints = parseInt(attrs[nextDayKey] ?? '10', 10) || 10

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

            // Jika promosi Read To Earn TIDAK ditemukan dalam respons DAPI, JANGAN asumsikan 0 (selesai)!
            // Tetap berikan kuota 30 agar bot menjalankan Read To Earn secara aktif
            if (!readOfferFound) {
                readToEarn = 30
                readToEarnCompleted = false
            }

            const totalEarnablePoints = readToEarn + checkIn

            return {
                readToEarn,
                checkIn,
                totalEarnablePoints,
                readToEarnCompleted
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
                // 1. Direct Request Context (fastest, no DOM/eval stall risk, shares context cookies)
                try {
                    const ctx = activePage.context()
                    if (ctx && ctx.request) {
                        const res = await ctx.request.get('https://rewards.bing.com/api/getuserinfo?type=1', {
                            timeout: 4000,
                            failOnStatusCode: false
                        })
                        if (res && typeof res.ok === 'function' && res.ok()) {
                            const data = await res.json().catch(() => null)
                            const pts = data?.dashboard?.userStatus?.availablePoints
                            if (typeof pts === 'number' && pts > 0) {
                                this.bot.userData.currentPoints = pts
                                return pts
                            }
                        }
                    }
                } catch {
                    // Fallback to in-page evaluate if request context fails
                }

                // 2. Fallback: in-page fetch dengan AbortController & Node-level timeout (6000ms)
                const apiPoints = await Promise.race([
                    activePage.evaluate(async () => {
                        let timeoutId: any
                        try {
                            const controller = new AbortController()
                            timeoutId = setTimeout(() => controller.abort(), 4000)
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
                    new Promise<null>(resolve => setTimeout(() => resolve(null), 6000))
                ]).catch(() => null)

                if (typeof apiPoints === 'number' && apiPoints > 0) {
                    this.bot.userData.currentPoints = apiPoints
                    return apiPoints
                }

                // 3. Ekstrak langsung dari DOM dengan Node-level timeout (3000ms)
                const domPoints = await Promise.race([
                    activePage.evaluate(() => {
                        const allCards = Array.from(document.querySelectorAll('div, section, .card, .p-card, .c-card, [class*="card"]'))
                        for (const el of allCards) {
                            const txt = (el.textContent || '').trim()
                            if (txt.startsWith('+')) continue
                            if ((txt.includes('Available points') || txt.includes('Poin yang tersedia')) && !txt.includes('Ready to claim') && txt.length < 150) {
                                const cleaned = txt.replace(/Available points|Poin yang tersedia|Redeem|>/gi, '')
                                const lines = cleaned.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('+'))
                                for (const line of lines) {
                                    const digitsOnly = line.replace(/[^\d]/g, '')
                                    if (digitsOnly) {
                                        const val = parseInt(digitsOnly, 10)
                                        if (val > 0) return val
                                    }
                                }
                            }
                        }

                        // 2. Badge koin header Bing search (#id_rc atau #rh_meter)
                        const rcEl = document.getElementById('id_rc')
                        const rcText = (rcEl?.innerText || '').trim()
                        if (rcText && !rcText.startsWith('+')) {
                            const rcDigits = rcText.replace(/[^\d]/g, '')
                            if (rcDigits) {
                                const rcVal = parseInt(rcDigits, 10)
                                if (rcVal > 0) return rcVal
                            }
                        }

                        const flyoutEl = document.querySelector('#rh_meter .rh_meter_points, .id_rh_pts, #id_rh, #id_h')
                        const flyoutText = (flyoutEl?.textContent || '').trim()
                        if (flyoutText && !flyoutText.startsWith('+')) {
                            const flyoutDigits = flyoutText.replace(/[^\d]/g, '')
                            if (flyoutDigits) {
                                const flyoutVal = parseInt(flyoutDigits, 10)
                                if (flyoutVal > 0) return flyoutVal
                            }
                        }

                        const headerEl = document.querySelector('header [class*="points"], [data-bi-area*="points"], #userPoints, .user-points')
                        const headerText = (headerEl?.textContent || '').trim()
                        if (headerText && !headerText.startsWith('+')) {
                            const headerDigits = headerText.replace(/[^\d]/g, '')
                            if (headerDigits) {
                                const headerVal = parseInt(headerDigits, 10)
                                if (headerVal > 0) return headerVal
                            }
                        }

                        // 3. Fallback ke window.dashboard jika di SSR awal
                        const dashPoints = (window as any).dashboard?.userStatus?.availablePoints
                        if (dashPoints && !isNaN(Number(dashPoints)) && Number(dashPoints) > 0) return Number(dashPoints)

                        return null
                    }),
                    new Promise<null>(resolve => setTimeout(() => resolve(null), 3000))
                ]).catch(() => null)

                if (typeof domPoints === 'number' && domPoints > 0) {
                    this.bot.userData.currentPoints = domPoints
                    return domPoints
                }
            }

            return Number(this.bot.userData.currentPoints ?? 0)
        } catch (error) {
            return Number(this.bot.userData.currentPoints ?? 0)
        }
    }

    async closeBrowser(browser: BrowserContext, email: string, closeTimeoutMs: number = 5000) {
        const rootBrowser = (browser as any).browser?.() || (browser as any)._browser || null
        const browserProcess =
            (typeof rootBrowser?.process === 'function' ? rootBrowser.process() : rootBrowser?.process) ||
            (typeof (browser as any).process === 'function' ? (browser as any).process() : (browser as any).process) ||
            null
        const browserPid: number | undefined = browserProcess?.pid

        try {
            const isClosed = typeof (browser as any).isClosed === 'function'
                ? (browser as any).isClosed()
                : (browser as any).__isClosed === true

            if (!isClosed) {
                if (this.bot.accountScope) {
                    const saveResult = await AccountSessionStore.saveContextSession(
                        browser,
                        this.bot.accountScope,
                        this.bot.isMobile ? 'mobile' : 'desktop'
                    )
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'CLOSE-BROWSER',
                        `Unified session persistence completed (${saveResult.status}${saveResult.status === 'failed' ? `: ${(saveResult as any).error}` : ''})`
                    )
                } else {
                    // Fallback for legacy standalone invocation without scope
                    const cookies = await browser.cookies()
                    this.bot.logger.debug(this.bot.isMobile, 'CLOSE-BROWSER', `Saving ${cookies.length} cookies.`)
                    await saveSessionData(this.bot.config.sessionPath, cookies, email, this.bot.isMobile)
                }
            }
        } catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'CLOSE-BROWSER', `Failed to save session: ${error}`)
        } finally {
            let closeTimedOut = false
            try {
                (browser as any).__isClosed = true

                // Bounded context close
                await Promise.race([
                    browser.close(),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('Browser context close timeout')), closeTimeoutMs)
                    )
                ]).catch(err => {
                    closeTimedOut = true
                    throw err
                })

                if (rootBrowser) {
                    // Bounded root browser close
                    await Promise.race([
                        rootBrowser.close(),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error('Root browser close timeout')), closeTimeoutMs)
                        )
                    ]).catch(err => {
                        closeTimedOut = true
                        throw err
                    })
                }

                this.bot.logger.info(this.bot.isMobile, 'CLOSE-BROWSER', 'All browser resources closed.')
            } catch (closeError) {
                // Orphan process reaper di Linux jika close timeout atau gagal
                if ((closeTimedOut || process.platform === 'linux') && (browserProcess || browserPid)) {
                    try {
                        if (browserProcess && !browserProcess.killed && typeof browserProcess.kill === 'function') {
                            browserProcess.kill('SIGKILL')
                        } else if (browserPid) {
                            process.kill(browserPid, 'SIGKILL')
                        }
                    } catch {}
                }

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
