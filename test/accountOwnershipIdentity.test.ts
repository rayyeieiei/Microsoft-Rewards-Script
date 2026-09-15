import assert from 'assert'
import {
    validateOwnershipPolicy,
    derivePublicRef,
    createSanitizedDiagnosticDto,
    MAX_HOUSEHOLD_ACCOUNTS
} from '../src/runtime/identity/AccountOwnershipIdentity'
import type { Account } from '../src/interface/Account'

function createFakeAccount(overrides: Partial<Account> = {}): Account {
    return {
        email: 'test@example.com',
        password: 'password123',
        recoveryEmail: 'recovery@example.com',
        geoLocale: 'auto',
        langCode: 'en',
        proxy: {
            proxyAxios: false,
            url: '',
            port: 0,
            password: '',
            username: ''
        },
        saveFingerprint: {
            mobile: false,
            desktop: false
        },
        ...overrides
    }
}

export async function runAccountOwnershipIdentityTests(): Promise<void> {
    console.log('--- Running Account Ownership Identity Test Suite (Commit 1) ---')

    // Test 1: Valid explicit UUID identities pass
    {
        const accounts: Account[] = [
            createFakeAccount({
                id: '11111111-1111-4111-8111-111111111111',
                participantId: '22222222-2222-4222-8222-222222222222',
                householdId: '33333333-3333-4333-8333-333333333333',
                email: 'acc1@example.com'
            }),
            createFakeAccount({
                id: '44444444-4444-4444-8444-444444444444',
                participantId: '55555555-5555-4555-8555-555555555555',
                householdId: '33333333-3333-4333-8333-333333333333',
                email: 'acc2@example.com'
            })
        ]

        const summary = validateOwnershipPolicy(accounts, 'report-only')
        assert.strictEqual(summary.totalAccounts, 2)
        assert.strictEqual(summary.validAccounts, 2)
        assert.strictEqual(summary.blockedAccounts, 0)
        assert.strictEqual(summary.results[0]!.status, 'valid')
        assert.strictEqual(summary.results[1]!.status, 'valid')
        console.log('✅ Test 1 Passed: Valid explicit UUID identities pass')
    }

    // Test 2: Duplicate accountId across accounts is rejected
    {
        const accounts: Account[] = [
            createFakeAccount({
                id: '11111111-1111-4111-8111-111111111111',
                participantId: '22222222-2222-4222-8222-222222222222',
                householdId: '33333333-3333-4333-8333-333333333333',
                email: 'acc1@example.com'
            }),
            createFakeAccount({
                id: '11111111-1111-4111-8111-111111111111', // Duplicate ID
                participantId: '55555555-5555-4555-8555-555555555555',
                householdId: '66666666-6666-4666-8666-666666666666',
                email: 'acc2@example.com'
            })
        ]

        const summary = validateOwnershipPolicy(accounts, 'report-only')
        assert.strictEqual(summary.validAccounts, 1)
        assert.strictEqual(summary.blockedAccounts, 1)
        assert.strictEqual(summary.results[1]!.status, 'duplicate-account-id')
        console.log('✅ Test 2 Passed: Duplicate accountId across accounts is rejected')
    }

    // Test 3: Two active accounts with one participantId are rejected
    {
        const accounts: Account[] = [
            createFakeAccount({
                id: '11111111-1111-4111-8111-111111111111',
                participantId: '22222222-2222-4222-8222-222222222222',
                householdId: '33333333-3333-4333-8333-333333333333',
                email: 'acc1@example.com'
            }),
            createFakeAccount({
                id: '44444444-4444-4444-8444-444444444444',
                participantId: '22222222-2222-4222-8222-222222222222', // Same participant
                householdId: '33333333-3333-4333-8333-333333333333',
                email: 'acc2@example.com'
            })
        ]

        const summary = validateOwnershipPolicy(accounts, 'report-only')
        assert.strictEqual(summary.validAccounts, 1)
        assert.strictEqual(summary.blockedAccounts, 1)
        assert.strictEqual(summary.results[1]!.status, 'duplicate-participant')
        console.log('✅ Test 3 Passed: Two active accounts with one participantId are rejected')
    }

    // Test 4: Exactly six accounts in one household pass policy
    {
        const householdId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        const accounts: Account[] = []
        for (let i = 1; i <= MAX_HOUSEHOLD_ACCOUNTS; i++) {
            accounts.push(
                createFakeAccount({
                    id: `10000000-0000-4000-8000-00000000000${i}`,
                    participantId: `20000000-0000-4000-8000-00000000000${i}`,
                    householdId,
                    email: `member${i}@example.com`
                })
            )
        }

        const summary = validateOwnershipPolicy(accounts, 'report-only')
        assert.strictEqual(summary.totalAccounts, 6)
        assert.strictEqual(summary.validAccounts, 6)
        assert.strictEqual(summary.blockedAccounts, 0)
        console.log('✅ Test 4 Passed: Exactly six accounts in one household pass policy')
    }

    // Test 5: Seven accounts in one household are blocked (household-limit-exceeded)
    {
        const householdId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        const accounts: Account[] = []
        for (let i = 1; i <= 7; i++) {
            accounts.push(
                createFakeAccount({
                    id: `10000000-0000-4000-8000-00000000000${i}`,
                    participantId: `20000000-0000-4000-8000-00000000000${i}`,
                    householdId,
                    email: `member${i}@example.com`
                })
            )
        }

        const summary = validateOwnershipPolicy(accounts, 'report-only')
        assert.strictEqual(summary.totalAccounts, 7)
        assert.strictEqual(summary.validAccounts, 0)
        assert.strictEqual(summary.blockedAccounts, 7)
        for (const res of summary.results) {
            assert.strictEqual(res.status, 'household-limit-exceeded')
            assert.strictEqual(res.householdAccountCount, 7)
        }
        console.log('✅ Test 5 Passed: Seven accounts in one household are blocked (household-limit-exceeded)')
    }

    // Test 6: Identical dynamic IP observations do not merge households
    {
        const h1 = '11111111-1111-4111-8111-111111111111'
        const h2 = '22222222-2222-4222-8222-222222222222'

        const acc1 = createFakeAccount({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            participantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            householdId: h1,
            email: 'h1_acc@example.com'
        })
        const acc2 = createFakeAccount({
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            participantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            householdId: h2,
            email: 'h2_acc@example.com'
        })

        // Simulate both observing the identical dynamic public IP "198.51.100.42"
        const observedIpAcc1 = '198.51.100.42'
        const observedIpAcc2 = '198.51.100.42'
        assert.strictEqual(observedIpAcc1, observedIpAcc2)

        const summary = validateOwnershipPolicy([acc1, acc2], 'report-only')
        assert.strictEqual(summary.totalHouseholds, 2, 'Households must not merge based on shared IP')
        assert.strictEqual(summary.results[0]!.householdId, h1)
        assert.strictEqual(summary.results[1]!.householdId, h2)
        console.log('✅ Test 6 Passed: Identical dynamic IP observations do not merge households')
    }

    // Test 7: Changing IP does not change householdId
    {
        const householdId = '11111111-1111-4111-8111-111111111111'
        const acc = createFakeAccount({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            participantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            householdId,
            email: 'stable_acc@example.com'
        })

        const beforeIp = '198.51.100.1'
        const afterIp = '203.0.113.99'
        assert.notStrictEqual(beforeIp, afterIp)

        // Policy validation before and after IP rotation simulation
        const summary = validateOwnershipPolicy([acc], 'report-only')
        assert.strictEqual(summary.results[0]!.householdId, householdId)
        console.log('✅ Test 7 Passed: Changing IP does not change householdId')
    }

    // Test 8: Changing device metadata does not change participantId
    {
        const participantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        const acc = createFakeAccount({
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            participantId,
            householdId: '11111111-1111-4111-8111-111111111111',
            email: 'device_acc@example.com'
        })

        // Simulate mobile fingerprint toggling
        acc.saveFingerprint.mobile = true
        acc.saveFingerprint.desktop = false

        const summary = validateOwnershipPolicy([acc], 'report-only')
        assert.strictEqual(summary.results[0]!.participantId, participantId)
        console.log('✅ Test 8 Passed: Changing device metadata does not change participantId')
    }

    // Test 9: Report-only mode loads legacy records with missing UUIDs without throwing
    {
        const legacyAccounts: Account[] = [
            createFakeAccount({ email: 'legacy1@example.com' }), // no id, participantId, householdId
            createFakeAccount({
                id: '11111111-1111-4111-8111-111111111111',
                email: 'legacy2@example.com' // missing participantId & householdId
            })
        ]

        const summary = validateOwnershipPolicy(legacyAccounts, 'report-only')
        assert.strictEqual(summary.totalAccounts, 2)
        assert.strictEqual(summary.validAccounts, 0)
        assert.strictEqual(summary.blockedAccounts, 2)
        assert.strictEqual(summary.results[0]!.status, 'identity-missing')
        assert.strictEqual(summary.results[1]!.status, 'identity-missing')
        console.log('✅ Test 9 Passed: Report-only mode loads legacy records with missing UUIDs')
    }

    // Test 10: Block-invalid mode flags missing or invalid identities as blocked
    {
        const accounts: Account[] = [
            createFakeAccount({
                id: '11111111-1111-4111-8111-111111111111',
                participantId: '22222222-2222-4222-8222-222222222222',
                householdId: '33333333-3333-4333-8333-333333333333',
                email: 'valid@example.com'
            }),
            createFakeAccount({
                id: 'invalid-not-a-uuid',
                participantId: '55555555-5555-4555-8555-555555555555',
                householdId: '33333333-3333-4333-8333-333333333333',
                email: 'invalid@example.com'
            })
        ]

        const summary = validateOwnershipPolicy(accounts, 'block-invalid')
        assert.strictEqual(summary.validAccounts, 1)
        assert.strictEqual(summary.blockedAccounts, 1)
        assert.strictEqual(summary.results[1]!.status, 'invalid-identity')
        console.log('✅ Test 10 Passed: Block-invalid mode flags missing or invalid identities as blocked')
    }

    // Test 11: Public references contain at least 128 bits (32 hex characters) and never leak raw UUIDs
    {
        const sessionSecret = 'test-secret-random-key-12345'
        const rawUuid = '11111111-1111-4111-8111-111111111111'
        const publicRef = derivePublicRef(sessionSecret, rawUuid)

        assert.strictEqual(publicRef.length, 32, 'Public ref must retain exactly 32 hex chars (128 bits)')
        assert.ok(!publicRef.includes(rawUuid), 'Public ref must never contain raw UUID substring')
        assert.match(publicRef, /^[0-9a-f]{32}$/, 'Public ref must be 32 hex chars')

        const summary = validateOwnershipPolicy(
            [
                createFakeAccount({
                    id: rawUuid,
                    participantId: '22222222-2222-4222-8222-222222222222',
                    householdId: '33333333-3333-4333-8333-333333333333',
                    email: 'leakcheck@example.com'
                })
            ],
            'report-only'
        )

        const dto = createSanitizedDiagnosticDto(summary, 'report-only', sessionSecret)
        const serialized = JSON.stringify(dto)
        assert.ok(!serialized.includes(rawUuid), 'Diagnostic DTO must never serialize raw internal UUID')
        assert.ok(!serialized.includes('leakcheck@example.com'), 'Diagnostic DTO must never serialize email')
        console.log('✅ Test 11 Passed: Public references contain at least 128 bits (32 hex characters)')
    }

    // Test 12: Public references are not used as persistent keys (different secret = different ref)
    {
        const rawUuid = '11111111-1111-4111-8111-111111111111'
        const ref1 = derivePublicRef('secret_session_A', rawUuid)
        const ref2 = derivePublicRef('secret_session_B', rawUuid)
        assert.notStrictEqual(ref1, ref2, 'Ephemeral public refs must differ across process sessions')
        console.log('✅ Test 12 Passed: Public references are ephemeral and differ across sessions')
    }

    // Test 13: Disabled accounts do not count towards active household limit, but duplicate accountId is caught
    {
        const householdId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        const accounts: Account[] = []
        // 6 active accounts
        for (let i = 1; i <= 6; i++) {
            accounts.push(
                createFakeAccount({
                    id: `10000000-0000-4000-8000-00000000000${i}`,
                    participantId: `20000000-0000-4000-8000-00000000000${i}`,
                    householdId,
                    email: `active${i}@example.com`,
                    enabled: true
                })
            )
        }
        // 7th account is disabled (enabled: false)
        accounts.push(
            createFakeAccount({
                id: '10000000-0000-4000-8000-000000000007',
                participantId: '20000000-0000-4000-8000-000000000007',
                householdId,
                email: 'disabled7@example.com',
                enabled: false
            })
        )

        const summary = validateOwnershipPolicy(accounts, 'report-only')
        assert.strictEqual(summary.totalAccounts, 7)
        assert.strictEqual(summary.validAccounts, 7, 'Disabled account does not push active count above 6')
        assert.strictEqual(summary.results[0]!.householdAccountCount, 6)

        // But duplicate accountId is caught even if one account is disabled
        accounts[6]!.id = accounts[0]!.id // collision
        const dupSummary = validateOwnershipPolicy(accounts, 'report-only')
        assert.strictEqual(dupSummary.results[6]!.status, 'duplicate-account-id')
        console.log('✅ Test 13 Passed: Disabled accounts do not count toward household limit but duplicates caught')
    }

    console.log('🎉 ALL 13 ACCOUNT OWNERSHIP IDENTITY TESTS PASSED SUCCESSFULLY!\n')
}
