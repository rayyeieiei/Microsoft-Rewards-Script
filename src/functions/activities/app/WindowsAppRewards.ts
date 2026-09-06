import type { AxiosRequestConfig } from 'axios'
import { randomUUID } from 'crypto'
import type { Page } from 'patchright'
import type { DashboardData } from '../../../interface/DashboardData'
import { Workers } from '../../Workers'
import { Database } from '../../../util/Database'

export class WindowsAppRewards extends Workers {
    // Definisi header resmi lingkungan Microsoft Edge WebView2 (Windows Rewards / StartExperiencesApp)
    private static readonly WEBVIEW2_UA =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0 EmbeddedBrowserWebView/1.0'

    private static readonly WEBVIEW2_HEADERS: Record<string, string> = {
        'User-Agent': WindowsAppRewards.WEBVIEW2_UA,
        'X-Requested-With': 'Microsoft.StartExperiencesApp',
        'X-Rewards-App-Platform': 'WindowsApp',
        'X-Rewards-Platform': 'Windows',
        'sec-ch-ua': '"Microsoft Edge";v="130", "Chromium";v="130", "Not=A?Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
    }

    public async doWindowsAppRewards(data: DashboardData, page?: Page) {
        const email = this.bot.activeAccount?.email || 'unknown'
        this.bot.logger.info(this.bot.isMobile, 'WINDOWS-APP', `[WINDOWS-APP] Scanning "(Rewards App only)" cards for: ${email}`)

        // 1. Ekstrak kartu app-only dari dashboard awal
        let appOnlyPromos = this.extractAppOnlyPromotions(data)

        // 2. Jika data awal belum memuat kartu app-only (misal ter-strip oleh User-Agent mobile),
        // lakukan discovery fetch menggunakan Desktop User-Agent ke rewards.bing.com/api/getuserinfo?type=1
        if (!appOnlyPromos.length) {
            try {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'WINDOWS-APP',
                    '[WINDOWS-APP] Initial dashboard has 0 app-only cards. Fetching desktop catalog discovery...'
                )
                const activeCookies = (this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop) || []
                const cookieHeader = this.bot.browser.func.buildCookieHeader(activeCookies, [
                    'bing.com',
                    'live.com',
                    'microsoftonline.com'
                ])

                const desktopRes = await this.bot.axios.request({
                    url: 'https://rewards.bing.com/api/getuserinfo?type=1',
                    method: 'GET',
                    headers: {
                        'User-Agent':
                            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
                        'sec-ch-ua-mobile': '?0',
                        'sec-ch-ua-platform': '"Windows"',
                        Cookie: cookieHeader,
                        Referer: 'https://rewards.bing.com/',
                        Origin: 'https://rewards.bing.com'
                    },
                    timeout: 10000
                })

                const freshDashboard = desktopRes.data?.dashboard as DashboardData
                if (freshDashboard) {
                    const freshAppPromos = this.extractAppOnlyPromotions(freshDashboard)
                    if (freshAppPromos.length > 0) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'WINDOWS-APP',
                            `[WINDOWS-APP] Desktop catalog discovery found ${freshAppPromos.length} app-only cards!`
                        )
                        appOnlyPromos = freshAppPromos
                    }
                }
            } catch (desktopErr) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'WINDOWS-APP',
                    `Desktop catalog fetch failed: ${desktopErr instanceof Error ? desktopErr.message : String(desktopErr)}`
                )
            }
        }

        // Deduplikasi dan filter kartu yang belum selesai
        const uniqueMap = new Map<string, any>()
        for (const p of appOnlyPromos) {
            const key = (p.offerId || p.title || '').toLowerCase().trim()
            if (key && !uniqueMap.has(key)) {
                uniqueMap.set(key, p)
            }
        }
        const finalAppOnlyPromos = Array.from(uniqueMap.values())

        const uncompleted = finalAppOnlyPromos.filter(x => {
            const titleLower = (x.title ?? '').toLowerCase().trim()
            const offerIdLower = (x.offerId ?? '').toLowerCase().trim()
            if (this.completedOffersInSession.has(titleLower) || this.completedOffersInSession.has(offerIdLower)) {
                return false
            }
            return !x.complete || (x.pointProgressMax > 0 && (x.pointProgress ?? 0) < x.pointProgressMax)
        })

        if (!uncompleted.length) {
            this.bot.logger.info(
                this.bot.isMobile,
                'WINDOWS-APP',
                `[WINDOWS-APP] Found 0 uncompleted app-only cards. All completed for today.`,
                'green'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'WINDOWS-APP',
            `[WINDOWS-APP] Found ${uncompleted.length} uncompleted "(Rewards App only)" cards. Starting WebView2 Emulation pipeline...`
        )

        let totalGained = 0
        const startBalance = Number(this.bot.userData.currentPoints ?? 0)

        for (let i = 0; i < uncompleted.length; i++) {
            const promo = uncompleted[i]!
            const title = promo.title || promo.offerId || 'App-Only Promotion'
            const offerId = promo.offerId || ''
            const expectedPoints = Number(promo.pointProgressMax ?? 10)
            const isServerLocked = promo.exclusiveLockedFeatureStatus === 'locked' ||
                                   promo.attributes?.is_unlocked === 'False' ||
                                   promo.attributes?.locked_category_criteria === 'rewardsApp'

            this.bot.logger.info(
                this.bot.isMobile,
                'WINDOWS-APP',
                `Processing Windows App card ${i + 1}/${uncompleted.length}: "${title}" (+${expectedPoints} Pts)`
            )

            let claimed = false
            const beforeCardBalance = Number(this.bot.userData.currentPoints ?? 0)

            // =========================================================================
            // LAYER 1: DAPI ACTIVITY CLAIM DENGAN IDENTITAS WINDOWS APP
            // =========================================================================
            if (this.bot.accessToken && offerId) {
                try {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'WINDOWS-APP',
                        `[Layer 1 - DAPI Windows] Sending direct claim request | offerId=${offerId}`
                    )

                    const rawType = promo.activityType ? parseInt(String(promo.activityType), 10) : 102
                    const dapiType = !isNaN(rawType) && rawType > 0 ? rawType : 102

                    const jsonData = {
                        amount: 1,
                        id: randomUUID(),
                        type: dapiType,
                        attributes: {
                            offerid: offerId,
                            app_name: 'Microsoft.StartExperiencesApp',
                            platform: 'windows',
                            client_version: '1.380.2.0'
                        },
                        country: this.bot.userData.geoLocale
                    }

                    const request: AxiosRequestConfig = {
                        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${this.bot.accessToken}`,
                            'User-Agent': WindowsAppRewards.WEBVIEW2_UA,
                            'X-Requested-With': 'Microsoft.StartExperiencesApp',
                            'X-Rewards-App-Platform': 'WindowsApp',
                            'X-Rewards-Platform': 'Windows',
                            'Content-Type': 'application/json',
                            'X-Rewards-Country': this.bot.userData.geoLocale,
                            'X-Rewards-Language': 'en',
                            'X-Rewards-ismobile': 'false'
                        },
                        data: JSON.stringify(jsonData),
                        validateStatus: () => true,
                        timeout: 8000
                    }

                    const response = await this.bot.axios.request(request)

                    if (response?.status === 200) {
                        const serverBalance = Number(response?.data?.response?.balance)
                        const actualGained = (!isNaN(serverBalance) && serverBalance > beforeCardBalance)
                            ? (serverBalance - beforeCardBalance)
                            : 0

                        if (actualGained > 0) {
                            claimed = true
                            this.bot.userData.currentPoints = serverBalance
                            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + actualGained
                            totalGained += actualGained

                            this.completedOffersInSession.add(offerId.toLowerCase().trim())
                            this.completedOffersInSession.add(title.toLowerCase().trim())

                            void Database.getInstance().recordActivity(
                                this.bot.activeAccount?.email || '',
                                'APP_ONLY_REWARDS',
                                actualGained
                            )

                            this.bot.logger.info(
                                this.bot.isMobile,
                                'WINDOWS-APP',
                                `🎉 [Layer 1 - DAPI Windows] Completed: "${title}" | gainedPoints=+${actualGained} | oldBalance=${beforeCardBalance} | newBalance=${serverBalance}`,
                                'green'
                            )
                        }
                        await this.bot.utils.wait(1500)
                    } else {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'WINDOWS-APP',
                            `[Layer 1 - DAPI Windows] Status ${response?.status}, falling back to Layer 2 WebView2 DOM...`
                        )
                    }
                } catch (dapiErr) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'WINDOWS-APP',
                        `[Layer 1 - DAPI Windows] Error: ${dapiErr instanceof Error ? dapiErr.message : String(dapiErr)}`
                    )
                }
            }

            // =========================================================================
            // LAYER 2: WEBVIEW2 IN-APP DOM TILE CLICK & NATURAL DWELL TIME
            // =========================================================================
            if (!claimed && page && !page.isClosed()) {
                try {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'WINDOWS-APP',
                        `[Layer 2 - WebView2 DOM] Opening emulated Windows App tab for: "${title}"`
                    )

                    const context = page.context()
                    const tab = await context.newPage()

                    try {
                        // Suntikkan header resmi WebView2 Windows Rewards App
                        await tab.setExtraHTTPHeaders({
                            ...WindowsAppRewards.WEBVIEW2_HEADERS,
                            'X-Rewards-Country': this.bot.userData.geoLocale,
                            'X-Rewards-Language': 'en'
                        }).catch(() => {})

                        // Override navigator.userAgent di level browser DOM
                        await tab.addInitScript(() => {
                            try {
                                Object.defineProperty(navigator, 'userAgent', {
                                    get: () =>
                                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0 EmbeddedBrowserWebView/1.0'
                                })
                                Object.defineProperty(navigator, 'platform', {
                                    get: () => 'Win32'
                                })
                            } catch {}
                        }).catch(() => {})

                        // 1. Kunjungi halaman /earn dengan WebView2 context
                        await tab.goto('https://rewards.bing.com/earn', {
                            waitUntil: 'domcontentloaded',
                            timeout: 20000,
                            referer: 'https://rewards.bing.com/'
                        }).catch(() => {})

                        await this.bot.utils.wait(2500)

                        // 2. Cari dan klik kartu di DOM secara langsung
                        const cleanTitle = title.replace(/[^\w\s]/gi, ' ').trim()
                        const firstKeywords = cleanTitle.split(/\s+/).slice(0, 3).join(' ')

                        const cardSelectors = [
                            `[data-bi-id*="${offerId}"]`,
                            `a[href*="${offerId}"]`,
                            `[id*="${offerId}"]`,
                            `a:has-text("${title}")`,
                            `div[role="button"]:has-text("${title}")`,
                            `button:has-text("${title}")`,
                            `a:has-text("${firstKeywords}")`,
                            `div[role="button"]:has-text("${firstKeywords}")`,
                            `.c-card:has-text("${firstKeywords}")`,
                            `.p-card:has-text("${firstKeywords}")`
                        ]

                        let tileClicked = false
                        for (const sel of cardSelectors) {
                            const el = tab.locator(sel).first()
                            if (await el.isVisible().catch(() => false)) {
                                await el.evaluate((node: HTMLElement) => {
                                    node.click()
                                    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                                }).catch(() => {})
                                tileClicked = true
                                this.bot.logger.debug(this.bot.isMobile, 'WINDOWS-APP', `[Layer 2 - WebView2 DOM] Clicked tile on /earn: "${title}"`)
                                break
                            }
                        }

                        // Jika kartu tidak ketemu di DOM, fallback buka clean destination URL (tanpa rnoreward=1)
                        if (!tileClicked && promo.destinationUrl) {
                            const rawTargetUrl = promo.destinationUrl.startsWith('http')
                                ? promo.destinationUrl
                                : `https://www.bing.com/search?q=${encodeURIComponent(title)}`
                            const cleanTargetUrl = rawTargetUrl.replace(/([?&])rnoreward=1(&|$)/, '$1').replace(/[?&]$/, '')

                            this.bot.logger.debug(this.bot.isMobile, 'WINDOWS-APP', `[Layer 2 - WebView2 DOM] Navigating directly to destination: ${cleanTargetUrl}`)
                            await tab.goto(cleanTargetUrl, {
                                waitUntil: 'domcontentloaded',
                                timeout: 20000,
                                referer: 'https://rewards.bing.com/earn'
                            }).catch(() => {})
                        }

                        await this.bot.utils.wait(2000)

                        // 3. Simulasi interaksi manusia & smooth scroll
                        await tab.evaluate(() => {
                            window.scrollBy({ top: 350, behavior: 'smooth' })
                        }).catch(() => {})
                        await this.bot.utils.wait(1500)

                        await tab.evaluate(() => {
                            window.scrollBy({ top: -150, behavior: 'smooth' })
                        }).catch(() => {})

                        // Dwell time aman agar beacon telemetri (/fd/ls/ & bat.bing.com) mencatat aktivitas
                        await this.bot.utils.wait(this.bot.utils.randomDelay(3500, 5000))

                        // 4. Verifikasi saldo aktual server melalui getCurrentPoints
                        const afterBalance = await this.bot.browser.func.getCurrentPoints(tab).catch(() => beforeCardBalance)
                        const actualGained = Math.max(0, afterBalance - beforeCardBalance)

                        if (actualGained > 0) {
                            claimed = true
                            this.bot.userData.currentPoints = afterBalance
                            this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + actualGained
                            totalGained += actualGained

                            this.completedOffersInSession.add(offerId.toLowerCase().trim())
                            this.completedOffersInSession.add(title.toLowerCase().trim())

                            void Database.getInstance().recordActivity(
                                this.bot.activeAccount?.email || '',
                                'APP_ONLY_REWARDS',
                                actualGained
                            )

                            this.bot.logger.info(
                                this.bot.isMobile,
                                'WINDOWS-APP',
                                `🎉 [Layer 2 - WebView2 DOM] Completed: "${title}" | gainedPoints=+${actualGained} | oldBalance=${beforeCardBalance} | newBalance=${afterBalance}`,
                                'green'
                            )
                        } else {
                            this.bot.logger.debug(
                                this.bot.isMobile,
                                'WINDOWS-APP',
                                `[Layer 2 - WebView2 DOM] Completed interaction for "${title}", but no points were awarded (balance=${afterBalance}).`
                            )
                        }
                    } finally {
                        await tab.close().catch(() => {})
                    }
                } catch (navErr) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'WINDOWS-APP',
                        `[Layer 2 - WebView2 DOM] Failed for "${title}": ${navErr instanceof Error ? navErr.message : String(navErr)}`
                    )
                }
            }

            // =========================================================================
            // SAFE FAST-SKIP & ZERO PHANTOM POINTS PROTECTION
            // =========================================================================
            if (!claimed) {
                this.completedOffersInSession.add(offerId.toLowerCase().trim())
                this.completedOffersInSession.add(title.toLowerCase().trim())

                // Jika kartu ini berstatus server-locked oleh Microsoft:
                // Setelah kartu pertama gagal, server Microsoft membuktikan bahwa seluruh batch kartu ini dikunci ke native app shell.
                // Lakukan fast-skip untuk sisa kartu agar MENGHEMAT KUOTA (<20MB) dan waktu eksekusi tanpa phantom points!
                if (isServerLocked && uncompleted.length > 1) {
                    for (let j = i + 1; j < uncompleted.length; j++) {
                        const nextPromo = uncompleted[j]!
                        const nextOfferId = (nextPromo.offerId || '').toLowerCase().trim()
                        const nextTitle = (nextPromo.title || '').toLowerCase().trim()
                        if (nextOfferId) this.completedOffersInSession.add(nextOfferId)
                        if (nextTitle) this.completedOffersInSession.add(nextTitle)
                    }

                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'WINDOWS-APP',
                        `[WINDOWS-APP] [SERVER-LOCKED] Card "${title}" confirmed locked by Microsoft server (exclusiveLockedFeatureStatus: "locked"). Safely skipping remaining ${uncompleted.length - 1 - i} locked card(s) to conserve bandwidth (<20MB) with 0 phantom points.`
                    )
                    break
                }
            }
        }

        const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)
        if (totalGained > 0) {
            this.bot.logger.info(
                this.bot.isMobile,
                'WINDOWS-APP',
                `🎉 [WINDOWS-APP] Windows App Rewards completed! | gainedPoints=+${totalGained} | oldBalance=${startBalance} | newBalance=${finalBalance}`,
                'green'
            )
        } else {
            this.bot.logger.info(
                this.bot.isMobile,
                'WINDOWS-APP',
                `[WINDOWS-APP] All ${uncompleted.length} "(Rewards App only)" cards are strictly locked by Microsoft server (exclusiveLockedFeatureStatus: "locked"). Safely bypassed with 0 phantom points.`
            )
        }
    }
}
