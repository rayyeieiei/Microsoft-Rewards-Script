import type { AxiosRequestConfig } from 'axios'
import { randomBytes } from 'crypto'
import { Workers } from '../../Workers'
import { Database } from '../../../util/Database'
import { UserAgentManager } from '../../../browser/UserAgent'

export class ReadToEarn extends Workers {
    private getMobileUserAgent(): string {
        return (
            this.bot.accountScope?.deviceProfile?.device?.userAgent ||
            UserAgentManager.DEFAULT_MOBILE_UA
        )
    }

    private async fetchValidMsnArticles(count: number): Promise<string[]> {
        const market = (this.bot.userData.geoLocale || 'ID').toLowerCase()
        const marketParam = market === 'id' ? 'id-id' : market === 'us' ? 'en-us' : `en-${market}`
        const endpoints = [
            `https://assets.msn.com/service/news/feed/pages/binghp?apikey=0QfOX3Vn51YCzitbLaRkTTBadtWpgTN8NZLW0C1SEM&market=${marketParam}`,
            `https://assets.msn.com/service/news/feed/pages/selected?apikey=0QfOX3Vn51YCzitbLaRkTTBadtWpgTN8NZLW0C1SEM&market=${marketParam}`
        ]

        for (const url of endpoints) {
            try {
                const res = await this.bot.axios.request({
                    url,
                    method: 'GET',
                    headers: {
                        'User-Agent': this.getMobileUserAgent(),
                        Accept: 'application/json'
                    }
                })

                if (res?.data) {
                    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data
                    const articleIds: string[] = []

                    for (const section of data.sections || []) {
                        for (const card of section.cards || []) {
                            if (card.id && typeof card.id === 'string') {
                                articleIds.push(card.id)
                            }
                            for (const subCard of card.subCards || []) {
                                if (subCard.id && typeof subCard.id === 'string') {
                                    articleIds.push(subCard.id)
                                }
                            }
                        }
                    }

                    if (articleIds.length > 0) {
                        return Array.from(new Set(articleIds)).slice(0, count)
                    }
                }
            } catch (err) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Failed to fetch articles from MSN feed: ${err instanceof Error ? err.message : String(err)}`
                )
            }
        }

        return []
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

        const geoCountry = (this.bot.userData.geoLocale || 'ID').toUpperCase()
        this.bot.logger.info(
            this.bot.isMobile,
            'READ-TO-EARN',
            `Starting Read to Earn | geo=${geoCountry} | delayRange=${delayMin}-${delayMax} | currentPoints=${startBalance}`
        )

        try {
            let remainingQuota = 30
            try {
                const appEarnable = await this.bot.browser.func.getAppEarnablePoints()
                if (appEarnable && typeof appEarnable.readToEarn === 'number') {
                    if (appEarnable.readToEarn === 0) {
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'READ-TO-EARN',
                            'All Read to Earn points already completed for today (30/30 pts)! Skipping.',
                            'green'
                        )
                        return
                    }
                    remainingQuota = appEarnable.readToEarn
                } else {
                    // Fallback progress bernilai 0 saat objek aktivitas undefined (remaining 30 - 0 = 30)
                    remainingQuota = 30
                }
            } catch {
                // Fallback progress bernilai 0 saat objek aktivitas undefined
                remainingQuota = 30
            }

            const jsonData = {
                amount: 1,
                id: '1',
                type: 101,
                attributes: {
                    offerid: 'ENUS_readarticle3_30points'
                },
                country: geoCountry
            }

            const articleCount = Math.min(10, Math.ceil(remainingQuota / 3))
            const validArticleIds = await this.fetchValidMsnArticles(Math.max(30, articleCount * 3))
            let totalGained = 0
            let articlesRead = 0
            let attemptIndex = 0
            const maxAttempts = 30

            while (articlesRead < articleCount && attemptIndex < maxAttempts) {
                const articleId = validArticleIds[attemptIndex] || randomBytes(16).toString('hex')
                attemptIndex++
                jsonData.id = articleId

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Submitting Read to Earn activity | article=${articlesRead + 1}/${articleCount} | id=${jsonData.id} | country=${jsonData.country}`
                )

                const request: AxiosRequestConfig = {
                    url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.bot.accessToken}`,
                        'User-Agent': this.getMobileUserAgent(),
                        'Content-Type': 'application/json',
                        'X-Rewards-Country': geoCountry,
                        'X-Rewards-Language': 'en',
                        'X-Rewards-ismobile': 'true'
                    },
                    data: JSON.stringify(jsonData)
                }

                let response: any = null
                try {
                    response = await this.bot.axios.request(request)
                } catch (reqErr: any) {
                    const status = reqErr?.response?.status
                    if (status === 401 || status === 400) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'READ-TO-EARN',
                            `[INVALID-ARTICLE] API returned status ${status} for article "${articleId}" (${reqErr?.message || reqErr}). Marking article as invalid, continuing to next article...`
                        )
                    } else {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'READ-TO-EARN',
                            `Request failed for article ${articlesRead + 1}/${articleCount} (${reqErr?.message || reqErr}), skipping to next article...`
                        )
                    }
                    continue
                }

                this.bot.logger.debug(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Received Read to Earn response | article=${articlesRead + 1}/${articleCount} | status=${response?.status ?? 'unknown'}`
                )

                const isSuccess = response?.status === 200

                if (!isSuccess) {
                    const status = response?.status
                    if (status === 401 || status === 400) {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'READ-TO-EARN',
                            `[INVALID-ARTICLE] API returned status ${status} for article "${articleId}". Marking article as invalid, continuing to next article...`
                        )
                    } else {
                        this.bot.logger.warn(
                            this.bot.isMobile,
                            'READ-TO-EARN',
                            `API returned non-200 status (${status}) for article ${articlesRead + 1}/${articleCount}, skipping to next article...`
                        )
                    }
                    continue
                }

                articlesRead++
                const gainedPoints = 3
                this.bot.userData.currentPoints = Number(this.bot.userData.currentPoints ?? 0) + gainedPoints
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gainedPoints
                totalGained += gainedPoints

                void Database.getInstance().recordActivity(
                    this.bot.activeAccount?.email || '',
                    'READ_TO_EARN',
                    gainedPoints
                )

                this.bot.logger.info(
                    this.bot.isMobile,
                    'READ-TO-EARN',
                    `Read article ${articlesRead}/${articleCount} | status=${response.status} | gainedPoints=+${gainedPoints} | newBalance=${this.bot.userData.currentPoints}`,
                    'green'
                )

                // Wait random delay between articles
                if (articlesRead < articleCount) {
                    this.bot.logger.debug(
                        this.bot.isMobile,
                        'READ-TO-EARN',
                        `Waiting between articles | article=${articlesRead}/${articleCount} | delayRange=${delayMin}-${delayMax}`
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
