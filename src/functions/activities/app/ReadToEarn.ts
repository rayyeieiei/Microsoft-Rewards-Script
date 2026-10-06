import type { AxiosRequestConfig } from 'axios'
import { randomBytes } from 'crypto'
import { Workers } from '../../Workers'
import { Database } from '../../../util/Database'
import { UserAgentManager } from '../../../browser/UserAgent'

export class ReadToEarn extends Workers {
    public get client() {
        return this.bot.axios
    }

    public readonly FALLBACK_ARTICLE_POOL: string[] = [
        'AA2dEf0r', 'AA1U7twx', 'AA2dFbdU', 'AA2dAusx', 'AA2dy6FB',
        'AA2dzP7w', 'AA2dxyZ1', 'AA2dxQv4', 'AA2dvY9N', 'AA2dw2uA',
        'AA2cEE3R', 'AA2dw8BI', 'AA2aHXIO', 'AA2dzo1D', 'AA2dyPGa',
        'AA2dym6n', 'AA2dzhfb', 'AA2draRk', 'AA2dwg2P', 'AA2duFji',
        'AA2cgYSG', 'AA2dyK0k', 'AA2dxi9K', 'AA1uQd6k', 'AA1v48eQ',
        'AA1wF8xN', 'AA1sQ5zL', 'AA1tM2kY', 'AA1pZ9wQ', 'AA1xK3rZ',
        'AA1yM4pQ', 'AA1zN5oR'
    ]

