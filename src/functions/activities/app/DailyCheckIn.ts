import type { AxiosRequestConfig } from 'axios'
import { randomUUID } from 'crypto'
import { Workers } from '../../Workers'
import { Database } from '../../../util/Database'
import { UserAgentManager } from '../../../browser/UserAgent'

export class DailyCheckIn extends Workers {
    private oldBalance: number = this.bot.userData.currentPoints

    public async doDailyCheckIn() {
        if (!this.bot.accessToken) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'DAILY-CHECK-IN',
                'Skipping: App access token not available, this activity requires it!'
            )
            return
        }

        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)

        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-CHECK-IN',
            `Starting Daily Check-In | geo=${this.bot.userData.geoLocale} | currentPoints=${this.oldBalance}`
        )

        try {
            let expectedPoints = 0
            try {
                const appEarnable = await this.bot.browser.func.getAppEarnablePoints()
                if (appEarnable && appEarnable.checkIn > 0) {
                    expectedPoints = appEarnable.checkIn
                }
            } catch {}

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
                const gained = expectedPoints > 0 ? expectedPoints : (rawServerBalance > this.oldBalance ? (rawServerBalance - this.oldBalance) : 10)
                const newBal = Number(this.bot.userData.currentPoints ?? this.oldBalance) + gained
                this.bot.userData.currentPoints = newBal
                this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + gained

                void Database.getInstance().recordActivity(
                    this.bot.activeAccount?.email || '',
                    'DAILY_CHECK_IN',
                    gained
                )

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
            const jsonData = {
                id: randomUUID(),
                amount: 1,
                type: type,
                attributes: {
                    offerid: 'Gamification_Sapphire_DailyCheckIn'
                },
                country: this.bot.userData.geoLocale
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
                    'User-Agent': UserAgentManager.DEFAULT_MOBILE_UA,
                    'Content-Type': 'application/json',
                    'X-Rewards-Country': this.bot.userData.geoLocale,
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

            return this.bot.axios.request(request)
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
