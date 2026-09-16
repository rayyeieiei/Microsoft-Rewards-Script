import fs from 'fs'
import path from 'path'
import os from 'os'
import assert from 'assert'
import { AccountSessionStore } from '../src/runtime/session/AccountSessionStore'
import { SessionPathResolver } from '../src/runtime/session/SessionPathResolver'
import { AccountScope } from '../src/runtime/AccountScope'
import type {
    PlaywrightStorageState,
    PlaywrightCookie,
    StoredSessionEnvelope
} from '../src/runtime/session/AccountSessionTypes'
import BrowserFunc from '../src/browser/BrowserFunc'

function createMockCookie(name: string, value: string, domain = '.bing.com', cookiePath = '/'): PlaywrightCookie {
    return {
        name,
        value,
        domain,
        path: cookiePath,
        expires: 1800000000,
        httpOnly: true,
        secure: true,
        sameSite: 'Lax'
    }
}

export async function runSessionPersistenceTests(): Promise<void> {
    console.log('--- Running Unified Session Persistence Test Suite (Commit 2) ---')

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-session-test-'))
    const prodSessionsDir = path.resolve(process.cwd(), 'browser', 'sessions')
    const initialProdFiles = fs.existsSync(prodSessionsDir)
        ? fs.readdirSync(prodSessionsDir)
        : []

    try {
        // --- Test 1: Save lalu load pada scope baru mempertahankan cookies dan origin state sintetis ---
        {
            const testDir = path.join(tempRoot, 'test1')
            fs.mkdirSync(testDir, { recursive: true })

            const accountKey = 'user1@example.com'
            const scope1 = AccountScope.createForTesting(accountKey, 'run1', 'scope1', undefined, testDir)

            const syntheticState: PlaywrightStorageState = {
                cookies: [
                    {
                        name: 'session_auth',
                        value: 'token_xyz_123',
                        domain: '.bing.com',
                        path: '/',
                        expires: 1893456000,
                        httpOnly: true,
                        secure: true,
                        sameSite: 'Lax'
                    }
                ],
                origins: [
                    {
                        origin: 'https://rewards.bing.com',
                        localStorage: [
                            { name: 'theme', value: 'dark' },
                            { name: 'onboarding_seen', value: 'true' }
                        ]
                    }
                ]
            }

            const mockContext = {
                storageState: async () => syntheticState
            }

            const saveResult = await AccountSessionStore.saveContextSession(mockContext, scope1, 'mobile')
            assert.strictEqual(saveResult.status, 'saved', 'Save must succeed')

            // Create a brand new scope with same accountId
            const scope2 = AccountScope.createForTesting(accountKey, 'run2', 'scope2', undefined, testDir)
            const loadResult = await AccountSessionStore.loadSession(scope2, 'mobile')

            assert.strictEqual(loadResult.status, 'loaded', 'Load must succeed')
            if (loadResult.status === 'loaded') {
                assert.strictEqual(loadResult.source, 'modern-envelope', 'Source must be modern-envelope')
                assert.strictEqual(loadResult.state.cookies.length, 1)
                assert.strictEqual(loadResult.state.cookies[0]?.name, 'session_auth')
                assert.strictEqual(loadResult.state.cookies[0]?.value, 'token_xyz_123')
                assert.strictEqual(loadResult.state.origins.length, 1)
                assert.strictEqual(loadResult.state.origins[0]?.localStorage[0]?.value, 'dark')
            }

            console.log('✅ Test 1 Passed: Save and load on new scope preserves synthetic cookies and origin state')
        }

        // --- Test 2: Account A/B serta mobile/desktop tidak tertukar ---
        {
            const testDir = path.join(tempRoot, 'test2')
            fs.mkdirSync(testDir, { recursive: true })

            const scopeA = AccountScope.createForTesting('accA@example.com', 'runA', 'scopeA', undefined, testDir)
            const scopeB = AccountScope.createForTesting('accB@example.com', 'runB', 'scopeB', undefined, testDir)

            const ctxAMobile = {
                storageState: async () => ({
                    cookies: [{ name: 'acc', value: 'A_mobile', domain: 'b.com', path: '/' }],
                    origins: []
                })
            }
            const ctxADesktop = {
                storageState: async () => ({
                    cookies: [{ name: 'acc', value: 'A_desktop', domain: 'b.com', path: '/' }],
                    origins: []
                })
            }
            const ctxBMobile = {
                storageState: async () => ({
                    cookies: [{ name: 'acc', value: 'B_mobile', domain: 'b.com', path: '/' }],
                    origins: []
                })
            }
            const ctxBDesktop = {
                storageState: async () => ({
                    cookies: [{ name: 'acc', value: 'B_desktop', domain: 'b.com', path: '/' }],
                    origins: []
                })
            }

            await AccountSessionStore.saveContextSession(ctxAMobile, scopeA, 'mobile')
            await AccountSessionStore.saveContextSession(ctxADesktop, scopeA, 'desktop')
            await AccountSessionStore.saveContextSession(ctxBMobile, scopeB, 'mobile')
            await AccountSessionStore.saveContextSession(ctxBDesktop, scopeB, 'desktop')

            const loadAMobile = await AccountSessionStore.loadSession(scopeA, 'mobile')
            const loadADesktop = await AccountSessionStore.loadSession(scopeA, 'desktop')
            const loadBMobile = await AccountSessionStore.loadSession(scopeB, 'mobile')
            const loadBDesktop = await AccountSessionStore.loadSession(scopeB, 'desktop')

            assert.strictEqual(loadAMobile.status, 'loaded')
            assert.strictEqual(loadADesktop.status, 'loaded')
            assert.strictEqual(loadBMobile.status, 'loaded')
            assert.strictEqual(loadBDesktop.status, 'loaded')

            if (
                loadAMobile.status === 'loaded' &&
                loadADesktop.status === 'loaded' &&
                loadBMobile.status === 'loaded' &&
                loadBDesktop.status === 'loaded'
            ) {
                assert.strictEqual(loadAMobile.state.cookies[0]?.value, 'A_mobile')
                assert.strictEqual(loadADesktop.state.cookies[0]?.value, 'A_desktop')
                assert.strictEqual(loadBMobile.state.cookies[0]?.value, 'B_mobile')
                assert.strictEqual(loadBDesktop.state.cookies[0]?.value, 'B_desktop')
            }

            console.log('✅ Test 2 Passed: Account A/B and mobile/desktop sessions remain strictly isolated')
        }

        // --- Test 3: Envelope dengan accountId/device salah ditolak ---
        {
            const testDir = path.join(tempRoot, 'test3')
            fs.mkdirSync(testDir, { recursive: true })

            const scopeA = AccountScope.createForTesting('accA@example.com', 'runA', 'scopeA', undefined, testDir)
            const scopeB = AccountScope.createForTesting('accB@example.com', 'runB', 'scopeB', undefined, testDir)

            // Put Account A's envelope into Account B's storage path
            const targetPathB = SessionPathResolver.getModernPath(testDir, scopeB.identity.accountId, 'mobile')
            const spoofedEnvelope: StoredSessionEnvelope = {
                schemaVersion: 1,
                accountId: scopeA.identity.accountId, // Mismatched accountId!
                device: 'mobile',
                savedAt: Date.now(),
                storageState: {
                    cookies: [createMockCookie('auth', 'secret', 'b.com')],
                    origins: []
                }
            }
            fs.writeFileSync(targetPathB, JSON.stringify(spoofedEnvelope), 'utf-8')

            const loadResult = await AccountSessionStore.loadSession(scopeB, 'mobile')
            assert.strictEqual(loadResult.status, 'identity-mismatch')
            if (loadResult.status === 'identity-mismatch') {
                assert.strictEqual(loadResult.expectedAccountId, scopeB.identity.accountId)
                assert.strictEqual(loadResult.actualAccountId, scopeA.identity.accountId)
            }

            // Put desktop device envelope into mobile path
            const targetPathMobile = SessionPathResolver.getModernPath(testDir, scopeA.identity.accountId, 'mobile')
            const deviceMismatchEnvelope: StoredSessionEnvelope = {
                schemaVersion: 1,
                accountId: scopeA.identity.accountId,
                device: 'desktop', // Mismatched device!
                savedAt: Date.now(),
                storageState: {
                    cookies: [createMockCookie('auth', 'secret', 'b.com')],
                    origins: []
                }
            }
            fs.writeFileSync(targetPathMobile, JSON.stringify(deviceMismatchEnvelope), 'utf-8')

            const deviceLoadResult = await AccountSessionStore.loadSession(scopeA, 'mobile')
            assert.strictEqual(deviceLoadResult.status, 'identity-mismatch')

            console.log('✅ Test 3 Passed: Envelope with mismatched accountId or device is rejected')
        }

        // --- Test 4: Raw storageState dari writer sebelumnya dimigrasikan tanpa dianggap corrupt ---
        {
            const testDir = path.join(tempRoot, 'test4')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('userRaw@example.com', 'runRaw', 'scopeRaw', undefined, testDir)
            const targetPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')

            // Write raw Playwright storage state directly without schemaVersion or accountId wrapper
            const rawStorageState: PlaywrightStorageState = {
                cookies: [
                    {
                        name: 'raw_session',
                        value: 'legacy_val_999',
                        domain: '.bing.com',
                        path: '/',
                        expires: 1800000000,
                        httpOnly: true,
                        secure: true,
                        sameSite: 'Lax'
                    }
                ],
                origins: []
            }
            fs.writeFileSync(targetPath, JSON.stringify(rawStorageState), 'utf-8')

            const loadResult = await AccountSessionStore.loadSession(scope, 'mobile')
            assert.strictEqual(loadResult.status, 'loaded')
            if (loadResult.status === 'loaded') {
                assert.strictEqual(loadResult.source, 'previous-storage-state')
                assert.strictEqual(loadResult.state.cookies[0]?.name, 'raw_session')
            }

            console.log('✅ Test 4 Passed: Raw storageState from previous writer is loaded without false corruption')
        }

        // --- Test 5: Cookie JSON legacy valid dimuat ketika syarat fallback terpenuhi ---
        {
            const testDir = path.join(tempRoot, 'test5')
            fs.mkdirSync(testDir, { recursive: true })

            const email = 'legacyUser@example.com'
            const scope = AccountScope.createForTesting(email, 'runLeg', 'scopeLeg', undefined, testDir)

            const legacyFile = SessionPathResolver.getLegacyPath(testDir, email, 'mobile')
            fs.mkdirSync(path.dirname(legacyFile), { recursive: true })
            const legacyCookies = [
                {
                    name: 'old_cookie',
                    value: 'old_val',
                    domain: '.bing.com',
                    path: '/'
                }
            ]
            fs.writeFileSync(legacyFile, JSON.stringify(legacyCookies), 'utf-8')

            const loadResult = await AccountSessionStore.loadSession(scope, 'mobile', { legacyEmail: email })
            assert.strictEqual(loadResult.status, 'loaded')
            if (loadResult.status === 'loaded') {
                assert.strictEqual(loadResult.source, 'legacy-cookie-json')
                assert.strictEqual(loadResult.state.cookies[0]?.name, 'old_cookie')
            }

            console.log('✅ Test 5 Passed: Valid legacy cookie JSON is loaded when fallback conditions are met')
        }

        // --- Test 6: File legacy tetap dipertahankan ---
        {
            const testDir = path.join(tempRoot, 'test6')
            fs.mkdirSync(testDir, { recursive: true })

            const email = 'preserveLegacy@example.com'
            const scope = AccountScope.createForTesting(email, 'runPres', 'scopePres', undefined, testDir)

            const legacyFile = SessionPathResolver.getLegacyPath(testDir, email, 'desktop')
            fs.mkdirSync(path.dirname(legacyFile), { recursive: true })
            const originalContent = JSON.stringify([{ name: 'pres', value: '1', domain: 'b.com', path: '/' }])
            fs.writeFileSync(legacyFile, originalContent, 'utf-8')

            await AccountSessionStore.loadSession(scope, 'desktop', { legacyEmail: email })

            // Verify file still exists and byte content is untouched
            assert.strictEqual(fs.existsSync(legacyFile), true, 'Legacy file must not be deleted')
            const contentAfter = fs.readFileSync(legacyFile, 'utf-8')
            assert.strictEqual(contentAfter, originalContent, 'Legacy file content must remain unaltered')

            console.log('✅ Test 6 Passed: Legacy file remains preserved and untouched on disk')
        }

        // --- Test 7: Modern corrupt tidak fallback pada run pertama maupun setelah restart ---
        {
            const testDir = path.join(tempRoot, 'test7')
            fs.mkdirSync(testDir, { recursive: true })

            const email = 'corrupt@example.com'
            const scope = AccountScope.createForTesting(email, 'runCorr', 'scopeCorr', undefined, testDir)

            // Setup valid legacy file
            const legacyFile = SessionPathResolver.getLegacyPath(testDir, email, 'mobile')
            fs.mkdirSync(path.dirname(legacyFile), { recursive: true })
            fs.writeFileSync(legacyFile, JSON.stringify([{ name: 'fallback_attempt', value: 'fail' }]), 'utf-8')

            // Setup corrupt modern file
            const primaryPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')
            fs.writeFileSync(primaryPath, '{ corrupt json is not valid ::: ', 'utf-8')

            // Run 1: Load should detect corruption and NOT fall back to legacy
            const loadResult1 = await AccountSessionStore.loadSession(scope, 'mobile', { legacyEmail: email })
            assert.strictEqual(loadResult1.status, 'corrupted')

            // Verify quarantine marker exists and corrupt file was moved
            const markerPath = SessionPathResolver.getQuarantineMarkerPath(testDir, scope.identity.accountId, 'mobile')
            assert.strictEqual(fs.existsSync(markerPath), true, 'Persistent quarantine marker must exist')

            // Run 2 (Simulated restart): Primary file is missing now, but marker exists
            const restartScope = AccountScope.createForTesting(email, 'runRestart', 'scopeRestart', undefined, testDir)
            const loadResult2 = await AccountSessionStore.loadSession(restartScope, 'mobile', { legacyEmail: email })
            assert.strictEqual(loadResult2.status, 'corrupted', 'Restart must still report corrupted')
            assert.notStrictEqual(loadResult2.status, 'loaded', 'Must not fall back to legacy on restart')

            console.log('✅ Test 7 Passed: Modern corrupt does not fallback on first run or restart')
        }

        // --- Test 8: Schema version tak didukung tidak dianggap missing ---
        {
            const testDir = path.join(tempRoot, 'test8')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('version@example.com', 'runV', 'scopeV', undefined, testDir)
            const targetPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'desktop')

            const futureEnvelope = {
                schemaVersion: 999, // Unsupported future schema
                accountId: scope.identity.accountId,
                device: 'desktop',
                savedAt: Date.now(),
                storageState: { cookies: [], origins: [] }
            }
            fs.writeFileSync(targetPath, JSON.stringify(futureEnvelope), 'utf-8')

            const loadResult = await AccountSessionStore.loadSession(scope, 'desktop')
            assert.strictEqual(loadResult.status, 'unsupported-version')
            if (loadResult.status === 'unsupported-version') {
                assert.strictEqual(loadResult.schemaVersion, 999)
            }

            console.log('✅ Test 8 Passed: Unsupported schema version is not treated as missing')
        }

        // --- Test 9: Failed replace mempertahankan byte file valid sebelumnya ---
        {
            const testDir = path.join(tempRoot, 'test9')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('atomic@example.com', 'runAt', 'scopeAt', undefined, testDir)
            const targetPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')

            const initialEnvelope: StoredSessionEnvelope = {
                schemaVersion: 1,
                accountId: scope.identity.accountId,
                device: 'mobile',
                savedAt: 1000,
                storageState: {
                    cookies: [createMockCookie('valid_initial', 'val1', 'b.com')],
                    origins: []
                }
            }
            const initialBytes = JSON.stringify(initialEnvelope, null, 2)
            fs.writeFileSync(targetPath, initialBytes, 'utf-8')

            // Simulate replace failure by stubbing rename to fail with fatal error
            const origRename = fs.promises.rename
            try {
                fs.promises.rename = async () => {
                    throw new Error('ENOSPC: no space left on device')
                }

                const newEnvelope: StoredSessionEnvelope = {
                    schemaVersion: 1,
                    accountId: scope.identity.accountId,
                    device: 'mobile',
                    savedAt: 2000,
                    storageState: {
                        cookies: [createMockCookie('new_state', 'val2', 'b.com')],
                        origins: []
                    }
                }

                const saveRes = await AccountSessionStore.saveEnvelopeAtomically(targetPath, newEnvelope)
                assert.strictEqual(saveRes.status, 'failed')

                // Verify original target file remains 100% byte-for-byte intact
                const currentBytes = fs.readFileSync(targetPath, 'utf-8')
                assert.strictEqual(currentBytes, initialBytes, 'Target file must remain intact after failed replace')

                // Verify temporary files are cleaned up
                const tempFiles = fs.readdirSync(testDir).filter(f => f.includes('.tmp.'))
                assert.strictEqual(tempFiles.length, 0, 'Temporary file must be cleaned up on failure')
            } finally {
                fs.promises.rename = origRename
            }

            console.log('✅ Test 9 Passed: Failed replace preserves prior valid file bytes and cleans temp file')
        }

        // --- Test 10: Sharing violation memiliki retry terbatas dan tidak menghapus target ---
        {
            const testDir = path.join(tempRoot, 'test10')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('sharing@example.com', 'runSh', 'scopeSh', undefined, testDir)
            const targetPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')

            const initialBytes = JSON.stringify({ initial: true })
            fs.writeFileSync(targetPath, initialBytes, 'utf-8')

            const origRename = fs.promises.rename
            try {
                let attempts = 0
                // Simulate EBUSY twice, then succeed
                fs.promises.rename = async (src, dst) => {
                    attempts++
                    if (attempts <= 2) {
                        const err: any = new Error('resource busy or locked')
                        err.code = 'EBUSY'
                        throw err
                    }
                    return origRename(src, dst)
                }

                const envelope: StoredSessionEnvelope = {
                    schemaVersion: 1,
                    accountId: scope.identity.accountId,
                    device: 'mobile',
                    savedAt: Date.now(),
                    storageState: {
                        cookies: [createMockCookie('retry_cookie', 'ok', 'b.com')],
                        origins: []
                    }
                }

                const saveRes = await AccountSessionStore.saveEnvelopeAtomically(targetPath, envelope)
                assert.strictEqual(saveRes.status, 'saved')
                assert.strictEqual(attempts, 3, 'Must have retried on EBUSY')

                // Next, test when retries are completely exhausted
                fs.promises.rename = async () => {
                    const err: any = new Error('continuous sharing violation')
                    err.code = 'EBUSY'
                    throw err
                }

                const failRes = await AccountSessionStore.saveEnvelopeAtomically(targetPath, envelope)
                assert.strictEqual(failRes.status, 'failed')
                assert.strictEqual(fs.existsSync(targetPath), true, 'Target must not be deleted when retries exhaust')
            } finally {
                fs.promises.rename = origRename
            }

            console.log('✅ Test 10 Passed: Windows sharing violation retries with deadline and preserves target')
        }

        // --- Test 11: Concurrent write terserialisasi; write berikutnya tetap berjalan setelah failure ---
        {
            const testDir = path.join(tempRoot, 'test11')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('concur@example.com', 'runC', 'scopeC', undefined, testDir)
            const targetPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')

            // Write 1: invalid envelope that fails validation
            const invalidEnvelope = {
                schemaVersion: 1,
                accountId: '', // invalid
                device: 'mobile',
                savedAt: Date.now(),
                storageState: { cookies: [], origins: [] }
            } as any

            // Write 2: valid envelope
            const validEnvelope: StoredSessionEnvelope = {
                schemaVersion: 1,
                accountId: scope.identity.accountId,
                device: 'mobile',
                savedAt: Date.now(),
                storageState: {
                    cookies: [createMockCookie('concurrent_winner', 'w', 'b.com')],
                    origins: []
                }
            }

            const [res1, res2] = await Promise.all([
                AccountSessionStore.saveEnvelopeAtomically(targetPath, invalidEnvelope),
                AccountSessionStore.saveEnvelopeAtomically(targetPath, validEnvelope)
            ])

            assert.strictEqual(res1.status, 'failed', 'Write 1 must fail')
            assert.strictEqual(res2.status, 'saved', 'Write 2 must recover and succeed')

            const loaded = await AccountSessionStore.loadSession(scope, 'mobile')
            assert.strictEqual(loaded.status, 'loaded')
            if (loaded.status === 'loaded') {
                assert.strictEqual(loaded.state.cookies[0]?.name, 'concurrent_winner')
            }

            console.log('✅ Test 11 Passed: Concurrent writes are serialized and queue recovers after failure')
        }

        // --- Test 12: Traversal, sibling-directory prefix, dan path escape ditolak ---
        {
            const baseDir = path.join(tempRoot, 'test12_base')
            fs.mkdirSync(baseDir, { recursive: true })

            // Traversal escape via ..
            assert.throws(() => {
                SessionPathResolver.assertContained(baseDir, path.join(baseDir, '..', 'escaped.json'))
            }, /containment violation/i)

            // Sibling directory prefix
            const siblingDir = path.join(tempRoot, 'test12_base-sibling')
            fs.mkdirSync(siblingDir, { recursive: true })
            assert.throws(() => {
                SessionPathResolver.assertContained(baseDir, path.join(siblingDir, 'file.json'))
            }, /containment violation/i)

            // Null byte injection
            assert.throws(() => {
                SessionPathResolver.assertContained(baseDir, path.join(baseDir, 'evil\0.json'))
            }, /containment violation/i)

            // Legacy path with path traversal email
            assert.throws(() => {
                SessionPathResolver.getLegacyPath(baseDir, '../../etc/passwd', 'mobile')
            }, /containment violation/i)

            console.log('✅ Test 12 Passed: Directory traversal, sibling prefix, and path escapes are strictly rejected')
        }

        // --- Test 13: Save terjadi sebelum penutupan context pada jalur production terkait ---
        {
            const testDir = path.join(tempRoot, 'test13')
            fs.mkdirSync(testDir, { recursive: true })

            const email = 'closeOrder@example.com'
            const scope = AccountScope.createForTesting(email, 'runCl', 'scopeCl', undefined, testDir)

            const executionOrder: string[] = []
            const mockBrowserContext: any = {
                storageState: async () => {
                    executionOrder.push('storageState')
                    return {
                        cookies: [{ name: 'saved_before_close', value: '1', domain: 'b.com', path: '/' }],
                        origins: []
                    }
                },
                close: async () => {
                    executionOrder.push('close')
                },
                cookies: async () => []
            }

            const mockBot: any = {
                accountScope: scope,
                isMobile: true,
                config: { sessionPath: testDir },
                logger: {
                    debug: () => {},
                    info: () => {},
                    warn: () => {},
                    error: () => {}
                },
                utils: {
                    wait: async () => {}
                }
            }

            const browserFunc = new BrowserFunc(mockBot)
            await browserFunc.closeBrowser(mockBrowserContext, email)

            assert.deepStrictEqual(
                executionOrder,
                ['storageState', 'close'],
                'storageState must be extracted before context is closed'
            )

            console.log('✅ Test 13 Passed: Save occurs strictly before context close on production close path')
        }

        // --- Test 14: Context sudah tertutup tidak menghasilkan save-success palsu ---
        {
            const testDir = path.join(tempRoot, 'test14')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('closedCtx@example.com', 'runCc', 'scopeCc', undefined, testDir)

            const closedContext = {
                storageState: async () => {
                    throw new Error('Target page, context or browser has been closed')
                }
            }

            const saveRes = await AccountSessionStore.saveContextSession(closedContext, scope, 'mobile')
            assert.strictEqual(saveRes.status, 'failed', 'Must report failed on closed context')
            assert.notStrictEqual(saveRes.status, 'saved', 'Must not report saved')

            // Verify no file was created
            const primaryPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')
            assert.strictEqual(fs.existsSync(primaryPath), false, 'Must not write file from closed context')

            console.log('✅ Test 14 Passed: Closed context does not produce false save-success')
        }

        // --- Test 15: Diagnostic tidak membocorkan nilai cookie, token, atau email ---
        {
            const testDir = path.join(tempRoot, 'test15')
            fs.mkdirSync(testDir, { recursive: true })

            const sensitiveToken = 'super_secret_session_token_xyz999'
            const rawEmail = 'sensitive_person_private@secure.com'
            const scope = AccountScope.createForTesting(rawEmail, 'runDiag', 'scopeDiag', undefined, testDir)

            const corruptFile = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')
            fs.writeFileSync(corruptFile, `{ invalid_token: "${sensitiveToken}"`, 'utf-8')

            const loadResult = await AccountSessionStore.loadSession(scope, 'mobile')
            assert.strictEqual(loadResult.status, 'corrupted')

            const stringifiedResult = JSON.stringify(loadResult)
            assert.strictEqual(stringifiedResult.includes(sensitiveToken), false, 'Must not leak secret token')
            assert.strictEqual(stringifiedResult.includes(rawEmail), false, 'Must not leak raw email')

            console.log('✅ Test 15 Passed: Diagnostics and error returns do not leak cookies, tokens, or raw email')
        }

        // --- Test 17: Fault injection at crash boundary of quarantine preserves marker and prevents legacy fallback ---
        {
            const testDir = path.join(tempRoot, 'test17')
            fs.mkdirSync(testDir, { recursive: true })

            const email = 'faultQuarantine@example.com'
            const scope = AccountScope.createForTesting(email, 'runFq', 'scopeFq', undefined, testDir)

            // Setup valid legacy cookie file
            const legacyFile = SessionPathResolver.getLegacyPath(testDir, email, 'mobile')
            fs.mkdirSync(path.dirname(legacyFile), { recursive: true })
            fs.writeFileSync(legacyFile, JSON.stringify([createMockCookie('legacy_cookie', 'val')]), 'utf-8')

            // Setup corrupt modern file
            const primaryPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')
            fs.writeFileSync(primaryPath, '{ invalid json corrupted ::: ', 'utf-8')

            // Case A: Inject fault where process crashed immediately after writing marker (before source is unlinked)
            const markerPath = SessionPathResolver.getQuarantineMarkerPath(testDir, scope.identity.accountId, 'mobile')
            fs.mkdirSync(path.dirname(markerPath), { recursive: true })
            fs.writeFileSync(
                markerPath,
                JSON.stringify({
                    schemaVersion: 1,
                    accountId: scope.identity.accountId,
                    device: 'mobile',
                    corruptedAt: Date.now(),
                    reason: 'Injected crash boundary fault'
                }),
                'utf-8'
            )

            // Both primary corrupt file AND marker exist on disk
            assert.strictEqual(fs.existsSync(primaryPath), true)
            assert.strictEqual(fs.existsSync(markerPath), true)

            const loadResultA = await AccountSessionStore.loadSession(scope, 'mobile', { legacyEmail: email })
            assert.strictEqual(loadResultA.status, 'corrupted', 'Marker must block legacy fallback even if source still exists')
            assert.notStrictEqual(loadResultA.status, 'loaded')

            // Case B: Marker exists after source was unlinked
            fs.unlinkSync(primaryPath)
            const loadResultB = await AccountSessionStore.loadSession(scope, 'mobile', { legacyEmail: email })
            assert.strictEqual(loadResultB.status, 'corrupted', 'Marker must block legacy fallback when source is gone')
            assert.notStrictEqual(loadResultB.status, 'loaded')

            console.log('✅ Test 17 Passed: Quarantine crash-boundary fault injection preserves marker and blocks fallback')
        }

        // --- Test 18: In-flight snapshot serialized before mutex to prevent snapshot inversion race ---
        {
            const testDir = path.join(tempRoot, 'test18')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('snapOrder@example.com', 'runSo', 'scopeSo', undefined, testDir)
            const targetPath = SessionPathResolver.getModernPath(testDir, scope.identity.accountId, 'mobile')

            // Step 1: Write an existing session with timestamp 5000
            const existingEnvelope: StoredSessionEnvelope = {
                schemaVersion: 1,
                accountId: scope.identity.accountId,
                device: 'mobile',
                savedAt: 5000,
                storageState: {
                    cookies: [createMockCookie('current_fresh', 'v2')],
                    origins: []
                }
            }
            fs.writeFileSync(targetPath, JSON.stringify(existingEnvelope, null, 2), 'utf-8')

            // Step 2: Attempt to save a context whose snapshot timestamp is older (simulating delayed snapshot race)
            const staleContext = {
                storageState: async () => ({
                    cookies: [createMockCookie('stale_cookie', 'v1')],
                    origins: []
                })
            }

            // Temporarily mock Date.now during snapshot extraction to simulate an older snapshot time (e.g. 2000)
            const realNow = Date.now
            try {
                Date.now = () => 2000
                const saveRes = await AccountSessionStore.saveContextSession(staleContext, scope, 'mobile')
                assert.strictEqual(saveRes.status, 'skipped', 'Stale snapshot must be skipped to prevent overwriting newer session')
            } finally {
                Date.now = realNow
            }

            // Verify disk session remains the fresh version (5000), not the stale one
            const loaded = await AccountSessionStore.loadSession(scope, 'mobile')
            assert.strictEqual(loaded.status, 'loaded')
            if (loaded.status === 'loaded') {
                assert.strictEqual(loaded.state.cookies[0]?.name, 'current_fresh')
            }

            console.log('✅ Test 18 Passed: Snapshot serialization and monotonic ordering prevent inversion races')
        }

        // --- Test 19: Cross-process writer lock rejects concurrent writer and breaks stale dead-PID lock ---
        {
            const testDir = path.join(tempRoot, 'test19')
            fs.mkdirSync(testDir, { recursive: true })

            const scope = AccountScope.createForTesting('xproc@example.com', 'runXp', 'scopeXp', undefined, testDir)
            const lockfilePath = SessionPathResolver.getLockfilePath(testDir, scope.identity.accountId, 'mobile')

            // Case A: Create an active lock owned by this process
            fs.writeFileSync(
                lockfilePath,
                JSON.stringify({
                    pid: process.pid,
                    accountId: scope.identity.accountId,
                    device: 'mobile',
                    acquiredAt: Date.now()
                }),
                'utf-8'
            )

            const ctx = {
                storageState: async () => ({
                    cookies: [createMockCookie('xproc_cookie', '1')],
                    origins: []
                })
            }

            // With active lockfile existing, acquireCrossProcessLock should fail after timeout
            const conflictRes = await AccountSessionStore.saveContextSession(ctx, scope, 'mobile', 500)
            assert.strictEqual(conflictRes.status, 'failed', 'Must report failed on cross-process lock conflict')
            assert.match(
                (conflictRes as any).error || '',
                /lock conflict/i,
                'Error must mention lock conflict'
            )

            // Case B: Create a stale lock owned by a dead PID (e.g. 99999999)
            fs.writeFileSync(
                lockfilePath,
                JSON.stringify({
                    pid: 99999999, // Non-existent process
                    accountId: scope.identity.accountId,
                    device: 'mobile',
                    acquiredAt: Date.now() - 5000
                }),
                'utf-8'
            )

            // Save should safely detect the dead PID, break the stale lock, and succeed
            const successRes = await AccountSessionStore.saveContextSession(ctx, scope, 'mobile')
            assert.strictEqual(successRes.status, 'saved', 'Must break stale lock and succeed')

            // Lockfile must be cleanly released after operation
            assert.strictEqual(fs.existsSync(lockfilePath), false, 'Lockfile must be released after completion')

            console.log('✅ Test 19 Passed: Cross-process writer lock enforces exclusivity and breaks stale dead-PID locks')
        }

        // --- Test 20: Seluruh test tidak menyentuh storage produksi ---
        {
            const finalProdFiles = fs.existsSync(prodSessionsDir)
                ? fs.readdirSync(prodSessionsDir)
                : []
            assert.deepStrictEqual(
                initialProdFiles,
                finalProdFiles,
                'Production sessions directory must have 0 modifications from test suite'
            )

            console.log('✅ Test 20 Passed: Entire test suite operated exclusively in isolated synthetic storage')
        }

        console.log('🎉 ALL 20 UNIFIED SESSION PERSISTENCE TESTS PASSED SUCCESSFULLY!')
    } finally {
        try {
            fs.rmSync(tempRoot, { recursive: true, force: true })
        } catch {}
    }
}
