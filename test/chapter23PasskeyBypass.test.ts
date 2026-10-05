import assert from 'assert'
import { chromium, type Page, type Browser } from 'patchright'
import { MobileAccessLogin } from '../src/browser/auth/methods/MobileAccessLogin'
import type { MicrosoftRewardsBot } from '../src/index'

export async function runChapter23PasskeyBypassTests() {
    console.log('\n--- Running Chapter 23 Passkey/FIDO Enrollment Interrupt Bypass Test Suite ---')

    const mockLogs: string[] = []
    const mockBot = {
        isMobile: true,
        logger: {
            info: (_isMobile: any, tag: string, msg: string) => {
                mockLogs.push(`[INFO][${tag}] ${msg}`)
            },
            warn: (_isMobile: any, tag: string, msg: string) => {
                mockLogs.push(`[WARN][${tag}] ${msg}`)
            },
            error: (_isMobile: any, tag: string, msg: string) => {
                mockLogs.push(`[ERROR][${tag}] ${msg}`)
            },
            debug: (_isMobile: any, tag: string, msg: string) => {
                mockLogs.push(`[DEBUG][${tag}] ${msg}`)
            }
        },
        browser: {
            utils: {
                ghostClick: async (_page: Page, _selector: string) => {
                    mockLogs.push(`[GHOST-CLICK] ${_selector}`)
                }
            }
        },
        utils: {
            wait: async (_ms: number) => {}
        }
    } as unknown as MicrosoftRewardsBot

    // Test 1: Bounded OAuth polling timeout (45s instead of 180s)
    {
        const dummyPage = {} as Page
        const mobileLogin = new MobileAccessLogin(mockBot, dummyPage)
        assert.strictEqual(mobileLogin.maxTimeout, 45_000, 'OAuth polling max timeout must be 45,000ms (45s)')
        console.log('✅ Test 1 Passed: OAuth polling timeout successfully reduced to 45s')
    }

    // Test 2: URL interrupt detection logic
    {
        const dummyPage = {} as Page
        const mobileLogin = new MobileAccessLogin(mockBot, dummyPage)

        const positiveUrls = [
            'https://login.microsoft.com/consumers/fido/create',
            'https://login.microsoft.com/consumers/fido/create?client_id=0000000040170455',
            'https://account.live.com/interrupt/passkey/enroll',
            'https://account.live.com/interrupt/passkey/enroll?ru=https%3A%2F%2Flogin.live.com',
            'https://account.live.com/interrupt/passkey',
            'https://account.live.com/passkey/enroll',
            'https://login.live.com/passkey/enroll?mkt=EN-US'
        ]

        for (const u of positiveUrls) {
            assert.strictEqual(
                mobileLogin.isPasskeyInterruptUrl(u),
                true,
                `Expected true for passkey interrupt URL: ${u}`
            )
        }

        const negativeUrls = [
            'https://login.live.com/oauth20_authorize.srf',
            'https://login.live.com/oauth20_desktop.srf?code=M.R3_BAY.12345&state=xyz',
            'https://rewards.bing.com/dashboard',
            'https://login.live.com/ppsecure/post.srf',
            'https://www.bing.com'
        ]

        for (const u of negativeUrls) {
            assert.strictEqual(
                mobileLogin.isPasskeyInterruptUrl(u),
                false,
                `Expected false for normal URL: ${u}`
            )
        }

        console.log('✅ Test 2 Passed: Passkey/FIDO interrupt URL classification accurate for all variants')
    }

    // Test 3: Selector definitions include all required cancel/dismiss buttons
    {
        const dummyPage = {} as Page
        const mobileLogin = new MobileAccessLogin(mockBot, dummyPage)
        const selectors = mobileLogin.passkeyDismissSelectors

        const requiredSubstrings = [
            'button:has-text("Not now")',
            'button:has-text("Lain kali")',
            'button:has-text("Cancel")',
            'button:has-text("Batal")',
            '#idBtn_Back',
            'a:has-text("Skip")',
            '[aria-label*="cancel" i]'
        ]

        for (const req of requiredSubstrings) {
            assert.ok(selectors.includes(req), `passkeyDismissSelectors must contain ${req}`)
        }

        console.log('✅ Test 3 Passed: Passkey dismiss selectors contain all multilingual and role variants')
    }

    // Test 4: Live headless page interaction - clicking dismiss button on interrupt page
    let browser: Browser | null = null
    try {
        browser = await chromium.launch({ headless: true })
        const page = await browser.newPage()
        const mobileLogin = new MobileAccessLogin(mockBot, page)

        const interruptScenarios = [
            {
                url: 'https://login.microsoft.com/consumers/fido/create',
                html: '<div id="container"><button id="cancelBtn">Not now</button></div>',
                expectedClickedText: 'Not now'
            },
            {
                url: 'https://account.live.com/interrupt/passkey/enroll',
                html: '<div id="container"><button id="cancelBtn">Lain kali</button></div>',
                expectedClickedText: 'Lain kali'
            },
            {
                url: 'https://account.live.com/interrupt/passkey',
                html: '<div id="container"><button id="idBtn_Back">Kembali</button></div>',
                expectedClickedText: 'Kembali'
            },
            {
                url: 'https://account.live.com/passkey/enroll',
                html: '<div id="container"><a href="#" id="skipLink">Skip</a></div>',
                expectedClickedText: 'Skip'
            },
            {
                url: 'https://login.microsoft.com/consumers/fido/create',
                html: '<div id="container"><div role="button" aria-label="Cancel registration">X</div></div>',
                expectedClickedText: 'X'
            }
        ]

        for (const scenario of interruptScenarios) {
            mockLogs.length = 0
            await page.setContent(scenario.html)

            // Intercept click on the element by setting data-clicked
            await page.evaluate(() => {
                const el = document.querySelector('button, a, [role="button"]')
                if (el) {
                    el.addEventListener('click', () => {
                        el.setAttribute('data-clicked', 'true')
                    })
                }
            })

            await mobileLogin.handlePasskeyPrompt(page, scenario.url)

            const clicked = await page.evaluate(() => {
                const el = document.querySelector('[data-clicked="true"]')
                return !!el
            })

            assert.strictEqual(clicked, true, `Dismiss button should be clicked for ${scenario.url}`)
            const foundLog = mockLogs.some(l =>
                l.includes('[INFO][PASSKEY-BYPASS]') &&
                l.includes('Mendeteksi interupsi pendaftaran Passkey/FIDO')
            )
            assert.ok(foundLog, `Shield log must be emitted when passkey interrupt is bypassed: ${JSON.stringify(mockLogs)}`)
        }

        console.log('✅ Test 4 Passed: Live DOM interaction successfully detects and clicks dismiss buttons on passkey pages')

        // Test 5: Fallback in-page modal prompt
        {
            mockLogs.length = 0
            await page.setContent(`
                <div id="modal">
                    <div data-testid="registrationImg">Passkey icon</div>
                    <button data-testid="secondaryButton">Skip</button>
                </div>
            `)

            await mobileLogin.handlePasskeyPrompt(page, 'https://login.live.com/oauth20_authorize.srf')
            const ghostClickLogged = mockLogs.some(l => l.includes('[GHOST-CLICK] button[data-testid="secondaryButton"]'))
            assert.ok(ghostClickLogged, 'Legacy in-page modal must trigger ghostClick on secondaryButton')
            console.log('✅ Test 5 Passed: Legacy in-page modal prompt remains functional')
        }

        // Test 6: Normal page without interrupt does not click or log
        {
            mockLogs.length = 0
            await page.setContent(`<div><h1>Standard Login Page</h1><input type="text"/></div>`)
            await mobileLogin.handlePasskeyPrompt(page, 'https://login.live.com/oauth20_authorize.srf')
            assert.strictEqual(mockLogs.length, 0, 'No action should be taken on normal page')
            console.log('✅ Test 6 Passed: Normal pages cleanly ignored without spurious actions')
        }
    } finally {
        if (browser) {
            await browser.close()
        }
    }

    console.log('🎉 ALL CHAPTER 23 PASSKEY BYPASS TESTS PASSED!')
}
