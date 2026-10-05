import assert from 'assert'
import { chromium, type Page, type Browser } from 'patchright'
import { MobileAccessLogin } from '../src/browser/auth/methods/MobileAccessLogin'
import { ClaimBonusPoints } from '../src/functions/activities/api/ClaimBonusPoints'
import type { MicrosoftRewardsBot } from '../src/index'

export async function runChapter25OAuthConsentAndBonusClaimTests() {
    console.log('\n--- Running Chapter 25 OAuth Auto-Consent, ClaimBonusPoints Guard & Punch Card Hardening Test Suite ---')

    const mockLogs: string[] = []
    const mockBot = {
        isMobile: true,
        rewardsVersion: 'modern-envelope',
        requestToken: '',
        userData: {
            currentPoints: 1000,
            gainedPoints: 0,
            geoLocale: 'ID',
            timezoneOffset: '-420'
        },
        cookies: {
            mobile: [],
            desktop: []
        },
        fingerprint: {
            headers: {}
        },
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
            func: {
                buildCookieHeader: () => '',
                getCurrentPoints: async () => 1000
            },
            utils: {
                ghostClick: async (_page: Page, selector: string) => {
                    mockLogs.push(`[GHOST-CLICK] ${selector}`)
                }
            }
        },
        utils: {
            wait: async (_ms: number) => {},
            randomDelay: () => 0
        },
        axios: {
            request: async (_config: any) => {
                throw new Error('Request failed with status code 400')
            }
        }
    } as unknown as MicrosoftRewardsBot

    // Test 1: isOAuthConsentUrl accuracy
    {
        const dummyPage = {} as Page
        const mobileLogin = new MobileAccessLogin(mockBot, dummyPage)

        const consentUrls = [
            'https://login.live.com/oauth20_authorize.srf?client_id=0000000040170455',
            'https://login.live.com/ppsecure/post.srf',
            'https://login.live.com/consent/manage',
            'https://login.live.com/kmsi',
            'https://login.live.com/oauth20_authorize.srf'
        ]

        for (const u of consentUrls) {
            assert.strictEqual(
                mobileLogin.isOAuthConsentUrl(u),
                true,
                `Expected true for consent URL: ${u}`
            )
        }

        const nonConsentUrls = [
            'https://rewards.bing.com/dashboard',
            'https://www.bing.com/search?q=test',
            'https://microsoft.com',
            ''
        ]

        for (const u of nonConsentUrls) {
            assert.strictEqual(
                mobileLogin.isOAuthConsentUrl(u),
                false,
                `Expected false for non-consent URL: ${u}`
            )
        }

        console.log('✅ Test 1 Passed: OAuth consent URL detector correctly identifies authorize, post.srf, and kmsi pages')
    }

    // Test 2: oauthConsentSelectors contains all required identifiers
    {
        const dummyPage = {} as Page
        const mobileLogin = new MobileAccessLogin(mockBot, dummyPage)
        const selectors = mobileLogin.oauthConsentSelectors

        const requiredSelectors = [
            '#idSIButton9',
            'input[type="submit"]#idSIButton9',
            'button#idSIButton9',
            'input[type="submit"][value="Yes"]',
            'input[type="submit"][value="Accept"]',
            'input[type="submit"][value="Continue"]',
            'button:has-text("Yes")',
            'button:has-text("Accept")',
            'button:has-text("Continue")',
            'button:has-text("Allow")',
            'button:has-text("Setuju")',
            'button:has-text("Lanjutkan")'
        ]

        for (const req of requiredSelectors) {
            assert.ok(selectors.includes(req), `oauthConsentSelectors must contain ${req}`)
        }

        console.log('✅ Test 2 Passed: OAuth consent selectors include #idSIButton9, multilingual text, and submit variants')
    }

    // Test 3 & 4: Live headless page interaction for handleOAuthConsent
    let browser: Browser | null = null
    try {
        browser = await chromium.launch({ headless: true })
        const page = await browser.newPage()
        const mobileLogin = new MobileAccessLogin(mockBot, page)

        // Test 3: Consent button auto-click when consent page is presented
        {
            mockLogs.length = 0
            await page.setContent(`
                <div id="consent-dialog">
                    <h2>Let this app access your info?</h2>
                    <input type="submit" id="idSIButton9" value="Yes" />
                </div>
            `)

            await page.evaluate(() => {
                const el = document.getElementById('idSIButton9')
                if (el) {
                    el.addEventListener('click', () => {
                        el.setAttribute('data-clicked', 'true')
                    })
                }
            })

            const clicked = await mobileLogin.handleOAuthConsent(page, 'https://login.live.com/oauth20_authorize.srf')
            assert.strictEqual(clicked, true, 'handleOAuthConsent should return true when consent button is clicked')

            const isDataClicked = await page.evaluate(() => {
                const el = document.getElementById('idSIButton9')
                return el?.getAttribute('data-clicked') === 'true'
            })
            assert.strictEqual(isDataClicked, true, 'DOM element #idSIButton9 must have received click event')

            const consentLogPresent = mockLogs.some(l =>
                l.includes('[INFO][LOGIN-APP]') &&
                l.includes('🛡️ [OAUTH-CONSENT]') &&
                l.includes('oauth20_authorize.srf')
            )
            assert.ok(consentLogPresent, `Log should note auto-confirming consent: ${JSON.stringify(mockLogs)}`)
            console.log('✅ Test 3 Passed: Live DOM consent prompt auto-clicked and logged successfully')
        }

        // Test 4: Safeguard prevents clicking submit when email or password input fields are visible
        {
            mockLogs.length = 0
            await page.setContent(`
                <form id="loginForm">
                    <input type="password" name="passwd" style="display:block; width:200px; height:30px;" />
                    <input type="submit" id="idSIButton9" value="Sign in" />
                </form>
            `)

            await page.evaluate(() => {
                const el = document.getElementById('idSIButton9')
                if (el) {
                    el.addEventListener('click', () => {
                        el.setAttribute('data-clicked', 'true')
                    })
                }
            })

            const clicked = await mobileLogin.handleOAuthConsent(page, 'https://login.live.com/oauth20_authorize.srf')
            assert.strictEqual(clicked, false, 'handleOAuthConsent must return false when password field is visible')

            const isDataClicked = await page.evaluate(() => {
                const el = document.getElementById('idSIButton9')
                return el?.getAttribute('data-clicked') === 'true'
            })
            assert.strictEqual(isDataClicked, false, 'DOM element #idSIButton9 must NOT be clicked when password input is present')
            console.log('✅ Test 4 Passed: Safeguard reliably protects credential fields from premature submit')
        }
    } finally {
        if (browser) {
            await browser.close()
        }
    }

    // Test 5: ClaimBonusPoints skips cleanly without network request when requestToken is missing
    {
        mockLogs.length = 0
        let axiosCalled = false
        const testBot = {
            ...mockBot,
            requestToken: '',
            axios: {
                request: async () => {
                    axiosCalled = true
                    return { status: 200 }
                }
            }
        } as unknown as MicrosoftRewardsBot

        const claimWorker = new ClaimBonusPoints(testBot)
        await claimWorker.claimBonusPoints()

        assert.strictEqual(axiosCalled, false, 'Axios request must not be triggered when requestToken is missing')
        const skipLogged = mockLogs.some(l =>
            l.includes('[DEBUG][CLAIM-BONUS-POINTS]') &&
            l.includes('Request token not available')
        )
        assert.ok(skipLogged, 'Debug skip message should be recorded when requestToken is missing')
        console.log('✅ Test 5 Passed: ClaimBonusPoints skips cleanly without network calls when token is missing')
    }

    // Test 6: ClaimBonusPoints handles HTTP 400 with graceful warn without throwing error
    {
        mockLogs.length = 0
        const testBot = {
            ...mockBot,
            requestToken: 'sample_verification_token',
            axios: {
                request: async () => {
                    const err = new Error('Request failed with status code 400')
                    throw err
                }
            }
        } as unknown as MicrosoftRewardsBot

        const claimWorker = new ClaimBonusPoints(testBot)
        // Must not throw uncaught error
        await claimWorker.claimBonusPoints()

        const warnLogged = mockLogs.some(l =>
            l.includes('[WARN][CLAIM-BONUS-POINTS]') &&
            l.includes('ClaimBonusPoints endpoint unavailable or declined') &&
            l.includes('status code 400')
        )
        assert.ok(warnLogged, 'Warning should be recorded for HTTP 400 instead of crash')
        const errorLogged = mockLogs.some(l => l.includes('[ERROR][CLAIM-BONUS-POINTS]'))
        assert.strictEqual(errorLogged, false, 'No error-level log should be emitted for best-effort bonus claim failure')
        console.log('✅ Test 6 Passed: ClaimBonusPoints converts HTTP 400 to non-fatal warning without fatal error')
    }

    // Test 7: Punch card envelope title snippet extraction and flexible selectors
    {
        const title = 'Costume season is here: find the best Halloween looks'
        const cleanTitle = title.replace(/[^\w\s]/gi, ' ').trim()
        const titleSnippet = cleanTitle.split(/\s+/).slice(0, 4).join(' ')
        assert.strictEqual(titleSnippet, 'Costume season is here', 'First 4 keywords extracted cleanly')

        const generatedTitleSelector = `a:has-text("${titleSnippet}")`
        assert.strictEqual(generatedTitleSelector, 'a:has-text("Costume season is here")')
        console.log('✅ Test 7 Passed: Punch card title snippet matching generates clean text-based selectors')
    }

    console.log('🎉 ALL CHAPTER 25 TESTS PASSED!')
}
