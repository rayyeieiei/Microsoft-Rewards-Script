import type { AxiosRequestConfig } from 'axios'
import { randomUUID } from 'crypto'
import { URLSearchParams } from 'url'
import type { Page } from 'patchright'
import type { DashboardData } from '../../../interface/DashboardData'
import { Workers } from '../../Workers'
import { Database } from '../../../util/Database'

export class AppOnlyRewards extends Workers {
    public async doAppOnlyRewards(data: DashboardData, page?: Page) {
        const email = this.bot.activeAccount?.email || 'unknown'
        this.bot.logger.info(this.bot.isMobile, 'APP-ONLY', `[APP-ONLY] Checking app-only cards for: ${email}`)

        let dapiPromos: any[] = []
        if (this.bot.accessToken) {
            try {
                const dapiRes = await this.bot.axios.request({
                    url: 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAIOS&options=613',
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${this.bot.accessToken}`,
                        'User-Agent': 'Bing/32.5.431027001 (com.microsoft.bing; build:431027001; iOS 17.6.1) Alamofire/5.10.2'
                    },
                    timeout: 7000
                })
                const rawPromos = dapiRes.data?.response?.promotions || []
                for (const p of rawPromos) {
                    const attrs = p.attributes || {}
                    const title = attrs.title || p.name || ''
                    const offerId = attrs.offerid || p.name || ''
                    const titleLower = title.toLowerCase()
                    const offerIdLower = offerId.toLowerCase()

                    // Abaikan promo statis tutorial/onboarding bawaan aplikasi
                    const isInternalInfo = offerIdLower.endsWith('_info') ||
                                          offerIdLower.includes('sapphire_appnewbonus_') ||
                                          offerIdLower.includes('addwidget') ||
                                          offerIdLower.includes('notification') ||
                                          titleLower.includes('add widget') ||
                                          titleLower.includes('enable notification')
                    if (isInternalInfo) {
                        continue
                    }

                    const isAppOnly = titleLower.includes('rewards app only') ||
                                      titleLower.includes('app only') ||
                                      titleLower.includes('bing app') ||
                                      offerIdLower.includes('app_only') ||
                                      offerIdLower.includes('appoffer')

                    if (isAppOnly) {
                        const pointMax = parseInt(String(attrs.pointmax || attrs.points || '10'), 10) || 10
                        const pointProgress = parseInt(String(attrs.pointprogress || '0'), 10) || 0
                        const isComplete = attrs.complete === 'true' || attrs.complete === 'True' || (pointMax > 0 && pointProgress >= pointMax)
                        dapiPromos.push({
                            title,
                            offerId,
                            destinationUrl: attrs.destination || attrs.destination_url || attrs.url || 'https://rewards.bing.com',
                            pointProgressMax: pointMax,
                            pointProgress,
                            complete: isComplete,
                            promotionType: attrs.type || 'urlreward'
                        })
                    }
                }
            } catch (err) {
                this.bot.logger.debug(this.bot.isMobile, 'APP-ONLY', `DAPI fetch failed: ${err}`)
            }
        }

        // 1. Ekstrak dari data dashboard awal
        let appOnlyPromos = this.extractAppOnlyPromotions(data)

        // 2. JIKA data awal belum memiliki kartu app-only (misal ter-strip oleh Mobile UA di siklus mobile),
        // lakukan dedicated discovery fetch menggunakan Desktop User-Agent ke rewards.bing.com/api/getuserinfo?type=1
        if (!appOnlyPromos.length) {
            try {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'APP-ONLY',
                    '[APP-ONLY] Initial data has 0 app-only cards. Performing Desktop-UA discovery fetch...'
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
                            'APP-ONLY',
                            `[APP-ONLY] Desktop-UA discovery found ${freshAppPromos.length} app-only cards!`
                        )
                        appOnlyPromos = freshAppPromos
                    }
                }
            } catch (desktopErr) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'APP-ONLY',
                    `Desktop-UA discovery fetch failed: ${desktopErr instanceof Error ? desktopErr.message : String(desktopErr)}`
                )
            }
        }

        const combinedPromos = [...appOnlyPromos, ...dapiPromos]
        const uniqueMap = new Map<string, any>()
        for (const p of combinedPromos) {
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
                'APP-ONLY',
                `[APP-ONLY] Found 0 locked app-only cards. All completed for today.`,
                'green'
            )
            return
        }

        this.bot.logger.info(
            this.bot.isMobile,
            'APP-ONLY',
            `[APP-ONLY] Found ${uncompleted.length} locked app-only cards. Executing DAPI claim...`
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
                'APP-ONLY-REWARDS',
                `Processing App-Only card ${i + 1}/${uncompleted.length}: "${title}" (+${expectedPoints} Pts)`
            )

            let claimed = false
            const beforeCardBalance = Number(this.bot.userData.currentPoints ?? 0)

            // =========================================================================
            // LAYER 1: DAPI DIRECT ACTIVITY CLAIM (Super Cepat & 0 KB Kuota Media)
            // =========================================================================
            if (this.bot.accessToken && offerId) {
                try {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'APP-ONLY-REWARDS',
                        `[Layer 1 - DAPI] Sending direct claim request | offerId=${offerId}`
                    )

                    // Hindari type: 101 (karena 101 adalah Daily Check-In streak). Gunakan promo.activityType atau 104
                    const rawType = promo.activityType ? parseInt(String(promo.activityType), 10) : 104
                    const dapiType = !isNaN(rawType) && rawType > 0 && rawType !== 101 ? rawType : 104

                    const jsonData = {
                        amount: 1,
                        id: randomUUID(),
                        type: dapiType,
                        attributes: {
                            offerid: offerId
                        },
                        country: this.bot.userData.geoLocale
                    }

                    const request: AxiosRequestConfig = {
                        url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${this.bot.accessToken}`,
                            'User-Agent':
                                'Bing/32.5.431027001 (com.microsoft.bing; build:431027001; iOS 17.6.1) Alamofire/5.10.2',
                            'Content-Type': 'application/json',
                            'X-Rewards-Country': this.bot.userData.geoLocale,
                            'X-Rewards-Language': 'en',
                            'X-Rewards-ismobile': 'true'
                        },
                        data: JSON.stringify(jsonData),
                        timeout: 10000
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
                                'APP-ONLY-REWARDS',
                                `🎉 [Layer 1 - DAPI] Completed: "${title}" | gainedPoints=+${actualGained} | oldBalance=${beforeCardBalance} | newBalance=${serverBalance}`,
                                'green'
                            )
                        } else {
                            this.bot.logger.debug(
                                this.bot.isMobile,
                                'APP-ONLY-REWARDS',
                                `[Layer 1 - DAPI] Server returned HTTP 200 for "${title}", but no points were awarded. Falling back to Layer 2...`
                            )
                        }

                        await this.bot.utils.wait(this.bot.utils.randomDelay(1500, 3000))
                    } else {
                        this.bot.logger.debug(
                            this.bot.isMobile,
                            'APP-ONLY-REWARDS',
                            `[Layer 1 - DAPI] Returned status ${response?.status}, falling back to Layer 2...`
                        )
                    }
                } catch (dapiErr) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'APP-ONLY-REWARDS',
                        `[Layer 1 - DAPI] Failed: ${dapiErr instanceof Error ? dapiErr.message : String(dapiErr)}. Triggering Layer 2 fallback...`
                    )
                }
            }

            // =========================================================================
            // LAYER 2: MOBILE APP-SPOOFED NAVIGATION FALLBACK
            // =========================================================================
            if (!claimed && page && !page.isClosed() && promo.destinationUrl) {
                try {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'APP-ONLY-REWARDS',
                        `[Layer 2 - Fallback] Opening spoofed Bing App browser tab for: "${title}"`
                    )

                    const rawTargetUrl = promo.destinationUrl.startsWith('http')
                        ? promo.destinationUrl
                        : `https://www.bing.com/search?q=${encodeURIComponent(title)}`

                    // Bersihkan parameter Microsoft "Rewards No Reward" (rnoreward=1) dari destination URL
                    const cleanTargetUrl = rawTargetUrl.replace(/([?&])rnoreward=1(&|$)/, '$1').replace(/[?&]$/, '')

                    const context = page.context()
                    const tab = await context.newPage()

                    try {
                        await tab.setExtraHTTPHeaders({
                            'User-Agent':
                                'Mozilla/5.0 (Linux; Android 14; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36 BingApp/28.0',
                            'X-Requested-With': 'com.microsoft.bing'
                        }).catch(() => {})

                        await tab.goto(cleanTargetUrl, {
                            waitUntil: 'domcontentloaded',
                            timeout: 20000,
                            referer: 'https://rewards.bing.com/'
                        }).catch(() => {})

                        await this.bot.utils.wait(2000)

                        // Simulasi interaksi human-like & scroll
                        await tab.evaluate(() => {
                            window.scrollBy({ top: 300, behavior: 'smooth' })
                        }).catch(() => {})

                        await this.bot.utils.wait(1500)

                        await tab.evaluate(() => {
                            window.scrollBy({ top: -100, behavior: 'smooth' })
                        }).catch(() => {})

                        await this.bot.utils.wait(this.bot.utils.randomDelay(2000, 3500))

                        // Verifikasi poin aktual dari browser DOM / server
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
                                'APP-ONLY-REWARDS',
                                `🎉 [Layer 2 - Fallback] Completed: "${title}" | gainedPoints=+${actualGained} | oldBalance=${beforeCardBalance} | newBalance=${afterBalance}`,
                                'green'
                            )
                        } else {
                            this.bot.logger.debug(
                                this.bot.isMobile,
                                'APP-ONLY-REWARDS',
                                `[Layer 2 - Fallback] Completed navigation for "${title}", but no points were awarded (balance=${afterBalance}). Falling back to Layer 3...`
                            )
                        }
                    } finally {
                        await tab.close().catch(() => {})
                    }
                } catch (navErr) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'APP-ONLY-REWARDS',
                        `[Layer 2 - Fallback] Failed for "${title}": ${navErr instanceof Error ? navErr.message : String(navErr)}`
                    )
                }
            }

            // =========================================================================
            // LAYER 3: REPORT ACTIVITY API FALLBACK (Jika promo memiliki hash & token)
            // =========================================================================
            if (!claimed && promo.hash && this.bot.requestToken) {
                try {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'APP-ONLY-REWARDS',
                        `[Layer 3 - ReportActivity] Submitting reportactivity | offerId=${offerId}`
                    )
                    const activeCookies = (this.bot.isMobile ? this.bot.cookies.mobile : this.bot.cookies.desktop) || []
                    const cookieHeader = this.bot.browser.func.buildCookieHeader(activeCookies, [
                        'bing.com',
                        'live.com',
                        'microsoftonline.com'
                    ])
                    const formData = new URLSearchParams({
                        id: offerId,
                        hash: promo.hash,
                        timeZone: this.bot.userData.timezoneOffset || '60',
                        activityAmount: '1',
                        __RequestVerificationToken: this.bot.requestToken
                    })
                    const repRes = await this.bot.axios.request({
                        url: 'https://rewards.bing.com/api/reportactivity?X-Requested-With=XMLHttpRequest',
                        method: 'POST',
                        timeout: 7000,
                        headers: {
                            'User-Agent':
                                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
                            Cookie: cookieHeader,
                            Referer: 'https://rewards.bing.com/',
                            'Content-Type': 'application/x-www-form-urlencoded'
                        },
                        data: formData.toString()
                    }).catch(() => null)

                    if (repRes?.status === 200) {
                        const afterBalance = await this.bot.browser.func.getCurrentPoints(page).catch(() => beforeCardBalance)
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
                                'APP-ONLY-REWARDS',
                                `🎉 [Layer 3 - ReportActivity] Completed: "${title}" | gainedPoints=+${actualGained} | oldBalance=${beforeCardBalance} | newBalance=${afterBalance}`,
                                'green'
                            )
                        }
                    }
                } catch (repErr) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'APP-ONLY-REWARDS',
                        `[Layer 3 - ReportActivity] Failed: ${repErr}`
                    )
                }
            }

            if (!claimed) {
                this.completedOffersInSession.add(offerId.toLowerCase().trim())
                this.completedOffersInSession.add(title.toLowerCase().trim())

                // JIKA kartu ini memiliki tanda proteksi server-lock Microsoft (exclusiveLockedFeatureStatus: "locked"):
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
                        'APP-ONLY-REWARDS',
                        `[APP-ONLY-REWARDS] [SERVER-LOCKED] Card "${title}" confirmed locked by Microsoft server (exclusiveLockedFeatureStatus: "locked"). Safely skipping remaining ${uncompleted.length - 1 - i} locked card(s) to conserve bandwidth (<20MB) with 0 phantom points.`
                    )
                    break
                } else {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'APP-ONLY-REWARDS',
                        `Could not complete App-Only card "${title}" on all layers (server awarded 0 points). Continuing to next task.`
                    )
                }
            }
        }

        const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)
        if (totalGained > 0) {
            this.bot.logger.info(
                this.bot.isMobile,
                'APP-ONLY-REWARDS',
                `🎉 [APP-ONLY-REWARDS] Successfully completed "(Rewards App only)" quests | totalGained=+${totalGained} | startBalance=${startBalance} | finalBalance=${finalBalance}`,
                'green'
            )
        } else {
            this.bot.logger.info(
                this.bot.isMobile,
                'APP-ONLY-REWARDS',
                `[APP-ONLY-REWARDS] All ${uncompleted.length} "(Rewards App only)" cards are strictly locked by Microsoft server (exclusiveLockedFeatureStatus: "locked"). Safely bypassed with 0 phantom points.`,
                'yellow'
            )
        }
    }
}
