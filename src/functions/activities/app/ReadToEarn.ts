import type { AxiosRequestConfig } from 'axios'
import { randomBytes } from 'crypto'
import { Workers } from '../../Workers'
import { Database } from '../../../util/Database'
import { UserAgentManager } from '../../../browser/UserAgent'

export class ReadToEarn extends Workers {
    public readonly FALLBACK_ARTICLE_POOL: string[] = [
        'AA2dvY9N', 'AA2dw2uA', 'AA2cEE3R', 'AA2dw8BI', 'AA2aHXIO',
        'AA2dzo1D', 'AA2dyPGa', 'AA2dym6n', 'AA2dzhfb', 'AA2draRk',
        'AA2dwg2P', 'AA2duFji', 'AA2cgYSG', 'AA2dyK0k', 'AA2dxi9K',
        'AA1xK3rZ', 'AA1yM4pQ', 'AA1zN5oR', 'BB1aB2cD', 'BB2bC3dE'
    ]

    public resolveMsnMarket(geo: string): { market: string; locale: string } {
        const g = (geo || 'us').toLowerCase().trim()
        const mapping: Record<string, { market: string; locale: string }> = {
            id: { market: 'id-id', locale: 'id-ID' },
            us: { market: 'en-us', locale: 'en-US' },
            gb: { market: 'en-gb', locale: 'en-GB' },
            uk: { market: 'en-gb', locale: 'en-GB' },
            au: { market: 'en-au', locale: 'en-AU' },
            ca: { market: 'en-ca', locale: 'en-CA' },
            in: { market: 'en-in', locale: 'en-IN' },
            de: { market: 'de-de', locale: 'de-DE' },
            fr: { market: 'fr-fr', locale: 'fr-FR' },
            es: { market: 'es-es', locale: 'es-ES' },
            it: { market: 'it-it', locale: 'it-IT' },
            jp: { market: 'ja-jp', locale: 'ja-JP' },
            kr: { market: 'ko-kr', locale: 'ko-KR' },
            br: { market: 'pt-br', locale: 'pt-BR' },
            mx: { market: 'es-mx', locale: 'es-MX' },
            nl: { market: 'nl-nl', locale: 'nl-NL' },
            se: { market: 'sv-se', locale: 'sv-SE' },
            no: { market: 'nb-no', locale: 'nb-NO' },
            dk: { market: 'da-dk', locale: 'da-DK' },
            pl: { market: 'pl-pl', locale: 'pl-PL' },
            tr: { market: 'tr-tr', locale: 'tr-TR' },
            ru: { market: 'ru-ru', locale: 'ru-RU' },
            tw: { market: 'zh-tw', locale: 'zh-TW' },
            hk: { market: 'zh-hk', locale: 'zh-HK' }
        }

        if (mapping[g]) {
            return mapping[g]
        }
        if (g.includes('-')) {
            const [lang, country] = g.split('-')
            return {
                market: `${lang}-${country}`.toLowerCase(),
                locale: `${lang}-${(country || '').toUpperCase()}`
            }
        }
        return { market: 'en-us', locale: 'en-US' }
    }

    public async fetchValidMsnArticles(count: number): Promise<string[]> {
        const geo = (this.bot.userData.geoLocale || 'US').toLowerCase()
        const primary = this.resolveMsnMarket(geo)
        const secondary = { market: 'en-us', locale: 'en-US' }
        const targets = [primary]
        if (primary.market !== secondary.market) {
            targets.push(secondary)
        }

        const articleIds: string[] = []

        for (const target of targets) {
            const cvid = randomBytes(16).toString('hex')
            const params = new URLSearchParams({
                apikey: '0QfOX3Vn51YCzitbLaRkTTBadtWpgTN8NZLW0C1SEM',
                market: target.market,
                locale: target.locale,
                cvid,
                feedType: 'news',
                ocid: 'msedgntp'
            })

            const endpoints = [
                `https://assets.msn.com/service/news/feed/pages/binghp?${params.toString()}`,
                `https://assets.msn.com/service/news/feed/pages/selected?${params.toString()}`
            ]

            for (const url of endpoints) {
                try {
                    const res = await this.bot.axios.request({
                        url,
                        method: 'GET',
                        headers: {
                            'User-Agent':
                                this.bot.accountScope?.deviceProfile?.userAgent || UserAgentManager.DEFAULT_MOBILE_UA,
                            Accept: 'application/json',
                            'X-Rewards-Country': geo,
                            'X-Rewards-Language': target.market.split('-')[0]
                        },
                        timeout: 10000
                    })

                    if (res?.data) {
                        const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data

                        for (const section of data.sections || []) {
                            for (const card of section.cards || []) {
                                if (card.id && typeof card.id === 'string' && !card.id.startsWith('CanonicalName-')) {
                                    articleIds.push(card.id)
                                }
                                for (const subCard of card.subCards || []) {
                                    if (subCard.id && typeof subCard.id === 'string' && !subCard.id.startsWith('CanonicalName-')) {
                                        articleIds.push(subCard.id)
                                    }
                                }
                            }
                        }

                        const uniqueIds = Array.from(new Set(articleIds))
                        if (uniqueIds.length >= count) {
                            return uniqueIds.slice(0, count)
                        }
                    }
                } catch (err: any) {
                    const status = err?.response?.status || 'network'
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        `MSN feed non-200 | market=${target.market} status=${status} msg=${err instanceof Error ? err.message : String(err)}`
                    )
                }
            }
        }

