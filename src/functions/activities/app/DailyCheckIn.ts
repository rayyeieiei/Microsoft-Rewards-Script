import type { AxiosRequestConfig } from 'axios'
import { randomUUID } from 'crypto'
import { Workers } from '../../Workers'
import { Database } from '../../../util/Database'
import { UserAgentManager } from '../../../browser/UserAgent'

export class DailyCheckIn extends Workers {
    private oldBalance: number = this.bot.userData.currentPoints

    public resolveCountry(): string {
        const accountGeo = (this.bot.activeAccount?.geoLocale || '').trim()
        const userGeo = (this.bot.userData?.geoLocale || '').trim()
        const configLocale = String(
            (this.bot.config as any)?.locale || (this.bot.config as any)?.geoLocale || ''
        ).trim()

        if (accountGeo && accountGeo.toLowerCase() !== 'auto') {
            if (accountGeo.toLowerCase() === 'id' || accountGeo.toLowerCase().startsWith('id-')) {
                return 'ID'
            }
            return accountGeo.toUpperCase()
        }

        if (configLocale && configLocale.toLowerCase() !== 'auto') {
            if (configLocale.toLowerCase().includes('id')) {
                return 'ID'
            }
        }

        if (userGeo && userGeo.toLowerCase() !== 'auto' && userGeo.toUpperCase() !== 'US') {
            if (userGeo.toLowerCase() === 'id' || userGeo.toLowerCase().startsWith('id-')) {
                return 'ID'
            }
            return userGeo.toUpperCase()
        }

        return 'ID'
    }

    public async doDailyCheckIn() {
        if (!this.bot.accessToken) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                'Skipping: App access token not available, this activity requires it!'
            )
            return
        }

        const country = this.resolveCountry()
        this.bot.userData.geoLocale = country

        try {
            let expectedPoints = 0
            try {
                const appEarnable = await this.bot.browser.func.getAppEarnablePoints()
                if (appEarnable && appEarnable.checkIn > 0) {
                    expectedPoints = appEarnable.checkIn
                }
            } catch {}

            this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)

            this.bot.logger.info(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Starting Daily Check-In | geo=${country} | currentPoints=${this.oldBalance}`
            )

            // Helper to check if already claimed
            const isAlreadyClaimed = (res: any) => {
                if (!res) return false
                const bodyStr = JSON.stringify(res.data || '').toLowerCase()
                return (
                    bodyStr.includes('already') ||
                    bodyStr.includes('duplicate') ||
                    bodyStr.includes('claimed') ||
                    bodyStr.includes('processed') ||
                    bodyStr.includes('completed')
                )
            }

            // Try type 101 first
            this.bot.logger.debug(this.bot.isMobile, 'DAILY-CHECK-IN', 'Attempting Daily Check-In | type=101')

            let response = await this.submitDaily(101)
            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Received Daily Check-In response | type=101 | status=${response?.status ?? 'unknown'}`
            )

            let isSuccess = response?.status === 200
            let alreadyClaimed = isAlreadyClaimed(response)

            if (!isSuccess && !alreadyClaimed) {
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Type 101 did not return success status | retryingWithType=103`
                )

                // Fallback to type 103
                response = await this.submitDaily(103)
                this.bot.logger.debug(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Received Daily Check-In response | type=103 | status=${response?.status ?? 'unknown'}`
                )

                isSuccess = response?.status === 200
                alreadyClaimed = isAlreadyClaimed(response)
            }

            if (isSuccess) {
                const rawServerBalance = Number(response?.data?.response?.balance ?? 0)
                const gainedCheckInPoints =
                    this.oldBalance > 0 && rawServerBalance >= this.oldBalance
                        ? rawServerBalance - this.oldBalance
                        : expectedPoints > 0
                          ? expectedPoints
                          : 10

                if (!this.bot.userData.initialPoints || this.bot.userData.initialPoints <= 0) {
                    if (rawServerBalance > 0) {
                        this.bot.userData.initialPoints = Math.max(0, rawServerBalance - gainedCheckInPoints)
                        this.oldBalance = this.bot.userData.initialPoints
                    } else if (this.oldBalance > 0) {
                        this.bot.userData.initialPoints = this.oldBalance
                    }
                }

                const gained = gainedCheckInPoints
                const newBal =
                    rawServerBalance > 0
                        ? Math.max(rawServerBalance, this.oldBalance + gained)
                        : Number(this.bot.userData.currentPoints ?? this.oldBalance) + gained
                this.bot.userData.currentPoints = newBal
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained

                if (gained > 0) {
                    void Database.getInstance().recordActivity(
                        this.bot.activeAccount?.email || '',
                        'DAILY_CHECK_IN',
                        gained
                    )
                }

                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Completed Daily Check-In | gainedPoints=+${gained} | oldBalance=${this.oldBalance} | newBalance=${newBal}`,
                    'green'
                )
            } else if (alreadyClaimed) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    'Daily Check-In already completed for today! Skipping.',
                    'green'
                )
            } else {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'DAILY-CHECK-IN',
                    `Daily Check-In finished with status=${response?.status ?? 'unknown'} | currentBalance=${this.oldBalance}`
                )
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Error during Daily Check-In | message=${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async submitDaily(type: number) {
        try {
            const country = this.resolveCountry()
            const jsonData = {
                id: randomUUID(),
                amount: 1,
                type: type,
                attributes: {
                    offerid: 'Gamification_Sapphire_DailyCheckIn'
                },
                country: country
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Preparing Daily Check-In payload | type=${type} | id=${jsonData.id} | amount=${jsonData.amount} | country=${jsonData.country}`
            )

            const request: AxiosRequestConfig = {
                url: 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities',
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this.bot.accessToken}`,
                    'User-Agent':
                        this.bot.accountScope?.deviceProfile?.userAgent || UserAgentManager.DEFAULT_MOBILE_UA,
                    'Content-Type': 'application/json',
                    'X-Rewards-Country': country,
                    'X-Rewards-Language': 'en',
                    'X-Rewards-ismobile': 'true'
                },
                data: JSON.stringify(jsonData),
                validateStatus: () => true
            }

            this.bot.logger.debug(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Sending Daily Check-In request | type=${type} | url=${request.url}`
            )

            let response = await this.bot.axios.request(request).catch(err => err?.response || null)
            if (response?.status === 401) {
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'DAPI-AUTH',
                    `⚠️ [DAPI-AUTH] Token kedaluwarsa (401) pada Daily Check-In. Meminta refresh token seluler baru...`
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
            return response
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                `Error in submitDaily | type=${type} | message=${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
}