    public isValidArticleCard(card: any): boolean {
        if (!card || typeof card !== 'object') return false
        const id = card.id
        if (!id || typeof id !== 'string' || id.startsWith('CanonicalName-')) return false

        // Filter out ads & sponsored cards
        if (card.isSponsored || card.adId || card.isAd) return false

        const type = String(card.type || '').toLowerCase()
        const format = String(card.format || '').toLowerCase()
        const contentType = String(card.contentType || '').toLowerCase()
        const subType = String(card.subType || '').toLowerCase()

        if (['ad', 'nativead', 'sponsored', 'promoted'].includes(type)) return false

        // Filter out non-text/ineligible formats: video, slideshow, gallery, photo
        const ineligibleTypes = ['video', 'slideshow', 'gallery', 'photo', 'photos', 'livestream']
        if (
            ineligibleTypes.includes(type) ||
            ineligibleTypes.includes(format) ||
            ineligibleTypes.includes(contentType) ||
            ineligibleTypes.includes(subType)
        ) {
            return false
        }

        const url = String(card.url || card.destinationUrl || '').toLowerCase()
        if (url.includes('/video/') || url.includes('/slideshow/') || url.includes('/vi-') || url.includes('/ss-')) {
            return false
        }

        return true
    }

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
                                if (this.isValidArticleCard(card)) {
                                    articleIds.push(card.id)
                                }
                                for (const subCard of card.subCards || []) {
                                    if (this.isValidArticleCard(subCard)) {
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
            const targetArticles = articleCount
            const fetchedArticleIds = await this.fetchValidMsnArticles(Math.max(30, targetArticles * 3))

            // Candidate queue initialized with fetched articles followed by fallback pool, deduplicated
            const candidateQueue: string[] = []
            const seenCandidateIds = new Set<string>()

            for (const id of [...fetchedArticleIds, ...this.FALLBACK_ARTICLE_POOL]) {
                if (id && !seenCandidateIds.has(id)) {
                    seenCandidateIds.add(id)
                    candidateQueue.push(id)
                }
            }

            const ineligibleArticleIds = new Set<string>()
            let totalGained = 0
            let articlesRead = 0
            let refreshAttempts = 0
            const maxRefreshAttempts = 2
            let syntheticAttempts = 0
            const maxSyntheticAttempts = 5

            while (articlesRead < targetArticles && candidateQueue.length > 0) {
                const articleId = candidateQueue.shift()!
                jsonData.id = articleId

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Submitting Read to Earn activity | article=${articlesRead + 1}/${targetArticles} | id=${jsonData.id} | country=${jsonData.country}`
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

                // HTTP 401 Interceptor: Auto-Refresh Token Guard & Retry
                if (response?.status === 401 && refreshAttempts < maxRefreshAttempts) {
                    refreshAttempts++
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'DAPI-AUTH',
                        `⚠️ [DAPI-AUTH] Token kedaluwarsa (401). Meminta refresh token seluler baru... (attempt ${refreshAttempts}/${maxRefreshAttempts})`
                    )
                    const newToken = await this.bot.loginApp.getAppToken()
                    if (newToken) {
                        if (this.client?.defaults?.headers?.common) {
                            this.client.defaults.headers.common['Authorization'] = `Bearer ${newToken}`
                        }
                        request.headers = {
                            ...request.headers,
                            Authorization: `Bearer ${newToken}`
                        }
                        // Ulangi (retry) artikel tersebut 1 kali dengan token baru
                        response = await this.bot.axios.request(request).catch(err => err?.response || null)
                    }
                }

                // Perpetual 401 circuit-breaker when max refresh attempts are exhausted
                if (response?.status === 401 && refreshAttempts >= maxRefreshAttempts) {
                    this.bot.logger.info(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        `API returned non-200 status, stopping Read to Earn | article=${articlesRead + 1}/${targetArticles} | status=${response?.status}`
                    )
                    break
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Received Read to Earn response | article=${articlesRead + 1}/${targetArticles} | status=${response?.status ?? 'unknown'}`
                )

                const isSuccess = response?.status === 200

                // Jika artikel tersebut TETAP gagal (401/400/non-200):
                if (!isSuccess) {
                    const status = response?.status ?? 'unknown'
                    ineligibleArticleIds.add(articleId)
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        `⚠️ [READ-TO-EARN] Artikel ${articleId} tidak memenuhi syarat poin (status ${status}). Melewati ke artikel berikutnya...`
                    )

                    // Jika antrean menipis sebelum target tercapai, tambahkan synthetic ID cadangan
                    if (candidateQueue.length === 0 && articlesRead < targetArticles && syntheticAttempts < maxSyntheticAttempts) {
                        const syntheticId = `AA${randomBytes(3).toString('hex').toUpperCase()}`
                        if (!ineligibleArticleIds.has(syntheticId)) {
                            syntheticAttempts++
                            candidateQueue.push(syntheticId)
                        }
                    }

                    // JANGAN PERNAH menghentikan loop utama (break / return)!
                    // Ambil artikel berikutnya dari candidateQueue dan lanjutkan loop
                    continue
                }

                // Sukses
                refreshAttempts = 0
                const gainedPoints = 3
                this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                totalGained += gainedPoints
                articlesRead++

                void Database.getInstance().recordActivity(
                    this.bot.activeAccount?.email || '',
                    'READ_TO_EARN',
                    gainedPoints
                )

                this.bot.logger.info(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Read article ${articlesRead}/${targetArticles} | status=${response.status} | gainedPoints=+${gainedPoints} | newBalance=${this.bot.userData.currentPoints}`,
                    'green'
                )

                // Wait random delay between articles
                if (articlesRead < targetArticles) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        `Waiting between articles | article=${articlesRead}/${targetArticles} | delayRange=${delayMin}-${delayMax}`
                    )
                    await this.bot.utils.wait(this.bot.utils.randomDelay(delayMin, delayMax))
                }
            }

            const finalBalance = Number(this.bot.userData.currentPoints ?? startBalance)

            this.bot.logger.info(
                this.bot.isMobile,
                'READ-TO-EARN',
                `Completed Read to Earn | articlesRead=${articlesRead}/${targetArticles} | totalGained=${totalGained} | startBalance=${startBalance} | finalBalance=${finalBalance}`
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