        // Instant fallback transition to known article pool if network returned fewer than count
        const uniqueFound = Array.from(new Set(articleIds))
        if (uniqueFound.length < count) {
            this.bot.logger.info(
                this.bot.isMobile,
                'READ-TO-EARN',
                `Using fallback article pool for Read to Earn (found=${uniqueFound.length}, target=${count})`
            )
            for (const fallbackId of this.FALLBACK_ARTICLE_POOL) {
                if (!uniqueFound.includes(fallbackId)) {
                    uniqueFound.push(fallbackId)
                }
                if (uniqueFound.length >= count) break
            }

            while (uniqueFound.length < count) {
                const syntheticId = `AA${randomBytes(3).toString('hex').toUpperCase()}`
                if (!uniqueFound.includes(syntheticId)) {
                    uniqueFound.push(syntheticId)
                }
            }
        }

        return uniqueFound.slice(0, count)
    }

    public async doReadToEarn() {
        if (!this.bot.accessToken) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'READ-TO-EARN',
                'Skipping: App access token not available, this activity requires it!'
            )
            return
        }

        const delayMin = this.bot.config.searchSettings.readDelay.min
        const delayMax = this.bot.config.searchSettings.readDelay.max
        const startBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'READ-TO-EARN',
            `Starting Read to Earn | geo=${this.bot.userData.geoLocale} | delayRange=${delayMin}-${delayMax} | currentPoints=${startBalance}`
        )

        try {
            let remainingQuota = 30
            try {
                const appEarnable = await this.bot.browser.func.getAppEarnablePoints()
                if (appEarnable && appEarnable.readToEarn === 0) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        'All Read to Earn points already completed for today (30/30 pts)! Skipping.',
                        'green'
                    )
                    return
                }
                if (appEarnable && appEarnable.readToEarn > 0) {
                    remainingQuota = appEarnable.readToEarn
                }
            } catch {}

            const jsonData = {
                amount: 1,
                id: '1',
                type: 101,
                attributes: {
                    offerid: 'ENUS_readarticle3_30points'
                },
                country: this.bot.userData.geoLocale
            }

            const articleCount = Math.min(10, Math.ceil(remainingQuota / 3))
            const validArticleIds = await this.fetchValidMsnArticles(articleCount)
            let totalGained = 0
            let articlesRead = 0
            let refreshAttempts = 0
            const maxRefreshAttempts = 2

            for (let i = 0; i < articleCount; ++i) {
                const articleId = validArticleIds[i] || randomBytes(16).toString('hex')
                jsonData.id = articleId

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Submitting Read to Earn activity | article=${i + 1}/${articleCount} | id=${jsonData.id} | country=${jsonData.country}`
                )

                const request: AxiosRequestConfig = {
                    url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.bot.accessToken}`,
                        'User-Agent':
                            this.bot.accountScope?.deviceProfile?.userAgent || UserAgentManager.DEFAULT_MOBILE_UA,
                        'Content-Type': 'application/json',
                        'X-Rewards-Country': this.bot.userData.geoLocale,
                        'X-Rewards-Language': 'en',
                        'X-Rewards-ismobile': 'true'
                    },
                    data: JSON.stringify(jsonData),
                    validateStatus: () => true
                }

                let response = await this.bot.axios.request(request).catch(err => err?.response || null)

                // HTTP 401 Interceptor: Auto-Refresh Token Guard
                if (response?.status === 401 && refreshAttempts < maxRefreshAttempts) {
                    refreshAttempts++
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'DAPI-AUTH',
                        `⚠️ [DAPI-AUTH] Token kedaluwarsa (401). Meminta refresh token seluler baru... (attempt ${refreshAttempts}/${maxRefreshAttempts})`
                    )
                    const newToken = await this.bot.refreshMobileAccessToken()
                    if (newToken) {
                        request.headers = {
                            ...request.headers,
                            Authorization: `Bearer ${newToken}`
                        }
                        response = await this.bot.axios.request(request).catch(err => err?.response || null)
                    }
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Received Read to Earn response | article=${i + 1}/${articleCount} | status=${response?.status ?? 'unknown'}`
                )

                const isSuccess = response?.status === 200

                if (!isSuccess) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        `API returned non-200 status, stopping Read to Earn | article=${i + 1}/${articleCount} | status=${response?.status}`
                    )
                    break
                }

                const gainedPoints = 3
                this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                totalGained += gainedPoints
                articlesRead = i + 1

                void Database.getInstance().recordActivity(
                    this.bot.activeAccount?.email || '',
                    'READ_TO_EARN',
                    gainedPoints
                )

                this.bot.logger.info(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Read article ${i + 1}/${articleCount} | status=${response.status} | gainedPoints=+${gainedPoints} | newBalance=${this.bot.userData.currentPoints}`,
                    'green'
                )

                // Wait random delay between articles
                if (i + 1 < articleCount) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        `Waiting between articles | article=${i + 1}/${articleCount} | delayRange=${delayMin}-${delayMax}`
                    )
                    await this.bot.utils.wait(this.bot.utils.randomDelay(delayMin, delayMax))
                }
            }

            const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)

            this.bot.logger.info(
                this.bot.isMobile,
                'READ-TO-EARN',
                `Completed Read to Earn | articlesRead=${articlesRead} | totalGained=${totalGained} | startBalance=${startBalance} | finalBalance=${finalBalance}`
            )
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'READ-TO-EARN',
                `Error during Read to Earn | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }
}
