import type { BrowserContext, Cookie, Page } from 'patchright'
import type { AxiosRequestConfig } from 'axios'

import type { MicrosoftRewardsBot } from '../index'
import { saveSessionData } from '../util/Load'

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

    /**
     * Fetch user desktop dashboard data
     * @returns {DashboardData} Object of user bing rewards dashboard data
     */
    async getDashboardData(): Promise<DashboardData> {
        const maxAttempts = 3

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const activePage = this.bot.mainMobilePage || this.bot.mainDesktopPage
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
                        try {
                            const res = await fetch('/api/getuserinfo?type=1', { credentials: 'include' }).catch(() => fetch('/api/getuserinfo', { credentials: 'include' }))
                            const json = await res.json()
                            return json?.dashboard || (window as any).dashboard || null
                        } catch { return (window as any).dashboard || null }
                    }).catch(() => null)

                    const hasAppOnlyInPage = (inPageData?.morePromotions || []).some((p: any) =>
                        (p.title || '').toLowerCase().includes('rewards app only') ||
                        (p.offerId || '').toLowerCase().includes('rewardsapp_offer')
                    )

                    if (inPageData && inPageData.userStatus && (inPageData.dailySetPromotions || hasAppOnlyInPage || inPageData.punchCards)) {
                        if (hasAppOnlyInPage || (inPageData.morePromotions?.length ?? 0) > 10) {
                            return inPageData as DashboardData
                        }
                    }
                } catch {}
            }

            // 2. Coba via Axios API request dengan Desktop User-Agent agar tidak ter-strip oleh backend Microsoft
            const apiEndpoints = [
                'https://rewards.bing.com/api/getuserinfo?type=1',
                'https://rewards.bing.com/api/getuserinfo'
            ]

            for (const endpoint of apiEndpoints) {
                try {
                    const request: AxiosRequestConfig = {
                        url: endpoint,
                        method: 'GET',
                        timeout: 10000,
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
                        return response.data.dashboard as DashboardData
                    }
                } catch (error) {
                    // Ignore 404 silently on deprecated direct API endpoints
                }
            }

            // 3. Coba parsing script tag dari HTML dashboard
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
            } catch {}

            // 4. Fallback Terakhir: Adaptasi dari Mobile App API (dengan pemetaan promosi lengkap)
            if (this.bot.accessToken) {
                try {
                    const appData = await this.getAppDashboardData()
                    if (appData?.response) {
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
                    }
                } catch {}
            }

            if (attempt < maxAttempts) {
                await this.bot.utils.wait(2000)
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
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'User-Agent':
                        'Bing/32.5.431027001 (com.microsoft.bing; build:431027001; iOS 17.6.1) Alamofire/5.10.2'
                }
            }

            const response = await this.bot.axios.request(request)
            return response.data as AppDashboardData
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'GET-APP-DASHBOARD-DATA',
                `Error fetching dashboard data: ${error instanceof Error ? error.message : String(error)}`
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
     */
    async getSearchPoints(page?: Page): Promise<Counters> {
        if (page && !page.isClosed() && page.url().includes('rewards.bing.com')) {
            const inPageCounters = await page.evaluate(() => {
                const dash = (window as any).dashboard
                if (dash?.userStatus?.counters) return dash.userStatus.counters
                return null
            }).catch(() => null)

            if (inPageCounters) return inPageCounters
        }

        try {
            const dashboardData = await this.getDashboardData()
            const counters = dashboardData?.userStatus?.counters
            if (counters && (counters.pcSearch?.length || counters.mobileSearch?.length)) {
                return counters
            }
            const dailySearchPts = Number(dashboardData?.userStatus?.levelInfo?.bingSearchDailyPoints || 0)
            if (dailySearchPts > 0) {
                return {
                    pcSearch: [{ pointProgress: 0, pointProgressMax: dailySearchPts }],
                    mobileSearch: []
                } as unknown as Counters
            }
            return counters || ({
                pcSearch: [{ pointProgress: 0, pointProgressMax: 60 }],
                mobileSearch: []
            } as unknown as Counters)
        } catch {
            return {
                pcSearch: [{ pointProgress: 0, pointProgressMax: 60 }],
                mobileSearch: []
            } as unknown as Counters
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
    async getBrowserEarnablePoints(): Promise<BrowserEarnablePoints> {
        try {
            const data = await this.getDashboardData()

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

            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613',
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'X-Rewards-Country': this.bot.userData.geoLocale,
                    'X-Rewards-Language': 'en',
                    'X-Rewards-ismobile': 'true'
                }
            }

            const response = await this.bot.axios.request(request)
            const userData: AppUserData = response.data
            const eligibleActivities = userData.response.promotions.filter(x =>
                eligibleOffers.includes(x.attributes.offerid ?? '')
            )

            let readToEarn = 0
            let checkIn = 0

            for (const item of eligibleActivities) {
                const attrs = item.attributes

                if (attrs.type === 'msnreadearn') {
                    const pointMax = parseInt(attrs.pointmax ?? '0')
                    const pointProgress = parseInt(attrs.pointprogress ?? '0')
                    readToEarn = Math.max(0, pointMax - pointProgress)
                } else if (attrs.type === 'checkin') {
                    const progress = parseInt(attrs.progress ?? '0')
                    const checkInDay = progress % 7
                    const lastUpdated = new Date(attrs.last_updated ?? '')
                    const today = new Date()

                    if (checkInDay < 6 && today.getDate() !== lastUpdated.getDate()) {
                        checkIn = parseInt(attrs[`day_${checkInDay + 1}_points`] ?? '0')
                    }
                }
            }

            const totalEarnablePoints = readToEarn + checkIn

            return {
                readToEarn,
                checkIn,
                totalEarnablePoints
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
                // 1. Ekstrak langsung dari kartu "Available points" di Dashboard Rewards modern (Live State)
                const domPoints = await activePage.evaluate(() => {
                    const allCards = Array.from(document.querySelectorAll('div, section, .card, .p-card, .c-card, [class*="card"]'))
                    for (const el of allCards) {
                        const txt = (el.textContent || '').trim()
                        if ((txt.includes('Available points') || txt.includes('Poin yang tersedia')) && !txt.includes('Ready to claim') && txt.length < 150) {
                            const numbers = txt.replace(/Available points|Poin yang tersedia|Redeem|>|,/gi, ' ').match(/\b(\d+)\b/g)
                            if (numbers && numbers.length > 0) {
                                const val = parseInt(numbers[0], 10)
                                if (val > 0) return val
                            }
                        }
                    }

                    // 2. Badge koin header Bing search (#id_rc atau #rh_meter)
                    const rc = document.getElementById('id_rc')?.innerText?.replace(/[^0-9]/g, '')
                    if (rc && !isNaN(Number(rc)) && Number(rc) > 0) return Number(rc)
                    const flyout = document.querySelector('#rh_meter .rh_meter_points, .id_rh_pts, #id_rh, #id_h')?.textContent?.replace(/[^0-9]/g, '')
                    if (flyout && !isNaN(Number(flyout)) && Number(flyout) > 0) return Number(flyout)

                    const headerPts = document.querySelector('header [class*="points"], [data-bi-area*="points"], #userPoints, .user-points')?.textContent?.replace(/[^0-9]/g, '')
                    if (headerPts && !isNaN(Number(headerPts)) && Number(headerPts) > 0) return Number(headerPts)

                    // 3. Fallback ke window.dashboard jika di SSR awal
                    const dashPoints = (window as any).dashboard?.userStatus?.availablePoints
                    if (dashPoints && !isNaN(Number(dashPoints)) && Number(dashPoints) > 0) return Number(dashPoints)

                    return null
                }).catch(() => null)

                if (typeof domPoints === 'number' && domPoints > 0) {
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

        try {
            // Try to save cookies
            const cookies = await browser.cookies()
            this.bot.logger.debug(this.bot.isMobile, 'CLOSE-BROWSER', `Saving ${cookies.length} cookies.`)
            await saveSessionData(this.bot.config.sessionPath, cookies, email, this.bot.isMobile)

            await this.bot.utils.wait(2000)
        } catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'CLOSE-BROWSER', `Failed to save session: ${error}`)
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
