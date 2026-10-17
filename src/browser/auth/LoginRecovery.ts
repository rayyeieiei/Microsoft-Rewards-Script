import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../index'
import { getErrorMessage, promptInput } from './methods/LoginUtils'

export class RecoveryLogin {
    private readonly textInputSelector = [
        'input[type="email"]',
        'input[type="text"]:not([readonly])',
        '#proof-confirmation-text-input',
        '#otcProofInput'
    ].join(', ')
    private readonly maxManualSeconds = 60
    private readonly maxManualAttempts = 5

    constructor(private bot: MicrosoftRewardsBot) {}

    private async selectProofOption(page: Page, recoveryEmail: string): Promise<void> {
        try {
            // Periksa keberadaan radio button pilihan pembuktian identitas
            const radioLocator = page.locator('input[type="radio"], [role="radio"], [data-testid*="radio" i]')
            const count = await radioLocator.count().catch(() => 0)
            if (count > 0) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    `Found ${count} identity proof radio option(s). Selecting appropriate option...`
                )

                // Cari elemen radio yang memiliki atribut value/label cocok dengan domain recovery email (misal: "fviainboxes.com" atau "Email")
                let selectedRadio = page.locator('input[type="radio"], [role="radio"]').first()
                const domain = recoveryEmail && recoveryEmail.includes('@') ? recoveryEmail.split('@')[1] : ''

                for (let i = 0; i < count; i++) {
                    const candidate = radioLocator.nth(i)
                    const val = (await candidate.getAttribute('value').catch(() => '')) || ''
                    const ariaLabel = (await candidate.getAttribute('aria-label').catch(() => '')) || ''
                    const parentText = await candidate.locator('..').innerText().catch(() => '')
                    const combined = `${val} ${ariaLabel} ${parentText}`.toLowerCase()

                    if ((domain && combined.includes(domain.toLowerCase())) || combined.includes('email')) {
                        selectedRadio = candidate
                        this.bot.logger.info(
                            this.bot.isMobile,
                            'LOGIN-RECOVERY',
                            `Matched recovery radio option by domain/email criteria: "${combined.slice(0, 40)}"`
                        )
                        break
                    }
                }

                // Klik radio button tersebut
                await selectedRadio.click({ timeout: 3000 }).catch(async () => {
                    await selectedRadio.check({ timeout: 3000 }).catch(() => {})
                })
                await this.bot.utils.wait(1000)

                // Klik tombol konfirmasi pengiriman kode jika ada
                const textInputLocator = page.locator(this.textInputSelector).first()
                const isTextInputVisible = await textInputLocator.isVisible().catch(() => false)

                if (!isTextInputVisible) {
                    const confirmBtn = page
                        .locator('input[type="submit"], #idSIButton9, button:has-text("Next"), button:has-text("Berikutnya")')
                        .first()
                    if (await confirmBtn.count() > 0 && await confirmBtn.isVisible().catch(() => false)) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Clicking confirmation/Next button after radio selection...')
                        await confirmBtn.click({ timeout: 3000 }).catch(() => {})
                        await this.bot.utils.wait(1500)
                    }
                }
            }
        } catch (err) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-RECOVERY',
                `Error during identity proof radio selection: ${err instanceof Error ? err.message : String(err)}`
            )
        }
    }

    private async fillEmail(page: Page, email: string): Promise<boolean> {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', `Attempting to fill email: ${email}`)

            // 1. Periksa keberadaan radio button pilihan pembuktian identitas & pilih opsi jika ada
            await this.selectProofOption(page, email)

            // 2. Tunggu kemunculan text input asli
            const textInput = page.locator(this.textInputSelector).first()
            const isVisible = await textInput
                .waitFor({ state: 'visible', timeout: 5000 })
                .then(() => true)
                .catch(() => false)

            if (isVisible) {
                const inputType = (await textInput.getAttribute('type').catch(() => '')) || ''
                if (inputType === 'radio' || inputType === 'checkbox') {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN-RECOVERY', 'Target element is a radio/checkbox, refusing .fill()')
                    return false
                }

                // Baru lakukan textInput.fill()
                await textInput.click().catch(() => {})
                await textInput.fill(email)
                await this.bot.utils.wait(500)
                await page.keyboard.press('Enter')

                // Fallback: Klik tombol konfirmasi kirim kode jika ada
                const submitBtn = page
                    .locator('button[type="submit"], input[type="submit"], #idSubmitButton, #idSIButton9, button:has-text("Send code"), button:has-text("Next"), button:has-text("Kirim kode")')
                    .first()
                if (await submitBtn.count() > 0 && await submitBtn.isVisible().catch(() => false)) {
                    await submitBtn.click().catch(() => {})
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Successfully filled email input field')
                return true
            }

            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-RECOVERY',
                `Email input field not found with selector: ${this.textInputSelector}`
            )
            return false
        } catch (error) {
            this.bot.logger.warn(
                this.bot.isMobile,
                'LOGIN-RECOVERY',
                `Failed to fill email input: ${error instanceof Error ? error.message : String(error)}`
            )
            return false
        }
    }

    async handle(page: Page, recoveryEmail: string): Promise<void> {
        try {
            this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Email recovery authentication flow initiated')

            if (recoveryEmail) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    `Using provided recovery email: ${recoveryEmail}`
                )

                const filled = await this.fillEmail(page, recoveryEmail)
                if (!filled) {
                    throw new Error('Email input field not found')
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Waiting for page response')
                await this.bot.utils.wait(500)
                await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', 'DOM content loaded timeout reached')
                })

                const errorMessage = await getErrorMessage(page)
                if (errorMessage) {
                    throw new Error(`Email verification failed: ${errorMessage}`)
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Email authentication completed successfully')
                return
            }

            this.bot.logger.info(
                this.bot.isMobile,
                'LOGIN-RECOVERY',
                'No recovery email provided, will prompt user for input'
            )

            for (let attempt = 1; attempt <= this.maxManualAttempts; attempt++) {
                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    `Starting attempt ${attempt}/${this.maxManualAttempts}`
                )

                this.bot.logger.info(
                    this.bot.isMobile,
                    'LOGIN-RECOVERY',
                    `Prompting user for email input (timeout: ${this.maxManualSeconds}s)`
                )

                const email = await promptInput({
                    question: `Recovery email (waiting ${this.maxManualSeconds}s): `,
                    timeoutSeconds: this.maxManualSeconds,
                    validate: email => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
                })

                if (!email) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `No or invalid email input received (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Manual email input failed: no input received')
                    }
                    continue
                }

                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `Invalid email format received (attempt ${attempt}/${this.maxManualAttempts}) | length=${email.length}`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Manual email input failed: invalid format')
                    }
                    continue
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', `Valid email received from user: ${email}`)

                const filled = await this.fillEmail(page, email)
                if (!filled) {
                    this.bot.logger.error(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `Failed to fill email input field (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error('Email input field not found after maximum attempts')
                    }

                    await this.bot.utils.wait(1000)
                    continue
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Waiting for page response')
                await this.bot.utils.wait(500)
                await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {
                    this.bot.logger.debug(this.bot.isMobile, 'LOGIN-RECOVERY', 'DOM content loaded timeout reached')
                })

                const errorMessage = await getErrorMessage(page)
                if (errorMessage) {
                    this.bot.logger.warn(
                        this.bot.isMobile,
                        'LOGIN-RECOVERY',
                        `Error from page: "${errorMessage}" (attempt ${attempt}/${this.maxManualAttempts})`
                    )

                    if (attempt === this.maxManualAttempts) {
                        throw new Error(`Manual email verification failed: ${errorMessage}`)
                    }

                    await this.bot.utils.wait(1000)
                    continue
                }

                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Manual email authentication completed successfully')
                return
            }
        } catch (error) {
            this.bot.logger.error(
                this.bot.isMobile,
                'LOGIN-RECOVERY',
                `Authentication failed: ${error instanceof Error ? error.message : String(error)}`
            )
            throw error
        }
    }
}

export { RecoveryLogin as LoginRecovery }
